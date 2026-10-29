import { NewId, exchanges } from '@atlas/protocol';
import type { NegotiatedLimits, RequestOf, SnapshotPage } from '@atlas/protocol';
import type { ConnectionState, PictureStatus } from './contracts.js';
import { SdkError } from './contracts.js';
import type { Session, SocketLease } from './connection.js';
import type { DiagnosticCode, DiagnosticReason } from './diagnostics.js';
import { failureCode, submission } from './http.js';
import { PictureData, PictureMemory, pictureLimits, retainedBytes } from './picture-data.js';
import type { PictureLimits } from './picture-data.js';
import { PictureLocal } from './picture-local.js';
import { pictureReads } from './picture-reads.js';
import { feedSocket } from './socket.js';
import type { FeedConnection, FeedFrame } from './socket.js';

type Capture = {
  datasetId: string;
  coreRunId: string;
  earliest: number;
  latest: number;
  request: Exclude<RequestOf<'ReadSnapshot'>, { page_token: string }>;
  context: Omit<SnapshotPage, 'items'> | undefined;
  lastKey: string;
  bytes: number;
  contextBytes: number;
  staging: PictureData | undefined;
};
type Complete = { data: PictureData; cursor: string; published: boolean };
class Recovery extends Error {
  constructor(
    readonly action: 'transport' | 'rebuild' | 'capacity',
    readonly code: DiagnosticCode,
    readonly reason: DiagnosticReason,
  ) {
    super(code);
  }
}

export class Picture {
  readonly #session: Session;
  readonly #memory: PictureMemory;
  readonly #local: PictureLocal;
  readonly reads: ReturnType<typeof pictureReads>;
  readonly #unobserve: () => void;
  #capture: Capture | undefined;
  #complete: Complete | undefined;
  #job: Promise<void> | undefined;
  #lease: SocketLease | undefined;
  #socket: FeedConnection | undefined;
  #cancelDelay: (() => void) | undefined;
  #closed = false;
  #limited = false;
  #failures = 0;
  #closing: Promise<void> | undefined;
  #cleanupFailure: unknown;
  readonly #seen = new Map<string, Readonly<{ fingerprint: string; bytes: number }>>();
  #seenBytes = 0;

  constructor(session: Session, limits: PictureLimits = {}) {
    this.#session = session;
    this.#memory = new PictureMemory(pictureLimits(limits));
    this.#local = new PictureLocal(session, this.#memory);
    this.reads = pictureReads(this.#local, session);
    this.#unobserve = session.observe((state) => this.#observe(state));
    this.#observe(session.state);
  }
  get status() {
    return this.#local.status;
  }
  get cursor(): string {
    return this.#local.cursor;
  }
  changedSince(cursor: string, limit?: number) {
    return this.#local.changedSince(cursor, limit);
  }
  subscribe(cursor?: string) {
    return this.#local.subscribe(cursor);
  }
  retry(limits?: PictureLimits): void {
    if (this.#closed) throw new SdkError('closed');
    if (!this.#limited) {
      if (limits !== undefined) throw new SdkError('invalid_options');
      return;
    }
    if (limits !== undefined)
      this.#memory.limits = pictureLimits({ ...this.#memory.limits, ...limits });
    this.#limited = false;
    this.#failures = 0;
    this.#local.state('recovering');
    this.#diagnostic('rebuild', 'capacity_change');
    this.#start();
  }
  #diagnostic(
    phase: 'capture' | 'page' | 'handoff' | 'apply' | 'rebuild' | 'capacity' | 'reuse',
    reason?: DiagnosticReason,
    elapsedMs?: number,
  ): void {
    if (!this.#session.diagnosticsEnabled) return;
    this.#session.emit({
      kind: 'synchronization',
      phase,
      generation: this.status.generation,
      ...(this.status.datasetId === null ? {} : { datasetId: this.status.datasetId }),
      ...(this.#complete === undefined ? {} : { cursor: this.#complete.cursor }),
      ...(this.#capture === undefined ? {} : { loadId: this.#capture.request.load_id }),
      ...(reason === undefined ? {} : { reason }),
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
      ...(phase === 'apply' ? { receivedCommits: 1, appliedCommits: 1 } : {}),
      ...(phase === 'page' ? { pages: 1 } : {}),
    });
  }
  #discardCapture(): void {
    this.#capture?.staging?.clear();
    if (this.#capture) this.#memory.release(this.#capture.bytes + this.#capture.contextBytes);
    this.#capture = undefined;
  }
  #invalidate(
    kind: PictureStatus['kind'],
    code: DiagnosticCode | null,
    datasetId = this.status.datasetId,
  ): void {
    if (this.#complete && !this.#complete.published) this.#complete.data.clear();
    this.#complete = undefined;
    this.#capture?.staging?.clear();
    if (this.#capture) this.#capture.staging = undefined;
    this.#memory.release(this.#seenBytes);
    this.#seenBytes = 0;
    this.#seen.clear();
    this.#local.invalidate(kind, code, datasetId);
  }
  #observe(state: ConnectionState): void {
    if (this.#closed) return;
    if (state.kind === 'ready') {
      if (this.status.datasetId !== state.datasetId) {
        const initial = this.status.datasetId === null;
        this.#invalidate(
          initial ? 'initializing' : 'recovering',
          initial ? null : 'dataset_invalidated',
          state.datasetId,
        );
        this.#discardCapture();
        this.#limited = false;
        if (!initial) this.#diagnostic('rebuild', 'dataset_change');
      }
      if (this.#capture && this.#capture.coreRunId !== state.health.core_run_id)
        this.#discardCapture();
      if (this.#limited) this.#local.state('resource-limited', 'capacity');
      else if (this.status.kind === 'authorization-required') this.#local.state('recovering');
      this.#start();
    } else if (state.kind === 'authorization-required') {
      this.#capture?.staging?.clear();
      if (this.#capture) this.#capture.staging = undefined;
      this.#local.state('authorization-required', 'authorization_required');
    } else if (state.kind === 'closed') {
      this.#closed = true;
      this.#invalidate('stopped', 'closed');
    } else if (state.kind === 'blocked') {
      if (state.reason === 'dataset_invalidated') {
        this.#invalidate('recovering', state.reason);
        this.#discardCapture();
      } else this.#local.state('disconnected', state.reason);
    }
  }
  #start(): void {
    if (
      this.#closed ||
      this.#limited ||
      this.#job ||
      this.#socket ||
      this.#session.state.kind !== 'ready'
    )
      return;
    let failed = false;
    this.#job = Promise.resolve()
      .then(() => this.#run())
      .catch((error: unknown) => {
        if (error instanceof SdkError && error.code === 'capacity') {
          this.#limited = true;
          this.#invalidate('resource-limited', 'capacity');
          this.#diagnostic('capacity', 'capacity');
          return;
        }
        failed = true;
        this.#cleanupFailure ??= error;
        if (!this.#closed && this.#session.state.kind === 'ready')
          this.#local.state('disconnected', failureCode(error));
      })
      .finally(() => {
        this.#job = undefined;
        const socket = this.#socket;
        if (socket) {
          void socket.closed.then(() => {
            if (this.#socket === socket) this.#socket = undefined;
            this.#start();
          });
        } else if (!failed) this.#start();
      });
  }
  async #delay(ms: number, lease: SocketLease): Promise<void> {
    if (!lease.current()) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.#cancelDelay = undefined;
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, ms));
      this.#cancelDelay = finish;
      if (!lease.current()) finish();
    });
  }
  async #run(): Promise<void> {
    const lease = this.#session.ownSocket(async () => {
      this.#cancelDelay?.();
      const socket = this.#socket;
      await socket?.close();
      if (this.#socket === socket) this.#socket = undefined;
    });
    this.#lease = lease;
    try {
      while (lease.current() && !this.#closed && !this.#limited) {
        try {
          if (this.#failures > 0) {
            const backoff = Math.min(30_000, 250 * 2 ** Math.min(this.#failures - 1, 7));
            if (this.#session.diagnosticsEnabled)
              this.#session.emit({
                kind: 'connection',
                state: 'reconnecting',
                generation: lease.generation,
                datasetId: lease.datasetId,
                socketId: lease.attemptId,
                backoffMs: backoff,
              });
            await this.#delay(backoff, lease);
            if (!lease.current()) break;
            const result = await this.#session.refreshHealth();
            if (!lease.current()) break;
            if (result.kind !== 'response' || result.response.kind !== 'success')
              throw new Recovery('transport', 'network', 'transport');
          }
          await this.#synchronize(lease);
        } catch (error) {
          if (!lease.current() || this.#closed) break;
          const failure =
            error instanceof Recovery
              ? error
              : new Recovery(
                  failureCode(error) === 'capacity' ? 'capacity' : 'rebuild',
                  failureCode(error),
                  'invalid_input',
                );
          this.#failures++;
          if (failure.action === 'capacity') {
            this.#limited = true;
            if (this.status.kind !== 'resource-limited')
              this.#invalidate('resource-limited', 'capacity');
            this.#diagnostic('capacity', 'capacity');
            await this.#releaseCapture();
          } else if (failure.action === 'rebuild') {
            if (
              this.#complete ||
              this.#capture?.staging ||
              this.status.kind !== 'recovering' ||
              this.status.reason !== failure.code
            )
              this.#invalidate('recovering', failure.code);
            this.#diagnostic('rebuild', failure.reason);
          } else this.#local.state('disconnected', failure.code);
        } finally {
          const socket = this.#socket;
          if (socket) {
            await new Promise<void>((resolve) => {
              const finish = () => {
                lease.signal.removeEventListener('abort', finish);
                resolve();
              };
              void socket.closed.then(finish);
              lease.signal.addEventListener('abort', finish, { once: true });
              if (!lease.current()) finish();
            });
            if (lease.current()) {
              await socket.close();
              this.#socket = undefined;
            }
          }
        }
      }
    } finally {
      await lease.release();
      if (this.#lease === lease) this.#lease = undefined;
    }
  }
  #limits(): NegotiatedLimits {
    const budget = this.#session.responseBudget;
    return {
      max_message_bytes: budget.maxBytes,
      max_changes: budget.maxChanges,
      max_json_values: budget.maxValues,
    };
  }
  async #releaseCapture(): Promise<void> {
    const capture = this.#capture;
    if (!capture) return;
    const state = this.#session.state;
    if (
      performance.now() >= capture.latest ||
      (state.kind === 'ready' &&
        (state.datasetId !== capture.datasetId || state.health.core_run_id !== capture.coreRunId))
    ) {
      this.#discardCapture();
      return;
    }
    if (state.kind !== 'ready' || !capture.context) return;
    const request = submission(
      exchanges.ReleaseSnapshot,
      { release_token: capture.context.release_token },
      this.#session.requestBudget,
    );
    const result = await this.#session.start(exchanges.ReleaseSnapshot, request, {
      datasetId: capture.datasetId,
      coreRunId: capture.coreRunId,
      timeoutMs: Math.min(1000, this.#session.timeoutMs),
    }).settled;
    if (this.#capture !== capture) return;
    if (
      result.kind === 'response' &&
      (result.response.kind === 'success' ||
        result.response.body.error.code === 'allocation_expired')
    )
      this.#discardCapture();
  }
  async #newCapture(lease: SocketLease): Promise<void> {
    const sent = performance.now();
    const result = await this.#session.refreshHealth();
    const received = performance.now();
    if (!lease.current()) return;
    if (result.kind !== 'response' || result.response.kind !== 'success')
      throw new Recovery('transport', 'network', 'transport');
    if (sent + 60_000 <= received)
      throw new Recovery('rebuild', 'allocation_expired', 'expired_capture');
    const health = result.response.body.data;
    const request = {
      allocation_context: health.allocation_context,
      load_id: NewId.parse(crypto.randomUUID()),
      page_size: this.#memory.limits.pageSize,
      ...this.#limits(),
    };
    const bytes = retainedBytes(request) + 1024;
    this.#memory.take(bytes);
    this.#capture = {
      datasetId: lease.datasetId,
      coreRunId: health.core_run_id,
      earliest: sent + 60_000,
      latest: received + 60_000,
      request,
      bytes,
      contextBytes: 0,
      context: undefined,
      lastKey: '',
      staging: new PictureData(this.#memory),
    };
    this.#diagnostic('capture');
  }
  async #synchronize(lease: SocketLease): Promise<void> {
    if (!this.#complete) {
      if (
        this.#capture &&
        (this.#capture.staging === undefined || performance.now() >= this.#capture.earliest)
      ) {
        await this.#releaseCapture();
        if (!lease.current()) return;
        if (this.#capture) await this.#delay(this.#capture.latest - performance.now(), lease);
        if (!lease.current()) return;
        this.#discardCapture();
        throw new Recovery('rebuild', 'allocation_expired', 'expired_capture');
      }
      if (!this.#capture) await this.#newCapture(lease);
      if (!lease.current()) return;
      const capture = this.#capture;
      if (!capture?.staging) return;
      while (lease.current() && capture === this.#capture) {
        if (performance.now() >= capture.earliest)
          throw new Recovery('rebuild', 'allocation_expired', 'expired_capture');
        const facts = submission(
          exchanges.ReadSnapshot,
          capture.context?.next_page_token
            ? { page_token: capture.context.next_page_token }
            : capture.request,
          this.#session.requestBudget,
        );
        this.#local.expire();
        const release = this.#memory.reserveDecode(this.#session.responseBudget);
        const started = performance.now();
        try {
          const result = await this.#session.start(exchanges.ReadSnapshot, facts, {
            datasetId: capture.datasetId,
            coreRunId: capture.coreRunId,
          }).settled;
          if (!lease.current() || capture !== this.#capture) return;
          if (result.kind !== 'response') throw new Recovery('transport', result.code, 'transport');
          if (result.response.kind === 'error') {
            const code = result.response.body.error.code;
            if (code === 'allocation_expired') {
              this.#discardCapture();
              throw new Recovery('rebuild', code, 'expired_capture');
            }
            throw new Recovery(
              code === 'resource_limit' || code === 'payload_too_large' ? 'capacity' : 'transport',
              code,
              'transport',
            );
          }
          const page = result.response.body.data;
          const old = capture.context;
          if (
            page.load_id !== capture.request.load_id ||
            (old &&
              (page.capture_id !== old.capture_id ||
                page.baseline_cursor !== old.baseline_cursor ||
                page.expires_at !== old.expires_at ||
                page.release_token !== old.release_token ||
                page.limits.max_changes !== old.limits.max_changes ||
                page.limits.max_json_values !== old.limits.max_json_values ||
                page.limits.max_message_bytes !== old.limits.max_message_bytes ||
                (page.next_page_token !== null && page.next_page_token === old.next_page_token)))
          )
            throw new SdkError('invalid_value');
          const first = page.items[0];
          if (
            (first && `${first.resource_kind}:${first.resource_id}` <= capture.lastKey) ||
            (page.items.length === 0 && page.next_page_token !== null)
          )
            throw new SdkError('invalid_value');
          capture.staging.apply(page.items);
          const last = page.items.at(-1);
          if (last) capture.lastKey = `${last.resource_kind}:${last.resource_id}`;
          const { items: _items, ...context } = page;
          const contextBytes = retainedBytes(context) + 512;
          this.#memory.take(contextBytes);
          this.#memory.release(capture.contextBytes);
          capture.contextBytes = contextBytes;
          capture.context = context;
          this.#diagnostic('page', undefined, performance.now() - started);
          if (page.next_page_token === null) {
            this.#complete = {
              data: capture.staging,
              cursor: page.baseline_cursor,
              published: false,
            };
            capture.staging = undefined;
            this.#remember(page.baseline_cursor, 'baseline');
            break;
          }
        } finally {
          release();
        }
      }
      if (!lease.current()) return;
      await this.#releaseCapture();
    } else this.#diagnostic('reuse');
    if (!lease.current()) return;
    const complete = this.#complete;
    if (!complete) return;
    this.#local.state('recovering');
    this.#socket = feedSocket(
      this.#session,
      lease,
      this.#memory,
      complete.cursor,
      this.#limits(),
      (frame, handoff, fingerprint) => this.#frame(complete, frame, handoff, fingerprint),
      (end) => {
        if (end.kind === 'capacity') {
          this.#limited = true;
          this.#invalidate('resource-limited', 'capacity');
        } else if (end.kind === 'rebuild') this.#invalidate('recovering', end.code);
        else if (end.kind === 'transport') this.#local.state('disconnected', end.code);
      },
    );
    const result = await this.#socket.done;
    if (!lease.current()) return;
    throw new Recovery(
      result.kind === 'stopped' ? 'transport' : result.kind,
      result.code,
      result.kind === 'rebuild'
        ? result.code === 'cursor_expired'
          ? 'expired_replay'
          : 'invalid_input'
        : 'transport',
    );
  }
  #remember(cursor: string, fingerprint: string): void {
    const bytes = 256 + cursor.length * 2 + fingerprint.length * 2;
    while (
      this.#seen.size >= this.#memory.limits.journalCommits ||
      this.#seenBytes + bytes > this.#memory.limits.journalBytes
    ) {
      const oldest = this.#seen.entries().next().value;
      if (!oldest) break;
      this.#seen.delete(oldest[0]);
      this.#seenBytes -= oldest[1].bytes;
      this.#memory.release(oldest[1].bytes);
    }
    if (bytes > this.#memory.limits.journalBytes) throw new SdkError('capacity');
    this.#memory.take(bytes);
    this.#seenBytes += bytes;
    this.#seen.set(cursor, { fingerprint, bytes });
  }
  #frame(complete: Complete, frame: FeedFrame, handoff: string, fingerprint: string): void {
    if (this.#complete !== complete) return;
    if (frame.type === 'handoff_complete') {
      if (complete.cursor !== handoff) throw new SdkError('invalid_value');
      if (!complete.published) {
        complete.published = true;
        this.#local.publish(complete.data, complete.cursor);
      } else this.#local.state('synchronized');
      this.#failures = 0;
      this.#diagnostic('handoff');
      return;
    }
    const next =
      frame.type === 'change_batch' ? frame.data.commit_cursor : frame.data.through_cursor;
    if (
      frame.type === 'progress' &&
      next === complete.cursor &&
      frame.data.previous_cursor === complete.cursor
    )
      return;
    const seen = this.#seen.get(next);
    if (seen !== undefined) {
      if (seen.fingerprint === fingerprint) return;
      throw new SdkError('invalid_value');
    }
    if (frame.data.previous_cursor !== complete.cursor) throw new SdkError('invalid_value');
    const started = performance.now();
    this.#remember(next, fingerprint);
    if (frame.type === 'change_batch') {
      if (complete.published) this.#local.apply(frame.data.changes, next);
      else complete.data.apply(frame.data.changes);
    } else if (complete.published) this.#local.progress(next);
    complete.cursor = next;
    if (frame.type === 'change_batch')
      this.#diagnostic('apply', undefined, performance.now() - started);
  }
  shutdown(drained: Promise<void> = Promise.resolve()): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#unobserve();
    this.#invalidate('stopped', 'closed');
    this.#closing = Promise.all([
      this.#lease?.release(),
      drained.then(() => this.#releaseCapture()),
    ]).then(() => undefined);
    return this.#closing;
  }
  async settled(): Promise<void> {
    await this.#job;
    this.#discardCapture();
    if (this.#cleanupFailure) throw this.#cleanupFailure;
  }
}
