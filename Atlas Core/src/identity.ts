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
      CREATE TABLE IF NOT EXISTS identity_activity(id TEXT PRIMARY KEY,image TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS identity_asset_bindings(key_id TEXT PRIMARY KEY,asset_id TEXT NOT NULL,dataset_id TEXT NOT NULL,request_id TEXT NOT NULL UNIQUE,open_binding TEXT UNIQUE) STRICT;`);
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
  createKey(tx: Transaction, request: RequestOf<'CreateApiKey'>, assetId: Uuid | null = null, recordActivity = true): ApiKey {
    if (request.operator_id !== undefined && !this.operatorExists(request.operator_id)) refuse('operator_deleted');
    const facts = credentialFacts(request);
    if (tx.retry('setup/CreateApiKey', request.request_id, facts)) return this.key(request.api_key_id);
    if (this.store.db.prepare('SELECT id FROM identity_keys WHERE id=? OR verifier=?').get(request.api_key_id, digest(request.secret))) refuse('identity_conflict');
    const image: ApiKey = { api_key_id: request.api_key_id, operator_id: request.operator_id ?? null, created_at: now(), revoked_at: null };
    this.store.db.prepare('INSERT INTO identity_keys VALUES(?,?,?,?)').run(image.api_key_id, JSON.stringify(image), digest(request.secret), assetId);
    if (assetId !== null) this.store.db.prepare('INSERT INTO identity_asset_bindings VALUES(?,?,?,?,NULL)').run(image.api_key_id, assetId, this.store.dataset, request.request_id);
    tx.remember('setup/CreateApiKey', request.request_id, facts);
    if (recordActivity) this.activity(tx, 'credential', tx.authority === null ? 'Local administrator created credential' : 'Credential created');
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
        ? this.store.db.prepare('SELECT k.image,k.verifier,k.asset_id FROM identity_keys k JOIN identity_asset_bindings b ON b.key_id=k.id WHERE b.asset_id=? AND b.dataset_id=? AND k.id>? ORDER BY k.id LIMIT 32').all(owner, this.store.dataset, after)
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
    if (hard) this.store.db.exec('DELETE FROM identity_keys; DELETE FROM identity_operators; DELETE FROM identity_asset_bindings');
  }
  checkRegistration(request: Uuid): void {
    const row = this.store.db.prepare('SELECT dataset_id FROM identity_asset_bindings WHERE request_id=?').get(request);
    if (row && z.object({ dataset_id: Uuid }).parse(row).dataset_id !== this.store.dataset) refuse('identity_conflict');
  }
  markOpen(keyId: Uuid): Uuid {
    const row = z.object({ open_binding: Uuid.nullable() }).parse(this.store.db.prepare('SELECT open_binding FROM identity_asset_bindings WHERE key_id=?').get(keyId));
    if (row.open_binding !== null) return row.open_binding;
    if (this.openBindings().length >= 128) refuse('resource_limit');
    const binding = id(); this.store.db.prepare('UPDATE identity_asset_bindings SET open_binding=? WHERE key_id=?').run(binding, keyId);
    return binding;
  }
  openBinding(key: Uuid): Uuid | null | undefined {
    const row = this.store.db.prepare('SELECT open_binding FROM identity_asset_bindings WHERE key_id=?').get(key);
    return row === undefined ? undefined : z.object({ open_binding: Uuid.nullable() }).parse(row).open_binding;
  }
  openBindings() {
    return this.store.db.prepare("SELECT b.open_binding AS binding_id,b.key_id AS api_key_id,b.asset_id,b.dataset_id FROM identity_asset_bindings b JOIN identity_keys k ON k.id=b.key_id WHERE b.open_binding IS NOT NULL AND json_extract(k.image,'$.revoked_at') IS NULL ORDER BY b.open_binding LIMIT 1000").all().map(row => z.object({ binding_id: Uuid, api_key_id: Uuid, asset_id: Uuid, dataset_id: Uuid }).parse(row));
  }
  revokeOpen(tx: Transaction, binding: Uuid, key: Uuid): void {
    if (!this.store.db.prepare('SELECT key_id FROM identity_asset_bindings WHERE open_binding=? AND key_id=?').get(binding, key)) refuse('identity_conflict');
    this.revoke(tx, key);
  }
}
