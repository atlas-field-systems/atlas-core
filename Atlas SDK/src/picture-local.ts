import type { Change } from '@atlas/protocol';
import type { PictureRead, PictureStatus } from './contracts.js';
import { SdkError } from './contracts.js';
import type { Session } from './connection.js';
import type { DiagnosticCode } from './diagnostics.js';
import { PictureData, PictureMemory, retainedBytes } from './picture-data.js';

export type LocalPictureStatus = PictureStatus & Readonly<{ reason: DiagnosticCode | null }>;
export type PictureRefusal = Readonly<{
  kind: 'refused';
  code: 'capacity' | 'invalid_token' | 'expired_token';
  status: LocalPictureStatus;
}>;
export type PicturePage<T> = Readonly<{
  items: readonly T[];
  cursor: string;
  coreCursor: string;
  capturedAt: string;
  nextPageToken: string | null;
}>;
export type FrozenQuery<T> = Readonly<{
  page: (token?: string) => PictureRead<PicturePage<T>> | PictureRefusal;
  close: () => void;
}>;
export type LocalCommit = Readonly<{
  cursor: string;
  coreCursor: string;
  changes: readonly Change[];
}>;
export type PictureGap = Readonly<{
  kind: 'gap';
  reason: 'pruned' | 'invalid_cursor' | 'capacity';
  status: LocalPictureStatus;
}>;
export type PictureEvent =
  | Readonly<{ kind: 'status'; status: LocalPictureStatus }>
  | Readonly<{ kind: 'commit'; commit: LocalCommit; stale: boolean; status: LocalPictureStatus }>
  | PictureGap;
export type PictureSubscription = AsyncIterableIterator<PictureEvent> &
  Readonly<{ close: () => void }>;
type QueryOwner = { expires: number; release: () => void };
type Subscriber = {
  generation: number;
  position: number;
  revision: number;
  ended: boolean;
  gap: PictureGap['reason'] | undefined;
  pending: ((value: IteratorResult<PictureEvent>) => void) | undefined;
};
type JournalEntry = { position: number; bytes: number; commit: LocalCommit };

export class PictureLocal {
  readonly #instance = crypto.randomUUID();
  readonly #journal: JournalEntry[] = [];
  readonly #queries = new Set<QueryOwner>();
  readonly #subscribers = new Set<Subscriber>();
  #queryTimer: ReturnType<typeof setTimeout> | undefined;
  #journalBytes = 0;
  #position = 0;
  #floor = 0;
  #revision = 0;
  #status: LocalPictureStatus = Object.freeze({
    kind: 'initializing',
    datasetId: null,
    generation: 0,
    cursor: null,
    synchronizedAt: null,
    reason: null,
  });
  data: PictureData | undefined;
  constructor(
    readonly session: Session,
    readonly memory: PictureMemory,
  ) {}
  get status(): LocalPictureStatus {
    return this.#status;
  }
  get cursor(): string {
    return `${this.#instance}/${this.#status.datasetId}/${this.#status.generation}/${this.#position}`;
  }
  state(
    kind: PictureStatus['kind'],
    reason: DiagnosticCode | null = null,
    datasetId = this.#status.datasetId,
  ): void {
    this.#status = Object.freeze({ ...this.#status, kind, reason, datasetId });
    this.#revision++;
    this.#notify();
  }
  #record(stale: boolean, available: boolean, started: number): void {
    if (this.session.diagnosticsEnabled)
      this.session.emit({
        kind: 'request',
        operation: 'picture',
        source: 'picture',
        phase: 'read',
        outcome: available ? 'success' : 'not_sent',
        stale,
        elapsedMs: performance.now() - started,
        generation: this.#status.generation,
        ...(this.#status.datasetId === null ? {} : { datasetId: this.#status.datasetId }),
      });
  }
  read<T>(get: (data: PictureData) => T): PictureRead<T> {
    const started = performance.now();
    this.expire();
    const data = this.data;
    const stale = this.#status.kind !== 'synchronized';
    this.#record(stale, data !== undefined, started);
    return data === undefined
      ? { kind: 'unavailable', status: this.#status }
      : { kind: 'available', value: get(data), stale, status: this.#status };
  }
  publish(data: PictureData, coreCursor: string): void {
    this.data = data;
    this.#status = Object.freeze({
      ...this.#status,
      cursor: coreCursor,
      synchronizedAt: new Date().toISOString(),
    });
    this.state('synchronized');
  }
  progress(coreCursor: string): void {
    this.#status = Object.freeze({
      ...this.#status,
      cursor: coreCursor,
      synchronizedAt: new Date().toISOString(),
    });
  }
  apply(changes: readonly Change[], coreCursor: string): void {
    const data = this.data;
    if (!data) throw new SdkError('not_connected');
    this.expire();
    const bytes = retainedBytes(changes) + 1024;
    if (bytes > this.memory.limits.journalBytes) throw new SdkError('capacity');
    while (
      this.#journal.length >= this.memory.limits.journalCommits ||
      this.#journalBytes + bytes > this.memory.limits.journalBytes
    ) {
      const first = this.#journal.shift();
      if (!first) break;
      this.#floor = first.position;
      this.#journalBytes -= first.bytes;
      this.memory.release(first.bytes);
    }
    // Reserve the complete resource change and retained journal before touching any map.
    data.apply(changes, bytes);
    this.#position++;
    this.#journalBytes += bytes;
    const commit = Object.freeze({
      cursor: this.cursor,
      coreCursor,
      changes: Object.freeze(changes),
    });
    this.#journal.push({ position: this.#position, bytes, commit });
    this.progress(coreCursor);
    this.#notify();
  }
  invalidate(
    kind: PictureStatus['kind'],
    reason: DiagnosticCode | null,
    datasetId = this.#status.datasetId,
  ): void {
    this.data?.clear();
    this.data = undefined;
    for (const owner of this.#queries) owner.release();
    this.#queries.clear();
    clearTimeout(this.#queryTimer);
    this.memory.release(this.#journalBytes);
    this.#journal.length = 0;
    this.#journalBytes = 0;
    this.#floor = this.#position = 0;
    this.#status = Object.freeze({
      ...this.#status,
      generation: this.#status.generation + 1,
      cursor: null,
      synchronizedAt: null,
    });
    if (reason === 'capacity')
      for (const subscriber of this.#subscribers) subscriber.gap = 'capacity';
    this.state(kind, reason, datasetId);
    if (kind === 'stopped') {
      for (const subscriber of this.#subscribers) this.#endSubscriber(subscriber);
    }
  }
  query<T>(
    images: ReadonlyMap<string, T>,
    matches: (image: T) => boolean,
    pageSize: number,
  ): PictureRead<FrozenQuery<T>> | PictureRefusal {
    this.expire();
    if (!this.data || this.#status.cursor === null)
      return { kind: 'unavailable', status: this.#status };
    if (this.#queries.size >= this.memory.limits.queries) return this.#refuse('capacity');
    let bytes = 1024,
      count = 0;
    for (const image of images.values())
      if (matches(image)) {
        bytes += retainedBytes(image) + 256;
        count++;
      }
    try {
      this.memory.take(bytes, count);
    } catch {
      return this.#refuse('capacity');
    }
    // The first pass charges sorting, retained references, page copies and the query owner.
    const selected: [string, T][] = [];
    for (const [id, image] of images) if (matches(image)) selected.push([id, image]);
    selected.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const generation = this.#status.generation;
    const id = crypto.randomUUID();
    const cursor = this.cursor,
      coreCursor = this.#status.cursor,
      capturedAt = new Date().toISOString();
    let invalid: 'invalid_token' | 'expired_token' | undefined;
    const owner: QueryOwner = {
      expires: performance.now() + this.memory.limits.queryLifetimeMs,
      release: () => {
        if (invalid) return;
        invalid = performance.now() >= owner.expires ? 'expired_token' : 'invalid_token';
        selected.length = 0;
        this.memory.release(bytes, count);
        this.#queries.delete(owner);
      },
    };
    this.#queries.add(owner);
    this.#scheduleExpiry();
    const query: FrozenQuery<T> = Object.freeze({
      page: (token?: string) => {
        this.expire();
        if (invalid) return this.#refuse(invalid);
        if (generation !== this.#status.generation || !this.data)
          return this.#refuse('invalid_token');
        let offset = 0;
        if (token !== undefined) {
          if (typeof token !== 'string' || token.length > 100 || !token.startsWith(`${id}/`))
            return this.#refuse('invalid_token');
          const suffix = token.slice(id.length + 1);
          if (!/^(0|[1-9][0-9]*)$/.test(suffix)) return this.#refuse('invalid_token');
          offset = Number(suffix);
          if (!Number.isSafeInteger(offset) || offset >= selected.length || offset % pageSize !== 0)
            return this.#refuse('invalid_token');
        }
        const items = Object.freeze(
          selected.slice(offset, offset + pageSize).map(([, image]) => image),
        );
        return this.read(() =>
          Object.freeze({
            items,
            cursor,
            coreCursor,
            capturedAt,
            nextPageToken:
              offset + pageSize < selected.length ? `${id}/${offset + pageSize}` : null,
          }),
        );
      },
      close: () => {
        owner.release();
        this.#scheduleExpiry();
      },
    });
    return this.read(() => query);
  }
  #refuse(code: PictureRefusal['code']): PictureRefusal {
    if (this.session.diagnosticsEnabled)
      this.session.emit({
        kind: 'request',
        operation: 'picture',
        source: 'picture',
        phase: 'read',
        outcome: 'not_sent',
        elapsedMs: 0,
        stale: this.#status.kind !== 'synchronized',
        code: code === 'capacity' ? 'capacity' : 'invalid_value',
        generation: this.#status.generation,
      });
    return { kind: 'refused', code, status: this.#status };
  }
  queryInput<T>(parse: () => T): T | PictureRefusal {
    this.expire();
    let release: () => void;
    try {
      release = this.memory.reserveDecode(this.session.requestBudget);
    } catch {
      return this.#refuse('capacity');
    }
    try {
      return parse();
    } finally {
      release();
    }
  }
  expire(): void {
    const now = performance.now();
    for (const owner of this.#queries) if (owner.expires <= now) owner.release();
  }
  #scheduleExpiry(): void {
    clearTimeout(this.#queryTimer);
    let earliest = Infinity;
    for (const owner of this.#queries) earliest = Math.min(earliest, owner.expires);
    if (Number.isFinite(earliest))
      this.#queryTimer = setTimeout(
        () => {
          this.expire();
          this.#scheduleExpiry();
        },
        Math.max(0, earliest - performance.now()),
      );
  }
  #parseCursor(cursor: string): number | undefined {
    const prefix = `${this.#instance}/${this.#status.datasetId}/${this.#status.generation}/`;
    if (typeof cursor !== 'string' || cursor.length > 200 || !cursor.startsWith(prefix))
      return undefined;
    const tail = cursor.slice(prefix.length);
    if (!/^(0|[1-9][0-9]*)$/.test(tail)) return undefined;
    const value = Number(tail);
    return Number.isSafeInteger(value) && value <= this.#position ? value : undefined;
  }
  changedSince(
    cursor: string,
    limit = 100,
  ):
    | PictureRead<Readonly<{ commits: readonly LocalCommit[]; cursor: string; hasMore: boolean }>>
    | PictureGap
    | PictureRefusal {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new SdkError('invalid_options');
    const position = this.#parseCursor(cursor);
    if (position === undefined || position < this.#floor)
      return {
        kind: 'gap',
        reason: position === undefined ? 'invalid_cursor' : 'pruned',
        status: this.#status,
      };
    const bytes = 256 + limit * 64;
    try {
      this.memory.take(bytes);
    } catch {
      return this.#refuse('capacity');
    }
    try {
      return this.read(() => {
        const commits: LocalCommit[] = [];
        for (const entry of this.#journal)
          if (entry.position > position && commits.length < limit) commits.push(entry.commit);
        const last = commits.at(-1);
        return Object.freeze({
          commits: Object.freeze(commits),
          cursor: last?.cursor ?? cursor,
          hasMore: position + commits.length < this.#position,
        });
      });
    } finally {
      this.memory.release(bytes);
    }
  }
  subscribe(cursor?: string): PictureSubscription {
    if (this.#status.kind === 'stopped') throw new SdkError('closed');
    if (this.#subscribers.size >= this.memory.limits.subscribers) throw new SdkError('capacity');
    const position = cursor === undefined ? this.#position : this.#parseCursor(cursor);
    this.memory.take(1024);
    const subscriber: Subscriber = {
      generation: this.#status.generation,
      position: position ?? 0,
      revision: -1,
      ended: false,
      gap:
        position === undefined ? 'invalid_cursor' : position < this.#floor ? 'pruned' : undefined,
      pending: undefined,
    };
    this.#subscribers.add(subscriber);
    const iterator: PictureSubscription = {
      [Symbol.asyncIterator]() {
        return iterator;
      },
      next: () => {
        if (subscriber.pending) return Promise.reject(new SdkError('invalid_options'));
        const value = this.#next(subscriber);
        return value
          ? Promise.resolve(value)
          : new Promise((resolve) => {
              subscriber.pending = resolve;
            });
      },
      return: () => {
        this.#endSubscriber(subscriber);
        return Promise.resolve({ done: true, value: undefined });
      },
      close: () => this.#endSubscriber(subscriber),
    };
    return Object.freeze(iterator);
  }
  #next(subscriber: Subscriber): IteratorResult<PictureEvent> | undefined {
    if (subscriber.ended) return { done: true, value: undefined };
    if (subscriber.gap) {
      const reason = subscriber.gap;
      this.#endSubscriber(subscriber);
      return { done: false, value: { kind: 'gap', reason, status: this.#status } };
    }
    if (subscriber.generation !== this.#status.generation) {
      subscriber.generation = this.#status.generation;
      subscriber.position = 0;
    }
    if (subscriber.revision !== this.#revision) {
      subscriber.revision = this.#revision;
      return { done: false, value: { kind: 'status', status: this.#status } };
    }
    if (subscriber.position < this.#floor) {
      subscriber.gap = 'pruned';
      return this.#next(subscriber);
    }
    const entry = this.#journal.find((entry) => entry.position > subscriber.position);
    if (!entry) return undefined;
    subscriber.position = entry.position;
    return {
      done: false,
      value: {
        kind: 'commit',
        commit: entry.commit,
        status: this.#status,
        stale: this.#status.kind !== 'synchronized',
      },
    };
  }
  #endSubscriber(subscriber: Subscriber): void {
    if (subscriber.ended) return;
    subscriber.ended = true;
    this.#subscribers.delete(subscriber);
    this.memory.release(1024);
    const pending = subscriber.pending;
    subscriber.pending = undefined;
    pending?.({ done: true, value: undefined });
  }
  #notify(): void {
    for (const subscriber of this.#subscribers) {
      const pending = subscriber.pending;
      if (!pending) continue;
      subscriber.pending = undefined;
      const value = this.#next(subscriber);
      if (value) pending(value);
      else subscriber.pending = pending;
    }
  }
}
