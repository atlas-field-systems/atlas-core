import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ObjectImage, UploadDescriptor, Uuid } from '@atlas/protocol';
import type { Association, RequestOf } from '@atlas/protocol';
import { canonical, next, now, zero } from './exact.js';
import { refuse } from './fault.js';
import type { Store, Transaction } from './database.js';

const Image = z.object({ image: z.string() });
export const WriterIdentity = z.strictObject({ pid: z.number().int().positive(), boot: z.string().min(1).max(128), start: z.string().regex(/^\d+$/), namespace: z.string().regex(/^pid:\[\d+\]$/), launch: Uuid.exactOptional() });
export type WriterIdentity = z.infer<typeof WriterIdentity>;
export const Attempt = z.strictObject({ id: Uuid, object_id: Uuid, descriptor: z.string(), owner: z.string(), state: z.enum(['active', 'installed', 'published', 'abandoned', 'reclaimed']),
  staging: z.string(), installed: z.string(), bytes: z.number(), key_id: Uuid });
export type Attempt = z.infer<typeof Attempt>;
export class Objects {
  constructor(private readonly store: Store, private readonly reference: (association: Association) => void) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS object_images(id TEXT PRIMARY KEY,image TEXT NOT NULL,deleted INTEGER NOT NULL,path TEXT NOT NULL,fault INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS object_holds(task TEXT NOT NULL,object TEXT NOT NULL,PRIMARY KEY(task,object)) STRICT;
      CREATE TABLE IF NOT EXISTS object_attempts(id TEXT PRIMARY KEY,object_id TEXT NOT NULL,descriptor TEXT NOT NULL,owner TEXT NOT NULL,state TEXT NOT NULL,staging TEXT NOT NULL,installed TEXT NOT NULL,bytes INTEGER NOT NULL,key_id TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS object_progress(attempt TEXT PRIMARY KEY,written INTEGER NOT NULL) STRICT;`);
  }
  get(objectId: Uuid): ObjectImage {
    const row = this.store.db.prepare('SELECT image FROM object_images WHERE id=? AND deleted=0').get(objectId);
    if (!row) refuse('entity_not_found');
    return ObjectImage.parse(JSON.parse(Image.parse(row).image));
  }
  private ended(objectId: Uuid): boolean {
    return this.store.db.prepare('SELECT id FROM object_images WHERE id=? AND deleted=1').get(objectId) !== undefined;
  }
  declare(task: Uuid, object: Uuid, required: boolean): void {
    if (this.ended(object)) refuse('identity_conflict');
    if (required) this.store.db.prepare('INSERT INTO object_holds VALUES(?,?) ON CONFLICT DO NOTHING').run(task, object);
  }
  prepare(descriptor: UploadDescriptor | undefined, attemptId: Uuid, owner: WriterIdentity, keyId: Uuid, admit: (bytes: number) => void): Attempt {
    if (descriptor !== undefined && this.ended(descriptor.object_id)) refuse('identity_conflict');
    for (const association of descriptor?.metadata.associations ?? []) this.reference(association);
    const totals = this.usage();
    if (totals.bytes + Number(descriptor?.byte_length ?? 0) > this.store.settings.objectBytes) refuse('storage_limit');
    if (totals.uploads >= this.store.settings.maxUploads) refuse('resource_limit');
    const attempt: Attempt = { id: attemptId, object_id: descriptor?.object_id ?? attemptId, descriptor: canonical(descriptor ?? {}), owner: canonical(owner), state: 'active',
      staging: `staging/${this.store.run}-${attemptId}`, installed: `installed/${this.store.run}-${attemptId}`, bytes: Number(descriptor?.byte_length ?? 0), key_id: keyId };
    admit(attempt.bytes + 32768 + Buffer.byteLength(attempt.descriptor) * 16);
    this.store.db.prepare('INSERT INTO object_attempts VALUES(@id,@object_id,@descriptor,@owner,@state,@staging,@installed,@bytes,@key_id)').run(attempt);
    return attempt;
  }
  reserve(attemptId: Uuid, bytes: number, admit: (bytes: number) => void): void {
    const attempt = this.attempt(attemptId);
    if (attempt.state !== 'active') refuse('integrity_fault');
    const added = Math.max(0, bytes - attempt.bytes);
    if (added > 0) {
      if (bytes > this.store.settings.limits.max_object_bytes) refuse('payload_too_large');
      if (this.usage().bytes + added > this.store.settings.objectBytes) refuse('storage_limit');
    }
    admit(added);
    if (added === 0) return;
    this.store.db.prepare('UPDATE object_attempts SET bytes=? WHERE id=?').run(bytes, attemptId);
  }
  describe(attemptId: Uuid, descriptor: UploadDescriptor, admit: (bytes: number) => void): void {
    if (this.ended(descriptor.object_id)) refuse('identity_conflict');
    for (const association of descriptor.metadata.associations) this.reference(association);
    const encoded = canonical(descriptor);
    this.store.db.transaction(() => {
      this.reserve(attemptId, Number(descriptor.byte_length), bytes => admit(bytes + Buffer.byteLength(encoded) * 16 + 65_536));
      this.store.db.prepare('UPDATE object_attempts SET descriptor=?,object_id=? WHERE id=?').run(encoded, descriptor.object_id, attemptId);
    })();
  }
  progress(attemptId: Uuid, written: number): void {
    const attempt = this.attempt(attemptId);
    if (attempt.state !== 'active' || written > attempt.bytes || written < 0) refuse('integrity_fault');
    this.store.db.prepare('INSERT INTO object_progress VALUES(?,?) ON CONFLICT(attempt) DO UPDATE SET written=max(written,excluded.written)').run(attemptId, written);
  }
  get unwritten(): number {
    return z.object({ bytes: z.number() }).parse(this.store.db.prepare("SELECT coalesce(sum(a.bytes-coalesce(p.written,0)),0) AS bytes FROM object_attempts a LEFT JOIN object_progress p ON p.attempt=a.id WHERE a.state IN ('active','installed')").get()).bytes;
  }
  retry(tx: Transaction, request: UploadDescriptor): ObjectImage | undefined {
    if (this.ended(request.object_id)) refuse('identity_conflict');
    if (tx.retry('UploadObject', request.request_id, request)) return this.get(request.object_id);
    if (this.store.db.prepare('SELECT id FROM object_images WHERE id=?').get(request.object_id)) refuse('identity_conflict');
    return undefined;
  }
  recover(tx: Transaction, request: UploadDescriptor): ObjectImage {
    const image = this.retry(tx, request);
    if (image === undefined) refuse('identity_conflict');
    return image;
  }
  publish(tx: Transaction, attemptId: Uuid): ObjectImage {
    const attempt = this.attempt(attemptId);
    if (attempt.state !== 'installed') refuse('integrity_fault');
    const request = UploadDescriptor.parse(JSON.parse(attempt.descriptor));
    const previous = this.retry(tx, request);
    if (previous !== undefined) {
      this.store.db.prepare("UPDATE object_attempts SET state='abandoned' WHERE id=?").run(attempt.id);
      return previous;
    }
    for (const association of request.metadata.associations) this.reference(association);
    const image: ObjectImage = { dataset_id: this.store.dataset, object_id: request.object_id, version: zero, edit_revision: zero, created_at: now(),
      byte_length: request.byte_length, sha256: request.sha256, content_type: request.content_type, metadata: request.metadata };
    this.store.db.prepare('INSERT INTO object_images VALUES(?,?,0,?,0)').run(image.object_id, JSON.stringify(image), attempt.installed);
    this.store.db.prepare("UPDATE object_attempts SET state='published' WHERE id=?").run(attempt.id);
    tx.remember('UploadObject', request.request_id, request);
    tx.change({ kind: 'put', resource_kind: 'object', resource_id: image.object_id, version: image.version, image });
    return image;
  }
  installed(attemptId: Uuid): void {
    if (this.attempt(attemptId).state !== 'active') refuse('integrity_fault');
    this.store.db.prepare("UPDATE object_attempts SET state='installed' WHERE id=?").run(attemptId);
  }
  attempt(id: Uuid): Attempt { return Attempt.parse(this.store.db.prepare('SELECT * FROM object_attempts WHERE id=?').get(id)); }
  abandon(attemptId: Uuid): void {
    const attempt = this.attempt(attemptId);
    if (attempt.state === 'published') return;
    if (this.store.db.prepare('SELECT id FROM object_images WHERE path=?').get(attempt.installed)) refuse('integrity_fault');
    this.store.db.prepare("UPDATE object_attempts SET state='abandoned' WHERE id=?").run(attemptId);
  }
  reclaim(attemptId: Uuid): void {
    const attempt = this.attempt(attemptId);
    if (attempt.state !== 'abandoned') refuse('integrity_fault');
    this.store.db.prepare("UPDATE object_attempts SET state='reclaimed',bytes=0 WHERE id=?").run(attemptId);
  }
  attempts(after = ''): Attempt[] {
    const attempts: Attempt[] = [];
    let bytes = 2;
    for (const row of this.store.db.prepare("SELECT * FROM object_attempts WHERE id>? AND state IN ('active','installed','abandoned') ORDER BY id LIMIT 32").iterate(after)) {
      const attempt = Attempt.parse(row);
      bytes += Buffer.byteLength(JSON.stringify(attempt)) + (attempts.length === 0 ? 0 : 1);
      if (bytes > this.store.settings.limits.max_message_bytes - 16384) {
        if (attempts.length === 0) refuse('resource_limit');
        break;
      }
      attempts.push(attempt);
    }
    return attempts;
  }
  writerLaunches(): Uuid[] {
    const launches: Uuid[] = [];
    for (const row of this.store.db.prepare("SELECT DISTINCT json_extract(owner,'$.launch') AS launch FROM object_attempts WHERE state IN ('active','installed','abandoned') AND json_extract(owner,'$.launch') IS NOT NULL").iterate()) {
      if (launches.length >= 4096) refuse('resource_limit');
      launches.push(z.object({ launch: Uuid }).parse(row).launch);
    }
    return launches;
  }
  edit(tx: Transaction, request: RequestOf<'EditObject'>): ObjectImage {
    const image = this.get(request.object_id);
    if (tx.retry('EditObject', request.request_id, request)) return image;
    if (image.edit_revision !== request.expected_edit_revision) refuse('edit_conflict');
    const edits = request.edits;
    if (edits.associations !== undefined) { for (const association of edits.associations) this.reference(association); image.metadata.associations = edits.associations; }
    if (edits.name === null) delete image.metadata.name;
    else if (edits.name !== undefined) image.metadata.name = edits.name;
    if (edits.description === null) delete image.metadata.description;
    else if (edits.description !== undefined) image.metadata.description = edits.description;
    image.version = next(image.version); image.edit_revision = next(image.edit_revision);
    this.store.db.prepare('UPDATE object_images SET image=? WHERE id=?').run(JSON.stringify(image), image.object_id);
    tx.change({ kind: 'put', resource_kind: 'object', resource_id: image.object_id, version: image.version, image });
    tx.remember('EditObject', request.request_id, request);
    return image;
  }
  delete(tx: Transaction, request: RequestOf<'DeleteObject'>): { deleted: true } {
    if (tx.retry('DeleteObject', request.request_id, request)) return { deleted: true };
    const image = this.get(request.object_id);
    if (this.store.db.prepare('SELECT task FROM object_holds WHERE object=? LIMIT 1').get(image.object_id)) refuse('object_held');
    this.store.db.prepare('UPDATE object_images SET deleted=1 WHERE id=?').run(image.object_id);
    tx.change({ kind: 'delete', resource_kind: 'object', resource_id: image.object_id, version: next(image.version) });
    tx.remember('DeleteObject', request.request_id, request);
    return { deleted: true };
  }
  file(objectId: Uuid): { image: ObjectImage; path: string } {
    const image = this.get(objectId);
    const row = z.object({ path: z.string() }).parse(this.store.db.prepare('SELECT path FROM object_images WHERE id=?').get(objectId));
    return { image, path: row.path };
  }
  integrity(objectId: Uuid, fault: boolean): void {
    this.store.db.prepare('UPDATE object_images SET fault=? WHERE id=?').run(fault ? 1 : 0, objectId);
  }
  get degraded(): boolean { return this.store.db.prepare('SELECT id FROM object_images WHERE fault=1 AND deleted=0 LIMIT 1').get() !== undefined; }
  usage(): { bytes: number; uploads: number } {
    return z.object({ bytes: z.number(), uploads: z.number() }).parse(this.store.db.prepare(`SELECT coalesce(sum(bytes),0) AS bytes,
      coalesce(sum(CASE WHEN state IN ('active','installed') THEN 1 ELSE 0 END),0) AS uploads FROM object_attempts WHERE state<>'reclaimed'`).get());
  }
  list(after: string, limit: number): ObjectImage[] {
    return this.store.db.prepare('SELECT image FROM object_images WHERE deleted=0 AND id>? ORDER BY id LIMIT ?').all(after, limit).map(row => ObjectImage.parse(JSON.parse(Image.parse(row).image)));
  }
  *picture(source: Database.Database): Generator<ObjectImage> {
    for (const row of source.prepare('SELECT image FROM object_images WHERE deleted=0 ORDER BY id').iterate()) yield ObjectImage.parse(JSON.parse(Image.parse(row).image));
  }
  clearDataset(): void { this.store.db.exec('DELETE FROM object_images; DELETE FROM object_holds; DELETE FROM object_attempts; DELETE FROM object_progress'); }
  retired(): { object: Uuid; path: string }[] {
    return this.store.db.prepare("SELECT id AS object,path FROM object_images WHERE deleted=1 AND path<>'' LIMIT 32").all().map(row => z.object({ object: Uuid, path: z.string() }).parse(row));
  }
  reclaimed(object: Uuid): void {
    const row = this.store.db.prepare('SELECT path FROM object_images WHERE id=? AND deleted=1').get(object);
    if (!row) refuse('integrity_fault');
    const path = z.object({ path: z.string() }).parse(row).path;
    this.store.db.prepare("UPDATE object_attempts SET state='reclaimed',bytes=0 WHERE installed=? AND state='published'").run(path);
    this.store.db.prepare("UPDATE object_images SET path='' WHERE id=? AND deleted=1").run(object);
  }
}
