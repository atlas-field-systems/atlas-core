import Database from 'better-sqlite3';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { z } from 'zod';
import { caseFold } from 'unicode-case-folding';
import { Counter, HistoryPage, NegotiatedLimits, Put, ReplayPage, SnapshotPage, Timestamp, Uuid, exchanges } from '@atlas/protocol';
import type { Continuation, HistoryQuery, RequestOf } from '@atlas/protocol';
import { instant } from './exact.js';
import { refuse } from './fault.js';
import type { Store } from './database.js';
import type { Entities } from './entities.js';
import type { Identity } from './identity.js';
import type { Objects } from './objects.js';
import type { Tasks } from './tasks.js';
import type { Receipt, Temporary } from './temporary.js';

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
const one = <T>(values: readonly T[] | undefined, value: T | undefined): boolean => values === undefined || value !== undefined && values.includes(value);
const aliases = (values: readonly string[] | undefined, value: string | undefined): boolean => values === undefined || value !== undefined && values.some(v => caseFold(v) === caseFold(value));

export class Reads {
  private readonly files = new Map<Uuid, string>();
  private readonly builds = new Map<Uuid, Promise<void>>();
  constructor(private readonly store: Store, private readonly entities: Entities, private readonly identity: Identity,
    private readonly tasks: Tasks, private readonly objects: Objects, private readonly temporary: Temporary,
    private readonly directory: string) {}
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
    let bytes = 16_384, more = false, scanned = 0, position = after;
    outer: while (true) {
      const batch = source(position, 32);
      for (const image of batch) {
        position = key(image);
        if (++scanned > 100_000) refuse('resource_limit');
        if (!match(image, query)) continue;
        const length = Buffer.byteLength(JSON.stringify(image));
        if (items.length >= size || bytes + length > this.store.settings.limits.max_message_bytes - 16_384) { more = true; break outer; }
        items.push(image); bytes += length;
      }
      if (batch.length < 32) break;
    }
    const last = items.at(-1);
    if (more && last === undefined) refuse('resource_limit');
    return { items, next_page_token: more ? this.temporary.seal(name, { query, after: last === undefined ? after : key(last), deadline }) : null };
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
    return this.page('GetTrackObservations', request, exchanges.GetTrackObservations.request.schema.options[0], (a, n) => this.entities.observations(a, n), a => a.id,
      (a, q) => { this.entities.track(q.track_id); return a.track_id === q.track_id && one(q.publisher_ids, a.publisher_id) && one(q.source_asset_ids, a.source_asset_id); });
  }
  negotiate(request: NegotiatedLimits): NegotiatedLimits {
    const limits = this.store.settings.limits;
    if (request.max_message_bytes < limits.max_message_bytes || request.max_json_values < limits.max_json_values || request.max_changes < limits.max_changes) refuse('resource_limit');
    return { max_message_bytes: limits.max_message_bytes, max_json_values: limits.max_json_values, max_changes: limits.max_changes };
  }
  private path(receiptId: Uuid): string { return join(this.directory, `${receiptId}.sqlite`); }
  private async build(receipt: Receipt, metadata: z.infer<typeof Capture>, rows: (source: Database.Database) => Generator<{ key: string; data: string }>, verifier: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const source = new Database(this.store.path, { readonly: true });
    const path = this.path(receipt.id);
    this.files.set(receipt.id, path);
    let target: Database.Database | undefined;
    let count = 0, bytes = 32768;
    try {
      target = new Database(path);
      target.exec('CREATE TABLE items(position INTEGER PRIMARY KEY,key TEXT NOT NULL UNIQUE,data TEXT NOT NULL) STRICT');
      source.exec('BEGIN');
      const sequence = z.object({ value: Counter }).parse(source.prepare("SELECT value FROM core_meta WHERE key='sequence'").get()).value;
      metadata.baseline = this.store.cursor(sequence);
      const insert = target.prepare('INSERT INTO items VALUES(?,?,?)');
      for (const row of rows(source)) {
        const added = Buffer.byteLength(row.key) + Buffer.byteLength(row.data) + 1024;
        const limits = this.store.settings.temporary;
        const siblings = [...this.temporary.receipts('snapshot'), ...this.temporary.receipts('history')].filter(r => r.id !== receipt.id && (r.state === 'ready' || r.state === 'building'));
        const totalBytes = siblings.filter(r => r.kind === receipt.kind).reduce((sum, r) => sum + r.bytes, 0);
        const totalRefs = siblings.filter(r => r.kind === 'history').reduce((sum, r) => sum + r.refs, 0);
        if (receipt.deadline <= performance.now()) refuse('allocation_expired');
        if (receipt.kind === 'snapshot' ? bytes + added > Number(limits.max_snapshot_bytes) || totalBytes + bytes + added > Number(limits.max_total_snapshot_bytes)
          : count >= limits.max_history_references_per_view || totalRefs + count >= limits.max_total_history_references || totalBytes + bytes + added > Number(limits.max_history_bytes)) refuse('resource_limit');
        bytes += added; count++;
        this.temporary.set({ ...receipt, bytes, refs: count });
        insert.run(count, row.key, row.data);
        if (count % 64 === 0) { await setImmediate(); this.identity.authorize(verifier); }
      }
      source.exec('COMMIT');
      target.close(); target = undefined;
      const actual = (await stat(path)).size;
      if (actual > bytes) refuse('resource_limit');
      this.identity.authorize(verifier);
      if (receipt.deadline <= performance.now()) refuse('allocation_expired');
      this.temporary.set({ ...receipt, state: 'ready', data: JSON.stringify(metadata), bytes, refs: count });
    } catch (error) {
      if (source.inTransaction) source.exec('ROLLBACK');
      if (target?.open) target.close();
      this.temporary.set({ ...receipt, state: 'failed', data: '{}', bytes, refs: count });
      await rm(path, { force: true });
      this.files.delete(receipt.id);
      this.temporary.set({ ...receipt, state: 'failed', data: '{}', bytes: 0, refs: 0 });
      throw error;
    } finally { source.close(); }
  }
  async snapshot(request: RequestOf<'ReadSnapshot'>, verifier: string): Promise<SnapshotPage> {
    if ('page_token' in request) return this.snapshotPage(this.temporary.open(request.page_token, 'snapshot-page', CaptureToken));
    const limits = this.negotiate(request);
    const reserved = this.store.db.transaction(() => this.temporary.reserve('snapshot', request.allocation_context, request.load_id, request))();
    const receipt = reserved.receipt;
    if (reserved.fresh) {
      const build = this.build(receipt, { kind: 'snapshot', baseline: '', expires: reserved.expires, load: request.load_id, size: request.page_size, limits }, source => this.picture(source), verifier);
      this.builds.set(receipt.id, build);
      try { await build; } finally { this.builds.delete(receipt.id); }
    } else if (receipt.state === 'building') await this.builds.get(receipt.id);
    this.identity.authorize(verifier);
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
    const receipt = this.temporary.get(token.id);
    if (receipt.state !== 'ready' || receipt.kind !== 'snapshot') refuse('allocation_expired');
    const metadata = Capture.parse(JSON.parse(receipt.data));
    if (metadata.kind !== 'snapshot') refuse('allocation_expired');
    const database = new Database(this.path(receipt.id), { readonly: true });
    try {
      const candidates = database.prepare('SELECT data, row_number() OVER (ORDER BY key) AS position FROM items ORDER BY key LIMIT ? OFFSET ?').all(Math.min(metadata.size, metadata.limits.max_changes) + 1, token.position).map(row => Row.parse(row));
      const items: Put[] = [];
      let bytes = 4096;
      for (const row of candidates) {
        if (items.length >= metadata.size || items.length >= metadata.limits.max_changes || bytes + Buffer.byteLength(row.data) > metadata.limits.max_message_bytes - 4096) break;
        items.push(Put.parse(JSON.parse(row.data))); bytes += Buffer.byteLength(row.data);
      }
      if (items.length === 0 && candidates.length > 0) refuse('resource_limit');
      return { load_id: metadata.load, capture_id: receipt.id, baseline_cursor: metadata.baseline, expires_at: metadata.expires, limits: metadata.limits,
        items, next_page_token: candidates.length > items.length ? this.temporary.seal('snapshot-page', { id: receipt.id, position: token.position + items.length }) : null,
        release_token: this.temporary.seal('release', { id: receipt.id, kind: 'snapshot' }) };
    } finally { database.close(); }
  }
  async history(kind: 'asset' | 'observation' | 'track', request: HistoryQuery, verifier: string): Promise<HistoryPage> {
    if ('page_token' in request) return this.historyPage(this.temporary.open(request.page_token, 'history-page', CaptureToken));
    const query = request;
    const selection = this.entities.sourceForHistory(kind, request.entity_id);
    const reserved = this.store.db.transaction(() => this.temporary.reserve('history', request.allocation_context, request.query_id, { kind, ...request }))();
    const receipt = reserved.receipt;
    if (reserved.fresh) {
      const build = this.build(receipt, { kind: 'history', baseline: '', expires: reserved.expires, query: request.query_id, size: request.page_size ?? 100 }, source => {
        const evidence = this.entities.evidence;
        function* rows() {
          for (const { identity, reading } of evidence.positions(selection.source, source)) {
            if (query.time_groups !== undefined && !query.time_groups.includes(reading.time_status)) continue;
            if (reading.time_status === 'known' && reading.observed_at !== null &&
              (query.source_time_from !== undefined && instant(reading.observed_at) < instant(query.source_time_from) ||
                query.source_time_before !== undefined && instant(reading.observed_at) >= instant(query.source_time_before))) continue;
            yield { key: identity, data: JSON.stringify({ identity, tracks: selection.tracks }) };
          }
        }
        return rows();
      }, verifier);
      this.builds.set(receipt.id, build);
      try { await build; } finally { this.builds.delete(receipt.id); }
    } else if (receipt.state === 'building') await this.builds.get(receipt.id);
    this.identity.authorize(verifier);
    return this.historyPage({ id: receipt.id, position: 0 });
  }
  private historyPage(token: z.infer<typeof CaptureToken>): HistoryPage {
    const receipt = this.temporary.get(token.id);
    if (receipt.kind !== 'history' || receipt.state !== 'ready') refuse('allocation_expired');
    const metadata = Capture.parse(JSON.parse(receipt.data));
    if (metadata.kind !== 'history') refuse('allocation_expired');
    const database = new Database(this.path(receipt.id), { readonly: true });
    try {
      const rows = database.prepare('SELECT position,data FROM items WHERE position>? ORDER BY position LIMIT ?').all(token.position, metadata.size + 1).map(row => Row.parse(row));
      const readings = rows.slice(0, metadata.size).map(row => {
        const member = Membership.parse(JSON.parse(row.data));
        const reading = this.entities.evidence.position(member.identity);
        reading.track_ids = member.tracks;
        return reading;
      });
      return HistoryPage.parse({ query_id: metadata.query, view_id: receipt.id, source: 'core', baseline_cursor: metadata.baseline, expires_at: metadata.expires,
        release_token: this.temporary.seal('release', { id: receipt.id, kind: 'history' }), readings,
        next_page_token: rows.length > readings.length ? this.temporary.seal('history-page', { id: receipt.id, position: token.position + readings.length }) : null });
    } finally { database.close(); }
  }
  async release(token: string, kind: 'snapshot' | 'history') {
    const value = this.temporary.open(token, 'release', ReleaseToken);
    if (value.kind !== kind) refuse('allocation_expired');
    const receipt = this.temporary.get(value.id);
    if (receipt.kind !== kind) refuse('allocation_expired');
    await this.builds.get(receipt.id);
    await rm(this.path(receipt.id), { force: true });
    this.files.delete(receipt.id);
    this.temporary.set({ ...receipt, state: 'released', bytes: 0, refs: 0 });
    return { released: true as const };
  }
  replay(request: RequestOf<'ReadChanges'>): ReplayPage {
    let context: z.infer<typeof ReplayToken>;
    if ('page_token' in request) context = this.temporary.open(request.page_token, 'replay', ReplayToken);
    else context = { from: request.from_cursor, boundary: this.store.cursor(), limits: this.negotiate(request), deadline: performance.now() + 60_000 };
    if (performance.now() >= context.deadline) refuse('allocation_expired');
    const candidates = this.store.messages(context.from, context.boundary, 1000);
    const messages: ReplayPage['messages'] = [];
    let bytes = 8192, changes = 0, through = context.from;
    for (const message of candidates) {
      const length = Buffer.byteLength(JSON.stringify(message));
      const count = message.type === 'change_batch' ? message.data.changes.length : 0;
      if (bytes + length > context.limits.max_message_bytes - 4096 || changes + count > context.limits.max_changes) break;
      messages.push(message); bytes += length; changes += count;
      through = message.type === 'change_batch' ? message.data.commit_cursor : message.data.through_cursor;
    }
    if (messages.length === 0 && candidates.length > 0) refuse('resource_limit');
    return { replay_boundary: context.boundary, messages, through_cursor: through,
      next_page_token: through !== context.boundary ? this.temporary.seal('replay', { ...context, from: through }) : null };
  }
  async cleanup(): Promise<void> {
    for (const [receiptId, path] of this.files) {
      let expired = false;
      try { this.temporary.get(receiptId); } catch { expired = true; }
      if (expired && !this.builds.has(receiptId)) { await rm(path, { force: true }); this.files.delete(receiptId); }
    }
  }
  async expireHistory(): Promise<void> {
    for (const receipt of this.temporary.receipts('history')) {
      if (receipt.state !== 'ready' || this.builds.has(receipt.id)) continue;
      await rm(this.path(receipt.id), { force: true }); this.files.delete(receipt.id);
      this.temporary.set({ ...receipt, state: 'released', bytes: 0, refs: 0 });
    }
  }
  async close(): Promise<void> { await Promise.allSettled(this.builds.values()); for (const path of this.files.values()) await rm(path, { force: true }); this.files.clear(); }
}
