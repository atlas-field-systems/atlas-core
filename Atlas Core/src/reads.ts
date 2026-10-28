import Database from 'better-sqlite3';
import { stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { z } from 'zod';
import { caseFold } from 'unicode-case-folding';
import { Counter, HistoryPage, NegotiatedLimits, Put, ReplayPage, SnapshotPage, Timestamp, Uuid, exchanges } from '@atlas/protocol';
import type { Continuation, HistoryQuery, RequestOf } from '@atlas/protocol';
import { refuse } from './fault.js';
import type { Store } from './database.js';
import type { Entities } from './entities.js';
import type { Identity } from './identity.js';
import type { Objects } from './objects.js';
import type { Tasks } from './tasks.js';
import { FailedCapture } from './temporary.js';
import type { Receipt, Temporary } from './temporary.js';
import { publicError } from './fault.js';
import { currentWriter, ownedDirectory, removeCapture } from './ownership.js';
import { boundedPage } from './pages.js';

const PageToken = z.object({ query: z.unknown(), after: z.string(), deadline: z.number() });
const CaptureToken = z.object({ id: Uuid, position: z.number().int().nonnegative() });
const ReleaseToken = z.object({ id: Uuid, kind: z.enum(['snapshot', 'history']) });
const Capture = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('snapshot'), baseline: z.string(), expires: Timestamp, load: Uuid, size: z.number(), limits: NegotiatedLimits }),
  z.object({ kind: z.literal('history'), baseline: z.string(), expires: Timestamp, query: Uuid, size: z.number() }),
]);
const Row = z.object({ data: z.string(), position: z.number() });
const Membership = z.object({ identity: z.string(), tracks: z.array(Uuid) });
const ReplayToken = z.object({ from: z.string(), boundary: z.string(), deadline: z.number(), limits: NegotiatedLimits });
type CaptureReservation = { metadata: number; file: number; metadataWriteBytes: number };
const captureOutcomeBytes = 4096;
const initialCaptureBytes = 32768;
function captureData(value: z.infer<typeof Capture> | z.infer<typeof FailedCapture>): string {
  const data = JSON.stringify(value);
  if (Buffer.byteLength(data) > captureOutcomeBytes) throw new Error('capture_outcome_limit');
  return data;
}
const one = <T>(values: readonly T[] | undefined, value: T | undefined): boolean => values === undefined || value !== undefined && values.includes(value);
const aliases = (values: readonly string[] | undefined, value: string | undefined): boolean => values === undefined || value !== undefined && values.some(v => caseFold(v) === caseFold(value));

export class Reads {
  private readonly files = new Map<Uuid, string>();
  private readonly builds = new Map<Uuid, Promise<void>>();
  private readonly reclamations = new Map<Uuid, Promise<void>>();
  private readonly pending = new Map<Uuid, CaptureReservation>();
  constructor(private readonly store: Store, private readonly entities: Entities, private readonly identity: Identity,
    private readonly tasks: Tasks, private readonly objects: Objects, private readonly temporary: Temporary,
    private readonly directory: string, private readonly reserve: <T>(reservation: (admit: (bytes: number) => void) => T) => Promise<T>) {}
  private boundedPage<T, R>(items: T[], make: (shortened: boolean) => R, limits: NegotiatedLimits = this.store.settings.limits): R {
    return boundedPage(items, make, limits, this.store.dataset);
  }
  private page<Q extends { page_size?: number }, T>(name: string, request: Q | Continuation, schema: z.ZodType<Q>,
    source: (after: string, limit: number) => T[], key: (image: T) => string, match: (image: T, query: Q) => boolean) {
    let query: Q, after = '', deadline = performance.now() + 60_000;
    if ('page_token' in request) {
      const token = this.temporary.open(request.page_token, name, PageToken);
      query = schema.parse(token.query); after = token.after; deadline = token.deadline;
      if (performance.now() >= deadline) refuse('allocation_expired');
    } else query = request;
    const size = query.page_size ?? 100;
    const items: T[] = [];
    const batchSize = Math.max(1, Math.min(32, Math.floor(this.store.settings.limits.max_message_bytes / (this.store.settings.resourceImageBytes * 4))));
    let bytes = 16_384, more = false, scanned = 0, position = after;
    outer: while (true) {
      const batch = source(position, batchSize);
      for (const image of batch) {
        position = key(image);
        if (++scanned > 100_000) refuse('resource_limit');
        if (!match(image, query)) continue;
        const length = Buffer.byteLength(JSON.stringify(image));
        if (items.length >= size || bytes + length > this.store.settings.limits.max_message_bytes - 16_384) { more = true; break outer; }
        items.push(image); bytes += length;
      }
      if (batch.length < batchSize) break;
    }
    if (more && items.length === 0) refuse('resource_limit');
    return this.boundedPage(items, shortened => {
      const last = items.at(-1);
      const next_page_token = more || shortened ? this.temporary.seal(name, { query, after: last === undefined ? after : key(last), deadline }) : null;
      if (next_page_token !== null && Buffer.byteLength(JSON.stringify({ page_token: next_page_token })) > this.store.settings.limits.max_request_bytes) refuse('resource_limit');
      return { items, next_page_token };
    });
  }
  assets(request: RequestOf<'ListAssets'>) {
    return this.page('ListAssets', request, exchanges.ListAssets.request.schema.options[0], (a, n) => this.entities.assets(a, n), a => a.id,
      (a, q) => one(q.filters?.ids, a.id) && aliases(q.filters?.aliases, a.alias) && one(q.filters?.kinds, a.type.kind) && one(q.filters?.health, a.communications.health));
  }
  observations(request: RequestOf<'ListObservations'>) {
    return this.page('ListObservations', request, exchanges.ListObservations.request.schema.options[0], (a, n) => this.entities.observations(a, n), a => a.id,
      (a, q) => one(q.filters?.ids, a.id) && aliases(q.filters?.aliases, a.alias) && one(q.filters?.kinds, a.type.state === 'value' ? a.type.value.kind : undefined) &&
        one(q.filters?.publisher_ids, a.publisher_id) && one(q.filters?.source_asset_ids, a.source_asset_id) && one(q.filters?.track_ids, a.track_id));
  }
  tracks(request: RequestOf<'ListTracks'>) {
    return this.page('ListTracks', request, exchanges.ListTracks.request.schema.options[0], (a, n) => this.entities.tracks(a, n), a => a.id,
      (a, q) => one(q.filters?.ids, a.id) && aliases(q.filters?.aliases, a.alias) && one(q.filters?.kinds, a.type.state === 'value' ? a.type.value.kind : undefined));
  }
  geofeatures(request: RequestOf<'ListGeofeatures'>) {
    return this.page('ListGeofeatures', request, exchanges.ListGeofeatures.request.schema.options[0], (a, n) => this.entities.geofeatures(a, n), a => a.id,
      (a, q) => one(q.filters?.ids, a.id) && aliases(q.filters?.aliases, a.alias) && one(q.filters?.kinds, a.type.kind));
  }
  taskList(request: RequestOf<'ListTasks'>) {
    return this.page('ListTasks', request, exchanges.ListTasks.request.schema.options[0], (a, n) => this.tasks.list(a, n), a => a.task_id,
      (a, q) => one(q.filters?.ids, a.task_id) && one(q.filters?.asset_ids, a.asset_id) && one(q.filters?.commands, a.command) && one(q.filters?.states, a.cancellation_request_id === null ? a.execution_state : 'cancellation_requested'));
  }
  objectList(request: RequestOf<'ListObjects'>) {
    return this.page('ListObjects', request, exchanges.ListObjects.request.schema.options[0], (a, n) => this.objects.list(a, n), a => a.object_id,
      (a, q) => one(q.filters?.ids, a.object_id) && one(q.filters?.content_types, a.content_type));
  }
  keys(request: RequestOf<'ListApiKeys'>) {
    return this.page('ListApiKeys', request, exchanges.ListApiKeys.request.schema.options[0], (a, n) => this.identity.keys(a, n), a => a.api_key_id,
      (a, q) => one(q.filters?.ids, a.api_key_id) && one(q.filters?.operator_ids, a.operator_id ?? undefined));
  }
  operators(request: RequestOf<'ListOperators'>) {
    return this.page('ListOperators', request, exchanges.ListOperators.request.schema.options[0], (a, n) => this.identity.operators(a, n), a => a.operator_id,
      (a, q) => one(q.filters?.ids, a.operator_id));
  }
  activity(request: RequestOf<'ReadActivity'>) {
    return this.page('ReadActivity', request, exchanges.ReadActivity.request.schema.options[0], (a, n) => this.identity.activities(a, n), a => a.activity_id,
      (a, q) => one(q.filters?.categories, a.category));
  }
  resources(request: RequestOf<'ListResources'>) {
    const usage = [
      { kind: 'objects', used: Counter.parse(String(this.objects.usage().bytes)), capacity: Counter.parse(String(this.store.settings.objectBytes)) },
      { kind: 'temporary_receipts', used: Counter.parse(String(this.temporary.receipts('contact').length + this.temporary.receipts('snapshot').length + this.temporary.receipts('history').length)), capacity: Counter.parse(String(this.store.settings.temporary.max_allocation_receipts)) },
    ];
    return this.page('ListResources', request, exchanges.ListResources.request.schema.options[0], (after, limit) => usage.filter(a => a.kind > after).slice(0, limit), a => a.kind, (a, q) => one(q.filters?.kinds, a.kind));
  }
  associated(kind: 'asset' | 'observation' | 'track' | 'geofeature' | 'task', request: RequestOf<'GetAssetObjects'> | RequestOf<'GetObservationObjects'> | RequestOf<'GetTrackObjects'> | RequestOf<'GetGeofeatureObjects'> | RequestOf<'GetTaskObjects'>) {
    const schema = z.object({ parent: Uuid, page_size: z.number().int().exactOptional() });
    let query: z.infer<typeof schema> | Continuation;
    if ('page_token' in request) query = request;
    else {
      const parent = 'asset_id' in request ? request.asset_id : 'observation_id' in request ? request.observation_id : 'track_id' in request ? request.track_id : 'geofeature_id' in request ? request.geofeature_id : request.task_id;
      if (kind === 'task') this.tasks.get(parent);
      else if (!this.entities.known(parent, kind)) refuse('entity_not_found');
      query = { parent, ...(request.page_size === undefined ? {} : { page_size: request.page_size }) };
    }
    return this.page(`associated/${kind}`, query, schema, (a, n) => this.objects.list(a, n), a => a.object_id,
      (a, q) => a.metadata.associations.some(association => association.kind === kind && association.id === q.parent) ||
        kind === 'task' && this.tasks.get(q.parent).result_declarations.some(declaration => declaration.object_id === a.object_id));
  }
  trackObservations(request: RequestOf<'GetTrackObservations'>) {
    const query = 'page_token' in request ? exchanges.GetTrackObservations.request.schema.options[0].parse(this.temporary.open(request.page_token, 'GetTrackObservations', PageToken).query) : request;
    this.entities.track(query.track_id);
    return this.page('GetTrackObservations', request, exchanges.GetTrackObservations.request.schema.options[0], (a, n) => this.entities.trackObservations(query.track_id, a, n), a => a.id,
      (a, q) => one(q.publisher_ids, a.publisher_id) && one(q.source_asset_ids, a.source_asset_id));
  }
  negotiate(request: NegotiatedLimits): NegotiatedLimits {
    const limits = this.store.settings.limits;
    if (request.max_message_bytes < limits.max_message_bytes || request.max_json_values < limits.max_json_values || request.max_changes < limits.max_changes) refuse('resource_limit');
    return { max_message_bytes: limits.max_message_bytes, max_json_values: limits.max_json_values, max_changes: limits.max_changes };
  }
  private path(receiptId: Uuid): string { return join(this.directory, `${receiptId}.sqlite`); }
  get unwritten(): number {
    let bytes = 0;
    for (const pending of this.pending.values()) bytes += pending.metadata + pending.file;
    for (const file of this.temporary.captureFiles()) {
      let written = 0;
      try { written = statSync(this.path(file.id)).size; }
      catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; }
      bytes += Math.max(0, file.bytes - written);
    }
    return bytes;
  }
  private async allocate(kind: 'snapshot' | 'history', token: string, request: string, facts: unknown, verifier: string) {
    return this.reserve(admit => {
      this.identity.authorize(verifier);
      let fresh: Uuid | undefined;
      try {
        return this.store.db.transaction(() => this.temporary.reserve(kind, token, request, facts, receipt => {
          const metadataWriteBytes = (Buffer.byteLength(JSON.stringify(receipt)) + captureOutcomeBytes) * 16 + 65_536;
          const ownershipAndOutcomeBytes = metadataWriteBytes * 4;
          admit(metadataWriteBytes + ownershipAndOutcomeBytes + initialCaptureBytes);
          this.pending.set(receipt.id, { metadata: ownershipAndOutcomeBytes, file: initialCaptureBytes, metadataWriteBytes });
          fresh = receipt.id;
        }))();
      } catch (error) {
        if (fresh !== undefined) this.pending.delete(fresh);
        throw error;
      }
    });
  }
  private async build(receipt: Receipt, metadata: z.infer<typeof Capture>, rows: (source: Database.Database) => Generator<{ key: string; data: string }>, verifier: string): Promise<void> {
    let source: Database.Database | undefined, target: Database.Database | undefined;
    let iterator: ReturnType<typeof rows> | undefined;
    let count = 0, bytes = initialCaptureBytes;
    let owned = false;
    const pending = this.pending.get(receipt.id);
    if (pending === undefined) throw new Error('capture_reservation_missing');
    const check = () => { this.identity.authorize(verifier); if (receipt.deadline <= performance.now()) refuse('allocation_expired'); };
    try {
      await ownedDirectory(this.directory);
      check();
      const owner = await currentWriter(); check();
      this.store.db.transaction(() => {
        this.temporary.ownFile(receipt, owner);
        this.temporary.charge(receipt, bytes, count);
      })();
      owned = true;
      this.files.set(receipt.id, this.path(receipt.id));
      pending.metadata -= pending.metadataWriteBytes;
      pending.file = 0;
      source = new Database(this.store.path, { readonly: true, fileMustExist: true });
      target = new Database(this.path(receipt.id));
      target.pragma('journal_mode = OFF'); target.pragma('synchronous = OFF'); target.pragma('cache_size = -2048');
      target.exec('CREATE TABLE items(position INTEGER PRIMARY KEY,key TEXT NOT NULL UNIQUE,data TEXT NOT NULL) STRICT');
      source.exec('BEGIN');
      metadata.baseline = this.store.cursorAt(source);
      const insert = target.prepare('INSERT INTO items VALUES(?,?,?)');
      const write = target.transaction((batch: { key: string; data: string }[], start: number) => {
        for (const [index, row] of batch.entries()) insert.run(start + index + 1, row.key, row.data);
      });
      iterator = rows(source);
      let done = false;
      while (!done) {
        check();
        const batch: { key: string; data: string }[] = [];
        let added = 0, scanned = 0;
        const until = performance.now() + 8;
        while (scanned++ < 64 && added < 262_144 && performance.now() < until) {
          const row = iterator.next();
          if (row.done) { done = true; break; }
          added += Math.ceil((Buffer.byteLength(row.value.key) + Buffer.byteLength(row.value.data)) * 1.05) + 2048;
          batch.push(row.value);
        }
        if (batch.length > 0) await this.reserve(admit => {
          check();
          admit(added + pending.metadataWriteBytes);
          this.temporary.charge(receipt, bytes + added, count + batch.length);
          bytes += added;
          write(batch, count); count += batch.length;
        });
        await setImmediate(); check();
      }
      iterator = undefined;
      source.exec('COMMIT');
      source.close(); source = undefined;
      target.close(); target = undefined;
      const actual = (await stat(this.path(receipt.id))).size;
      if (actual > bytes) refuse('resource_limit');
      check();
      this.temporary.set({ ...receipt, state: 'ready', data: captureData(metadata), bytes: actual, refs: count });
      this.store.metrics.capture_builds++; this.store.metrics.captured_bytes += actual;
    } catch (error) {
      this.store.metrics.capture_failures++;
      const failures: unknown[] = [];
      const saveFailure = (cleanup?: unknown): Receipt => {
        const failure: z.infer<typeof FailedCapture> = error instanceof AggregateError
          ? { failure: publicError(error.errors[0], this.store.dataset), cleanup_failure: publicError(error.errors[1], this.store.dataset) }
          : { failure: publicError(error, this.store.dataset) };
        if (cleanup !== undefined) failure.cleanup_failure = publicError(cleanup, this.store.dataset);
        const failed = { ...(this.temporary.peek(receipt.id) ?? receipt), state: 'failed' as const, data: captureData(failure) };
        this.temporary.set(failed);
        return failed;
      };
      let failed = receipt;
      try { failed = saveFailure(); } catch (bookkeeping) { failures.push(bookkeeping); }
      pending.file = 0;
      try { iterator?.return(undefined); } catch (cleanup) { failures.push(cleanup); }
      for (const database of [source, target]) {
        if (!database?.open) continue;
        try { if (database.inTransaction) database.exec('ROLLBACK'); }
        catch (cleanup) { failures.push(cleanup); }
        try { database.close(); }
        catch (cleanup) { failures.push(cleanup); }
      }
      let removed = !owned;
      if (source?.open || target?.open) failures.push(new Error('capture_close_unverified'));
      else {
        try { if (owned) await removeCapture(this.directory, receipt.id); removed = true; }
        catch (cleanup) { failures.push(cleanup); }
      }
      if (removed) {
        try { this.temporary.reclaimed(failed); this.files.delete(receipt.id); }
        catch (bookkeeping) { failures.push(bookkeeping); }
      }
      if (failures.length > 0) {
        const cleanup = failures.length === 1 ? failures[0] : new AggregateError(failures, 'capture_cleanup_failed');
        try { saveFailure(cleanup); } catch (bookkeeping) { failures.push(bookkeeping); }
        throw new AggregateError([error, ...failures], 'capture_cleanup_failed');
      }
      throw error;
    } finally { this.pending.delete(receipt.id); }
  }
  async snapshot(request: RequestOf<'ReadSnapshot'>, verifier: string, produce: () => Promise<void> = async () => {}): Promise<SnapshotPage> {
    if ('page_token' in request) { await produce(); this.identity.authorize(verifier); return this.snapshotPage(this.temporary.open(request.page_token, 'snapshot-page', CaptureToken)); }
    const limits = this.negotiate(request);
    const reserved = await this.allocate('snapshot', request.allocation_context, request.load_id, request, verifier);
    const receipt = reserved.receipt;
    if (reserved.fresh) {
      const build = this.build(receipt, { kind: 'snapshot', baseline: '', expires: reserved.expires, load: request.load_id, size: request.page_size, limits }, source => this.picture(source), verifier);
      this.builds.set(receipt.id, build);
      try { await build; } finally { this.builds.delete(receipt.id); }
    } else await this.builds.get(receipt.id);
    await produce(); this.identity.authorize(verifier);
    return this.snapshotPage({ id: receipt.id, position: 0 });
  }
  private *picture(source: Database.Database): Generator<{ key: string; data: string }> {
    for (const image of this.entities.picture(source)) {
      const put = Put.parse({ kind: 'put', resource_kind: image.entity_type, resource_id: image.id, version: image.version, image });
      yield { key: `${put.resource_kind}:${put.resource_id}`, data: JSON.stringify(put) };
    }
    for (const image of this.objects.picture(source)) {
      const put: Put = { kind: 'put', resource_kind: 'object', resource_id: image.object_id, version: image.version, image };
      yield { key: `object:${image.object_id}`, data: JSON.stringify(put) };
    }
    for (const image of this.tasks.picture(source)) {
      const put: Put = { kind: 'put', resource_kind: 'task', resource_id: image.task_id, version: image.version, image };
      yield { key: `task:${image.task_id}`, data: JSON.stringify(put) };
    }
  }
  private snapshotPage(token: z.infer<typeof CaptureToken>): SnapshotPage {
    const receipt = this.temporary.outcome(token.id);
    if (receipt.state !== 'ready' || receipt.kind !== 'snapshot') refuse('allocation_expired');
    const metadata = Capture.parse(JSON.parse(receipt.data));
    if (metadata.kind !== 'snapshot') refuse('allocation_expired');
    const database = new Database(this.path(receipt.id), { readonly: true });
    try {
      const items: Put[] = [];
      let bytes = 4096, more = false;
      for (const raw of database.prepare('SELECT data FROM items ORDER BY key LIMIT ? OFFSET ?').iterate(Math.min(metadata.size, metadata.limits.max_changes) + 1, token.position)) {
        const row = z.object({ data: z.string() }).parse(raw);
        if (items.length >= metadata.size || items.length >= metadata.limits.max_changes || bytes + Buffer.byteLength(row.data) > metadata.limits.max_message_bytes - 4096) { more = true; break; }
        items.push(Put.parse(JSON.parse(row.data))); bytes += Buffer.byteLength(row.data);
      }
      if (items.length === 0 && more) refuse('resource_limit');
      return this.boundedPage(items, shortened => ({ load_id: metadata.load, capture_id: receipt.id, baseline_cursor: metadata.baseline, expires_at: metadata.expires, limits: metadata.limits,
        items, next_page_token: more || shortened ? this.temporary.seal('snapshot-page', { id: receipt.id, position: token.position + items.length }) : null,
        release_token: this.temporary.seal('release', { id: receipt.id, kind: 'snapshot' }) }), metadata.limits);
    } finally { database.close(); }
  }
  async history(kind: 'asset' | 'observation' | 'track', request: HistoryQuery, verifier: string, produce: () => Promise<void> = async () => {}): Promise<HistoryPage> {
    if ('page_token' in request) { await produce(); this.identity.authorize(verifier); return this.historyPage(this.temporary.open(request.page_token, 'history-page', CaptureToken)); }
    const query = request;
    const selection = this.entities.sourceForHistory(kind, request.entity_id);
    const reserved = await this.allocate('history', request.allocation_context, request.query_id, { kind, ...request }, verifier);
    const receipt = reserved.receipt;
    if (reserved.fresh) {
      const build = this.build(receipt, { kind: 'history', baseline: '', expires: reserved.expires, query: request.query_id, size: request.page_size ?? 100 }, source => {
        const evidence = this.entities.evidence;
        function* rows() {
          for (const { identity } of evidence.positions(selection.source, query, source)) {
            yield { key: identity, data: JSON.stringify({ identity, tracks: selection.tracks }) };
          }
        }
        return rows();
      }, verifier);
      this.builds.set(receipt.id, build);
      try { await build; } finally { this.builds.delete(receipt.id); }
    } else await this.builds.get(receipt.id);
    await produce(); this.identity.authorize(verifier);
    return this.historyPage({ id: receipt.id, position: 0 });
  }
  private historyPage(token: z.infer<typeof CaptureToken>): HistoryPage {
    const receipt = this.temporary.outcome(token.id);
    if (receipt.kind !== 'history' || receipt.state !== 'ready') refuse('allocation_expired');
    const metadata = Capture.parse(JSON.parse(receipt.data));
    if (metadata.kind !== 'history') refuse('allocation_expired');
    const database = new Database(this.path(receipt.id), { readonly: true });
    try {
      const readings: HistoryPage['readings'] = [];
      let bytes = 4096, more = false;
      for (const raw of database.prepare('SELECT position,data FROM items WHERE position>? ORDER BY position LIMIT ?').iterate(token.position, metadata.size + 1)) {
        const row = Row.parse(raw);
        const member = Membership.parse(JSON.parse(row.data));
        const reading = this.entities.evidence.position(member.identity);
        reading.track_ids = member.tracks;
        const length = Buffer.byteLength(JSON.stringify(reading));
        if (readings.length >= metadata.size || bytes + length > this.store.settings.limits.max_message_bytes - 4096) { more = true; break; }
        readings.push(reading); bytes += length;
      }
      if (readings.length === 0 && more) refuse('resource_limit');
      return this.boundedPage(readings, shortened => HistoryPage.parse({ query_id: metadata.query, view_id: receipt.id, source: 'core', baseline_cursor: metadata.baseline, expires_at: metadata.expires,
        release_token: this.temporary.seal('release', { id: receipt.id, kind: 'history' }), readings,
        next_page_token: more || shortened ? this.temporary.seal('history-page', { id: receipt.id, position: token.position + readings.length }) : null }));
    } finally { database.close(); }
  }
  async release(token: string, kind: 'snapshot' | 'history', verifier: string) {
    const value = this.temporary.open(token, 'release', ReleaseToken);
    if (value.kind !== kind) refuse('allocation_expired');
    const receipt = this.temporary.peek(value.id);
    if (!receipt) return { released: true as const };
    if (receipt.kind !== kind) refuse('allocation_expired');
    await this.builds.get(receipt.id);
    this.identity.authorize(verifier);
    await this.reclaim(receipt.id, 'release');
    this.identity.authorize(verifier);
    return { released: true as const };
  }
  replay(request: RequestOf<'ReadChanges'>): ReplayPage {
    let context: z.infer<typeof ReplayToken>;
    if ('page_token' in request) context = this.temporary.open(request.page_token, 'replay', ReplayToken);
    else context = { from: request.from_cursor, boundary: this.store.cursor(), limits: this.negotiate(request), deadline: performance.now() + 60_000 };
    if (performance.now() >= context.deadline) refuse('allocation_expired');
    const messages: ReplayPage['messages'] = [];
    let bytes = 1024, changes = 0;
    for (const message of this.store.messages(context.from, context.boundary, 1000)) {
      const length = Buffer.byteLength(JSON.stringify(message));
      const count = message.type === 'change_batch' ? message.data.changes.length : 0;
      if (bytes + length > context.limits.max_message_bytes - 1024 || changes + count > context.limits.max_changes) { if (messages.length === 0) refuse('resource_limit'); break; }
      messages.push(message); bytes += length; changes += count;
    }
    return this.boundedPage(messages, () => {
      const last = messages.at(-1);
      const through = last === undefined ? context.from : last.type === 'change_batch' ? last.data.commit_cursor : last.data.through_cursor;
      return { replay_boundary: context.boundary, messages, through_cursor: through,
        next_page_token: through !== context.boundary ? this.temporary.seal('replay', { ...context, from: through }) : null };
    }, context.limits);
  }
  feed(from: string, boundary: string) {
    const messages: ReplayPage['messages'] = [];
    const limits = this.store.settings.limits;
    let bytes = 4096, changes = 0;
    for (const message of this.store.messages(from, boundary, 64)) {
      const length = Buffer.byteLength(JSON.stringify(message));
      const count = message.type === 'change_batch' ? message.data.changes.length : 0;
      if (bytes + length > limits.max_message_bytes || changes + count > limits.max_changes) {
        if (messages.length === 0) refuse('resource_limit');
        break;
      }
      messages.push(message); bytes += length; changes += count;
    }
    return this.boundedPage(messages, () => ({ through: boundary, messages, earliest: this.store.earliest() }));
  }
  async cleanup(): Promise<void> {
    for (const receiptId of this.files.keys()) {
      const receipt = this.temporary.peek(receiptId);
      if ((receipt === undefined || receipt.state === 'released' || receipt.deadline <= performance.now()) && !this.builds.has(receiptId)) await this.reclaim(receiptId, 'expiry');
    }
    this.temporary.expire(new Set([...this.builds.keys(), ...this.pending.keys()]));
  }
  private historyForExpiry(): Receipt[] {
    return this.temporary.receipts('history').filter(receipt => (receipt.state === 'ready' || receipt.state === 'released') && this.files.has(receipt.id) && !this.builds.has(receipt.id));
  }
  get reclaimableHistoryBytes(): number {
    return this.historyForExpiry().reduce((bytes, receipt) => bytes + receipt.bytes, 0);
  }
  async expireHistory(): Promise<void> {
    for (const receipt of this.historyForExpiry()) await this.reclaim(receipt.id, 'expiry');
  }
  private async reclaim(receiptId: Uuid, reason: 'release' | 'expiry' | 'close'): Promise<void> {
    const pending = this.reclamations.get(receiptId);
    if (pending) return pending;
    if (!this.files.has(receiptId)) return;
    const receipt = this.temporary.peek(receiptId);
    if (receipt) this.temporary.set({ ...receipt, state: receipt.state === 'failed' ? 'failed' : 'released' });
    const removal = removeCapture(this.directory, receiptId).then(() => {
      const current = this.temporary.peek(receiptId);
      if (current) this.temporary.reclaimed(current);
      else this.temporary.fileRemoved(receiptId);
      this.files.delete(receiptId);
      if (reason === 'release') this.store.metrics.capture_releases++;
      else if (reason === 'expiry') this.store.metrics.capture_expiries++;
    });
    this.reclamations.set(receiptId, removal);
    try { await removal; } finally { this.reclamations.delete(receiptId); }
  }
  async close(): Promise<void> {
    await Promise.allSettled(this.builds.values());
    for (const id of this.files.keys()) await this.reclaim(id, 'close');
  }
}
