import { z } from 'zod';
import { Activity, ApiKey, Operator, Uuid } from '@atlas/protocol';
import type { RequestOf } from '@atlas/protocol';
import { credentialFacts, digest, id, next, now, zero } from './exact.js';
import { refuse } from './fault.js';
import type { Authority, Store, Transaction } from './database.js';

const JsonRow = z.object({ image: z.string() });
const KeyRow = z.object({ image: z.string(), verifier: z.string(), asset_id: Uuid.nullable() });
export class Identity {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS identity_operators(id TEXT PRIMARY KEY,image TEXT NOT NULL,deleted INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS identity_keys(id TEXT PRIMARY KEY,image TEXT NOT NULL,verifier TEXT NOT NULL UNIQUE,asset_id TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS identity_activity(id TEXT PRIMARY KEY,image TEXT NOT NULL) STRICT;`);
  }
  authorize(verifier: string): Authority {
    const row = this.store.db.prepare('SELECT image FROM identity_keys WHERE verifier=?').get(verifier);
    if (!row) refuse('unauthorized');
    const key = ApiKey.parse(JSON.parse(JsonRow.parse(row).image));
    if (key.revoked_at !== null) refuse('unauthorized');
    if (key.operator_id !== null && !this.operatorExists(key.operator_id)) refuse('unauthorized');
    return { keyId: key.api_key_id, operatorId: key.operator_id };
  }
  private operatorExists(operatorId: Uuid): boolean {
    return this.store.db.prepare('SELECT id FROM identity_operators WHERE id=? AND deleted=0').get(operatorId) !== undefined;
  }
  operator(operatorId: Uuid): Operator {
    const row = this.store.db.prepare('SELECT image FROM identity_operators WHERE id=? AND deleted=0').get(operatorId);
    if (!row) refuse('operator_not_found');
    return Operator.parse(JSON.parse(JsonRow.parse(row).image));
  }
  key(keyId: Uuid): ApiKey {
    const row = this.store.db.prepare('SELECT image FROM identity_keys WHERE id=?').get(keyId);
    if (!row) refuse('entity_not_found');
    return ApiKey.parse(JSON.parse(JsonRow.parse(row).image));
  }
  createOperator(tx: Transaction, request: RequestOf<'CreateOperator'>): Operator {
    const old = this.store.db.prepare('SELECT deleted FROM identity_operators WHERE id=?').get(request.operator_id);
    if (old && z.object({ deleted: z.number() }).parse(old).deleted) refuse('operator_deleted');
    if (tx.retry('setup/CreateOperator', request.request_id, request)) return this.operator(request.operator_id);
    if (old) refuse('identity_conflict');
    const { request_id: _request, ...fields } = request;
    const image: Operator = { ...fields, edit_revision: zero };
    this.store.db.prepare('INSERT INTO identity_operators VALUES(?,?,0)').run(image.operator_id, JSON.stringify(image));
    tx.remember('setup/CreateOperator', request.request_id, request);
    this.activity(tx, 'operator', 'Operator created');
    return image;
  }
  editOperator(tx: Transaction, request: RequestOf<'EditOperator'>): Operator {
    const image = this.operator(request.operator_id);
    if (tx.retry('setup/EditOperator', request.request_id, request)) return image;
    if (image.edit_revision !== request.expected_edit_revision) refuse('edit_conflict');
    if (request.edits.name !== undefined) image.name = request.edits.name;
    if (request.edits.description === null) delete image.description;
    else if (request.edits.description !== undefined) image.description = request.edits.description;
    image.edit_revision = next(image.edit_revision);
    this.store.db.prepare('UPDATE identity_operators SET image=? WHERE id=?').run(JSON.stringify(image), image.operator_id);
    tx.remember('setup/EditOperator', request.request_id, request);
    this.activity(tx, 'operator', 'Operator edited');
    return image;
  }
  deleteOperator(tx: Transaction, request: RequestOf<'DeleteOperator'>): { deleted: true } {
    if (tx.retry('setup/DeleteOperator', request.request_id, request)) return { deleted: true };
    const old = this.store.db.prepare('SELECT deleted FROM identity_operators WHERE id=?').get(request.operator_id);
    if (!old) refuse('operator_not_found');
    if (z.object({ deleted: z.number() }).parse(old).deleted) refuse('operator_deleted');
    this.store.db.prepare('UPDATE identity_operators SET deleted=1 WHERE id=?').run(request.operator_id);
    this.revokeMatching(tx, 'operator', request.operator_id);
    tx.remember('setup/DeleteOperator', request.request_id, request);
    this.activity(tx, 'operator', 'Operator deleted');
    return { deleted: true };
  }
  createKey(tx: Transaction, request: RequestOf<'CreateApiKey'>, assetId: Uuid | null = null): ApiKey {
    if (request.operator_id !== undefined && !this.operatorExists(request.operator_id)) refuse('operator_deleted');
    const facts = credentialFacts(request);
    if (tx.retry('setup/CreateApiKey', request.request_id, facts)) return this.key(request.api_key_id);
    if (this.store.db.prepare('SELECT id FROM identity_keys WHERE id=? OR verifier=?').get(request.api_key_id, digest(request.secret))) refuse('identity_conflict');
    const image: ApiKey = { api_key_id: request.api_key_id, operator_id: request.operator_id ?? null, created_at: now(), revoked_at: null };
    this.store.db.prepare('INSERT INTO identity_keys VALUES(?,?,?,?)').run(image.api_key_id, JSON.stringify(image), digest(request.secret), assetId);
    tx.remember('setup/CreateApiKey', request.request_id, facts);
    this.activity(tx, 'credential', 'Credential created');
    return image;
  }
  revoke(tx: Transaction, keyId: Uuid): ApiKey {
    const image = this.key(keyId);
    if (image.revoked_at === null) {
      image.revoked_at = now();
      this.store.db.prepare('UPDATE identity_keys SET image=? WHERE id=?').run(JSON.stringify(image), keyId);
      tx.dirty = true;
      this.activity(tx, 'credential', 'Credential revoked');
    }
    return image;
  }
  revokeKey(tx: Transaction, request: RequestOf<'RevokeApiKey'>): ApiKey {
    if (tx.retry('setup/RevokeApiKey', request.request_id, request)) return this.key(request.api_key_id);
    const image = this.revoke(tx, request.api_key_id);
    tx.remember('setup/RevokeApiKey', request.request_id, request);
    return image;
  }
  revokeAsset(tx: Transaction, assetId: Uuid): void {
    this.revokeMatching(tx, 'asset', assetId);
  }
  private revokeMatching(tx: Transaction, kind: 'asset' | 'operator', owner: Uuid): void {
    let after = '';
    while (true) {
      const values = kind === 'asset'
        ? this.store.db.prepare('SELECT image,verifier,asset_id FROM identity_keys WHERE asset_id=? AND id>? ORDER BY id LIMIT 32').all(owner, after)
        : this.store.db.prepare("SELECT image,verifier,asset_id FROM identity_keys WHERE json_extract(image,'$.operator_id')=? AND id>? ORDER BY id LIMIT 32").all(owner, after);
      for (const value of values) {
        const image = ApiKey.parse(JSON.parse(KeyRow.parse(value).image));
        this.revoke(tx, image.api_key_id); after = image.api_key_id;
      }
      if (values.length < 32) break;
    }
  }
  activity(tx: Transaction, category: string, message: string): void {
    const entry: Activity = { activity_id: id(), at: now(), category, message,
      api_key_id: tx.authority?.keyId ?? null, operator_id: tx.authority?.operatorId ?? null,
      operator_deleted: tx.authority?.operatorId !== null && tx.authority?.operatorId !== undefined && !this.operatorExists(tx.authority.operatorId) };
    this.store.db.prepare('INSERT INTO identity_activity VALUES(?,?)').run(entry.activity_id, JSON.stringify(entry));
    tx.dirty = true;
  }
  keys(after: string, limit: number): ApiKey[] {
    return this.store.db.prepare('SELECT image FROM identity_keys WHERE id>? ORDER BY id LIMIT ?').all(after, limit)
      .map(row => ApiKey.parse(JSON.parse(JsonRow.parse(row).image)));
  }
  operators(after: string, limit: number): Operator[] {
    return this.store.db.prepare('SELECT image FROM identity_operators WHERE deleted=0 AND id>? ORDER BY id LIMIT ?').all(after, limit)
      .map(row => Operator.parse(JSON.parse(JsonRow.parse(row).image)));
  }
  activities(after: string, limit: number): Activity[] {
    return this.store.db.prepare('SELECT image FROM identity_activity WHERE id>? ORDER BY id LIMIT ?').all(after, limit)
      .map(row => {
        const image = Activity.parse(JSON.parse(JsonRow.parse(row).image));
        if (image.operator_id !== null) image.operator_deleted = !this.operatorExists(image.operator_id);
        return image;
      });
  }
  clearDataset(hard: boolean): void {
    this.store.db.exec('DELETE FROM identity_activity');
    if (hard) this.store.db.exec('DELETE FROM identity_keys; DELETE FROM identity_operators');
  }
}
