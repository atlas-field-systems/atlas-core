import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Timestamp, Uuid } from '@atlas/protocol';
import { canonical, id } from './exact.js';
import { refuse } from './fault.js';
import type { Store } from './database.js';

const Context = z.strictObject({ key: Uuid, context: Uuid, deadline: z.number(), expires: Timestamp });
const Receipt = z.object({ id: Uuid, context: z.string(), request: z.string(), kind: z.enum(['contact', 'snapshot', 'history']),
  facts: z.string(), state: z.enum(['building', 'ready', 'failed', 'released', 'consumed']), data: z.string(),
  deadline: z.number(), bytes: z.number(), refs: z.number(), key_id: Uuid });
export type Receipt = z.infer<typeof Receipt>;
export class Temporary {
  private readonly secret = randomBytes(32);
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS temporary_receipts(id TEXT PRIMARY KEY,context TEXT NOT NULL,request TEXT NOT NULL,kind TEXT NOT NULL,facts TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL,deadline REAL NOT NULL,bytes INTEGER NOT NULL,refs INTEGER NOT NULL,key_id TEXT NOT NULL,UNIQUE(context,kind,request)) STRICT;
      DELETE FROM temporary_receipts;`);
  }
  seal(kind: string, data: unknown): string {
    const raw = canonical({ kind, run: this.store.run, dataset: this.store.dataset, data });
    if (Buffer.byteLength(raw) > 1_048_576) refuse('resource_limit');
    const body = Buffer.from(raw).toString('base64url');
    return `${body}.${createHmac('sha256', this.secret).update(body).digest('base64url')}`;
  }
  open<S extends z.ZodType>(token: string, kind: string, schema: S): z.output<S> {
    if (token.length > 1_500_000) refuse('allocation_expired');
    const [body, signature, extra] = token.split('.');
    if (body === undefined || signature === undefined || extra !== undefined) refuse('allocation_expired');
    const expected = createHmac('sha256', this.secret).update(body).digest('base64url');
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) refuse('allocation_expired');
    let raw: unknown;
    try { raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { refuse('allocation_expired'); }
    const value = z.strictObject({ kind: z.literal(kind), run: z.literal(this.store.run), dataset: z.literal(this.store.dataset), data: z.unknown() }).safeParse(raw);
    if (!value.success) refuse('allocation_expired');
    return schema.parse(value.data.data);
  }
  context(key: Uuid) {
    const context = { key, context: id(), deadline: performance.now() + 60_000, expires: Timestamp.parse(new Date(Date.now() + 60_000).toISOString()) };
    return { allocation_context: this.seal('context', context), allocation_expires_at: context.expires };
  }
  validateContext(token: string): z.infer<typeof Context> {
    const context = this.open(token, 'context', Context);
    if (performance.now() >= context.deadline) refuse('allocation_expired');
    return context;
  }
  expire(): void {
    this.store.db.prepare('DELETE FROM temporary_receipts WHERE deadline<=?').run(performance.now());
  }
  reserve(kind: Receipt['kind'], token: string, request: string, facts: unknown): { receipt: Receipt; fresh: boolean; expires: Timestamp } {
    const context = this.validateContext(token);
    this.expire();
    const found = this.store.db.prepare('SELECT * FROM temporary_receipts WHERE context=? AND kind=? AND request=?').get(context.context, kind, request);
    if (found) {
      const receipt = Receipt.parse(found);
      if (receipt.facts !== canonical(facts)) refuse('allocation_conflict');
      if (receipt.state === 'released' || receipt.state === 'failed') refuse('allocation_expired');
      return { receipt, fresh: false, expires: context.expires };
    }
    const limits = this.store.settings.temporary;
    const counts = z.object({ total: z.number(), active: z.number(), per_key: z.number() }).parse(this.store.db.prepare(`SELECT count(*) AS total,
      coalesce(sum(CASE WHEN kind=? AND state IN ('ready','building') THEN 1 ELSE 0 END),0) AS active,
      coalesce(sum(CASE WHEN kind=? AND key_id=? AND state IN ('ready','building') THEN 1 ELSE 0 END),0) AS per_key FROM temporary_receipts`).get(kind, kind, context.key));
    const max = kind === 'contact' ? limits.max_contact_challenges : kind === 'snapshot' ? limits.max_snapshot_captures : limits.max_history_views;
    const perKey = kind === 'snapshot' ? limits.max_snapshot_captures_per_key : kind === 'history' ? limits.max_history_views_per_key : max;
    if (counts.total >= limits.max_allocation_receipts || counts.active >= max || counts.per_key >= perKey) refuse('resource_limit');
    const receipt: Receipt = { id: id(), context: context.context, request, kind, facts: canonical(facts), state: 'building', data: '{}', deadline: context.deadline, bytes: 0, refs: 0, key_id: context.key };
    this.store.db.prepare('INSERT INTO temporary_receipts VALUES(@id,@context,@request,@kind,@facts,@state,@data,@deadline,@bytes,@refs,@key_id)').run(receipt);
    return { receipt, fresh: true, expires: context.expires };
  }
  set(receipt: Receipt): void {
    this.store.db.prepare('UPDATE temporary_receipts SET state=@state,data=@data,bytes=@bytes,refs=@refs WHERE id=@id').run(receipt);
  }
  get(receiptId: string): Receipt {
    const row = this.store.db.prepare('SELECT * FROM temporary_receipts WHERE id=?').get(receiptId);
    if (!row) refuse('allocation_expired');
    const receipt = Receipt.parse(row);
    if (receipt.deadline <= performance.now()) refuse('allocation_expired');
    return receipt;
  }
  receipts(kind: Receipt['kind']): Receipt[] {
    return this.store.db.prepare('SELECT * FROM temporary_receipts WHERE kind=?').all(kind).map(row => Receipt.parse(row));
  }
}
