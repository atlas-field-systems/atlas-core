import Database from 'better-sqlite3';
import { existsSync, statSync } from 'node:fs';
import { z } from 'zod';
import { Change, Counter, ReplayMessage, Uuid, contract, writeJson } from '@atlas/protocol';
import { canonical, id, next, now, zero } from './exact.js';
import { refuse } from './fault.js';
import type { Settings } from './settings.js';

const Meta = z.strictObject({ value: z.string() });
const Retry = z.strictObject({ facts: z.string(), cursor: z.string().nullable() });
const LogRow = z.strictObject({ sequence: z.string(), previous: z.string(), message: z.string() });
export type Authority = Readonly<{ keyId: Uuid; operatorId: Uuid | null }>;
export class Transaction {
  readonly effects = new Map<string, Change>();
  readonly retries: { scope: string; request: string; facts: string }[] = [];
  readonly committed: (() => void)[] = [];
  dirty = false;
  retainedBytes = 0;
  replayed = false;
  replayCursor: string | undefined;
  constructor(readonly store: Store, readonly authority: Authority | null) {}
  change(change: Change): void {
    const bytes = writeJson(contract(Change, 'http_response'), change);
    if (bytes.byteLength > this.store.settings.resourceImageBytes) refuse('resource_limit');
    this.effects.set(`${change.resource_kind}:${change.resource_id}`, change);
    this.dirty = true;
  }
  retry(scope: string, request: string, facts: unknown): boolean {
    const row = this.store.db.prepare('SELECT facts,cursor FROM retry WHERE scope=? AND request=?').get(scope, request);
    if (row === undefined) return false;
    const found = Retry.parse(row);
    if (found.facts !== canonical(facts)) refuse('identity_conflict');
    this.replayed = true;
    if (found.cursor !== null) this.replayCursor = found.cursor;
    return true;
  }
  remember(scope: string, request: string, facts: unknown): void {
    this.retries.push({ scope, request, facts: canonical(facts) });
    this.dirty = true;
  }
  rememberPrivate(scope: string, request: string, facts: unknown): void {
    const encoded = canonical(facts);
    this.retainedBytes += Buffer.byteLength(scope) + Buffer.byteLength(request) + Buffer.byteLength(encoded);
    this.store.db.prepare('INSERT INTO retry VALUES(?,?,?,NULL)').run(scope, request, encoded);
  }
}
export class Store {
  readonly db: Database.Database;
  readonly dataset: Uuid;
  readonly run = id();
  readonly metrics = { transactions: 0, rollbacks: 0, commit_ms: 0, transaction_ms: 0, ipc_wait_ms: 0,
    checkpoints: 0, checkpoint_ms: 0, wal_bytes: 0, wal_frames: 0, checkpointed_frames: 0, checkpoint_busy: 0,
    contact_refreshes: 0, capture_builds: 0, capture_failures: 0, capture_releases: 0, capture_expiries: 0, captured_bytes: 0 };
  constructor(readonly path: string, readonly settings: Settings, establish?: { dataset: Uuid; actionId: Uuid }) {
    const fresh = !existsSync(path) || statSync(path).size === 0;
    this.db = new Database(path);
    if (fresh) this.db.pragma('auto_vacuum = FULL');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('wal_autocheckpoint = 1000');
    if (this.db.pragma('journal_mode', { simple: true }) !== 'wal' || this.db.pragma('synchronous', { simple: true }) !== 2) throw new Error('durability_configuration');
    this.db.exec(`CREATE TABLE IF NOT EXISTS core_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS retry(scope TEXT NOT NULL,request TEXT NOT NULL,facts TEXT NOT NULL,cursor TEXT,PRIMARY KEY(scope,request)) STRICT;
      CREATE TABLE IF NOT EXISTS commit_log(sequence TEXT PRIMARY KEY,previous TEXT NOT NULL,message TEXT NOT NULL,at INTEGER NOT NULL,bytes INTEGER NOT NULL) STRICT;`);
    const format = this.meta('format');
    if (format !== undefined && format !== '1') throw new Error('incompatible_format');
    this.db.transaction(() => {
      this.setMeta('format', '1');
      if (this.meta('dataset') === undefined) {
        this.setMeta('dataset', establish?.dataset ?? id());
        this.setMeta('sequence', zero);
        this.setMeta('earliest', zero);
        if (establish) this.setMeta('establishment', canonical(establish));
      } else if (establish && (this.meta('dataset') !== establish.dataset || this.meta('establishment') !== canonical(establish))) throw new Error('establishment_conflict');
    })();
    this.dataset = Uuid.parse(this.meta('dataset'));
  }
  meta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM core_meta WHERE key=?').get(key);
    return row === undefined ? undefined : Meta.parse(row).value;
  }
  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO core_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }
  get sequence(): Counter { return Counter.parse(this.meta('sequence')); }
  cursor(sequence = this.sequence): string { return `${this.dataset}/${sequence.padStart(20, '0')}`; }
  cursorAt(source: Database.Database): string {
    return this.cursor(Counter.parse(Meta.parse(source.prepare("SELECT value FROM core_meta WHERE key='sequence'").get()).value));
  }
  maximumReplayBytes(): number {
    return z.object({ bytes: z.number() }).parse(this.db.prepare('SELECT coalesce(max(bytes),0) AS bytes FROM commit_log').get()).bytes;
  }
  resetMetadata(dataset: Uuid, action: Uuid, hard: boolean): void {
    this.db.exec(hard ? 'DELETE FROM retry; DELETE FROM commit_log' : "DELETE FROM retry WHERE scope NOT LIKE 'setup/%'; DELETE FROM commit_log");
    this.setMeta('dataset', dataset); this.setMeta('sequence', zero); this.setMeta('earliest', zero);
    this.db.prepare("DELETE FROM core_meta WHERE key='settings_revision'").run();
    this.setMeta('establishment', JSON.stringify({ dataset, actionId: action }));
  }
  parseCursor(cursor: string): Counter {
    const prefix = `${this.dataset}/`;
    if (!cursor.startsWith(prefix) || !/^\d{20}$/.test(cursor.slice(prefix.length))) refuse('cursor_expired', { earliest_recoverable_cursor: this.earliest() });
    const value = Counter.safeParse(BigInt(cursor.slice(prefix.length)).toString());
    if (!value.success || BigInt(value.data) > BigInt(this.sequence) || BigInt(value.data) < BigInt(this.meta('earliest') ?? '0')) refuse('cursor_expired', { earliest_recoverable_cursor: this.earliest() });
    return value.data;
  }
  earliest(): string { return this.cursor(Counter.parse(this.meta('earliest'))); }
  transact<T>(authority: Authority | null, action: (tx: Transaction) => T, admit?: (tx: Transaction) => void): { data: T; cursor?: string; execution: 'first' | 'replay' | 'read' } {
    const committed: (() => void)[] = [];
    const began = performance.now();
    let beforeCommit = began;
    let result: { data: T; cursor?: string; execution: 'first' | 'replay' | 'read' };
    try { result = this.db.transaction(() => {
      const tx = new Transaction(this, authority);
      const data = action(tx);
      if (tx.dirty || tx.retainedBytes > 0) admit?.(tx);
      committed.push(...tx.committed);
      let cursor = tx.replayCursor;
      if (tx.dirty) {
        const previous = this.cursor();
        const sequence = next(this.sequence);
        cursor = this.cursor(sequence);
        const changes = [...tx.effects.values()];
        const message: ReplayMessage = changes.length > 0
          ? { type: 'change_batch', data: { previous_cursor: previous, commit_cursor: cursor, changes } }
          : { type: 'progress', data: { previous_cursor: previous, through_cursor: cursor } };
        const encoded = writeJson(contract(ReplayMessage, 'http_response'), message, {
          maxBytes: this.settings.limits.max_message_bytes - 4096,
          maxValues: this.settings.limits.max_json_values - 1024,
          maxChanges: this.settings.limits.max_changes,
        });
        this.db.prepare('INSERT INTO commit_log VALUES(?,?,?,?,?)').run(sequence.padStart(20, '0'), previous, Buffer.from(encoded).toString('utf8'), Date.now(), encoded.byteLength);
        this.setMeta('sequence', sequence);
        for (const retry of tx.retries) this.db.prepare('INSERT INTO retry VALUES(?,?,?,?)').run(retry.scope, retry.request, retry.facts, cursor);
        this.prune();
      }
      beforeCommit = performance.now();
      return { data, ...(cursor === undefined ? {} : { cursor }), execution: tx.dirty ? 'first' as const : tx.replayed ? 'replay' as const : 'read' as const };
    })(); } catch (error) { this.metrics.rollbacks++; throw error; }
    this.metrics.transactions++;
    this.metrics.transaction_ms += performance.now() - began;
    this.metrics.commit_ms += performance.now() - beforeCommit;
    for (const action of committed) action();
    return result;
  }
  private prune(): void {
    const total = z.object({ bytes: z.number() }).parse(this.db.prepare('SELECT coalesce(sum(bytes),0) AS bytes FROM commit_log').get()).bytes;
    let bytes = total;
    while (true) {
      const row = this.db.prepare('SELECT sequence,bytes,at FROM commit_log ORDER BY sequence LIMIT 1').get();
      if (!row) break;
      const r = z.object({ sequence: z.string(), bytes: z.number(), at: z.number() }).parse(row);
      if (bytes <= this.settings.replayBytes && r.at >= Date.now() - this.settings.replayMilliseconds) break;
      this.db.prepare('DELETE FROM commit_log WHERE sequence=?').run(r.sequence);
      this.setMeta('earliest', BigInt(r.sequence).toString());
      bytes -= r.bytes;
    }
  }
  *messages(from: string, through: string, max = 1000): Generator<ReplayMessage> {
    const start = this.parseCursor(from).padStart(20, '0');
    const end = this.parseCursor(through).padStart(20, '0');
    for (const value of this.db.prepare('SELECT sequence,previous,message FROM commit_log WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT ?').iterate(start, end, max)) {
      yield ReplayMessage.parse(JSON.parse(LogRow.parse(value).message));
    }
  }
  checkpoint(): void {
    const began = performance.now();
    const result = z.array(z.object({ busy: z.number().int(), log: z.number().int(), checkpointed: z.number().int() })).length(1).parse(this.db.pragma('wal_checkpoint(PASSIVE)'))[0];
    if (result === undefined) throw new Error('checkpoint_result_missing');
    this.metrics.checkpoints++; this.metrics.checkpoint_ms += performance.now() - began;
    this.metrics.wal_frames = result.log; this.metrics.checkpointed_frames = result.checkpointed;
    this.metrics.checkpoint_busy += result.busy;
    this.metrics.wal_bytes = existsSync(`${this.path}-wal`) ? statSync(`${this.path}-wal`).size : 0;
  }
  close(): void { this.checkpoint(); this.db.close(); }
  engine() {
    return { ...z.object({ version: z.string(), sourceId: z.string() }).parse(this.db.prepare('SELECT sqlite_version() AS version,sqlite_source_id() AS sourceId').get()),
      journal: this.db.pragma('journal_mode', { simple: true }), synchronous: this.db.pragma('synchronous', { simple: true }),
      compileOptions: this.db.pragma('compile_options'), run: this.run, dataset: this.dataset, at: now() };
  }
}
