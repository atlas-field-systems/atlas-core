import Database from 'better-sqlite3';
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
    if (found.cursor !== null) this.replayCursor = found.cursor;
    return true;
  }
  remember(scope: string, request: string, facts: unknown): void {
    this.retries.push({ scope, request, facts: canonical(facts) });
    this.dirty = true;
  }
}
export class Store {
  readonly db: Database.Database;
  readonly dataset: Uuid;
  readonly run = id();
  constructor(readonly path: string, readonly settings: Settings, establish?: { dataset: Uuid; actionId: Uuid }) {
    this.db = new Database(path);
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
  parseCursor(cursor: string): Counter {
    const prefix = `${this.dataset}/`;
    if (!cursor.startsWith(prefix) || !/^\d{20}$/.test(cursor.slice(prefix.length))) refuse('cursor_expired', { earliest_recoverable_cursor: this.earliest() });
    const value = Counter.safeParse(BigInt(cursor.slice(prefix.length)).toString());
    if (!value.success || BigInt(value.data) > BigInt(this.sequence) || BigInt(value.data) < BigInt(this.meta('earliest') ?? '0')) refuse('cursor_expired', { earliest_recoverable_cursor: this.earliest() });
    return value.data;
  }
  earliest(): string { return this.cursor(Counter.parse(this.meta('earliest'))); }
  transact<T>(authority: Authority | null, action: (tx: Transaction) => T): { data: T; cursor?: string } {
    const committed: (() => void)[] = [];
    const result = this.db.transaction(() => {
      const tx = new Transaction(this, authority);
      const data = action(tx);
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
      return { data, ...(cursor === undefined ? {} : { cursor }) };
    })();
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
  messages(from: string, through: string, max = 1000): ReplayMessage[] {
    const start = this.parseCursor(from).padStart(20, '0');
    const end = this.parseCursor(through).padStart(20, '0');
    return this.db.prepare('SELECT sequence,previous,message FROM commit_log WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT ?')
      .all(start, end, max).map(value => ReplayMessage.parse(JSON.parse(LogRow.parse(value).message)));
  }
  checkpoint(): void { this.db.pragma('wal_checkpoint(PASSIVE)'); }
  close(): void { this.checkpoint(); this.db.close(); }
  engine() {
    return { ...z.object({ version: z.string(), sourceId: z.string() }).parse(this.db.prepare('SELECT sqlite_version() AS version,sqlite_source_id() AS sourceId').get()),
      journal: this.db.pragma('journal_mode', { simple: true }), synchronous: this.db.pragma('synchronous', { simple: true }),
      compileOptions: this.db.pragma('compile_options'), run: this.run, dataset: this.dataset, at: now() };
  }
}
