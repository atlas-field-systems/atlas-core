import type Database from 'better-sqlite3';
import { z } from 'zod';
import { caseFold } from 'unicode-case-folding';
import { Asset, ContactChallenge, Geofeature, Observation, Track, Uuid, readSections } from '@atlas/protocol';
import type { AssetReport, InputSection, ObservationReport, RequestOf, SectionName } from '@atlas/protocol';
import { credentialFacts, id, instant, next, now, zero } from './exact.js';
import { Evidence, eligible, evidenceFor } from './evidence.js';
import { Refusal, refuse } from './fault.js';
import type { Store, Transaction } from './database.js';
import type { Identity } from './identity.js';
import type { Temporary } from './temporary.js';

const ImageRow = z.object({ image: z.string() });
const EntityRow = z.object({ kind: z.enum(['asset', 'observation', 'track', 'geofeature']), alive: z.number() });
const ContactData = z.object({ challenge: ContactChallenge, deadline: z.number(), consumed: z.string().nullable() });
type Entity = Asset | Observation | Track | Geofeature;
function sourced<S extends z.ZodType>(schema: S, value: InputSection<SectionName>, report: AssetReport | ObservationReport, section: SectionName): z.output<S> {
  return schema.parse({ ...value, evidence: evidenceFor(report, section) });
}
export class Entities {
  private readonly contact = new Map<Uuid, number>();
  constructor(private readonly store: Store, private readonly identity: Identity, readonly evidence: Evidence, private readonly temporary: Temporary) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS entity_identity(id TEXT PRIMARY KEY,kind TEXT NOT NULL,alive INTEGER NOT NULL,alias_fold TEXT UNIQUE) STRICT;
      CREATE TABLE IF NOT EXISTS entity_assets(id TEXT PRIMARY KEY,image TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS entity_observations(id TEXT PRIMARY KEY,image TEXT NOT NULL,publisher TEXT NOT NULL,subject TEXT,UNIQUE(publisher,subject)) STRICT;
      CREATE TABLE IF NOT EXISTS entity_tracks(id TEXT PRIMARY KEY,image TEXT NOT NULL,observation TEXT NOT NULL UNIQUE) STRICT;
      CREATE TABLE IF NOT EXISTS entity_geofeatures(id TEXT PRIMARY KEY,image TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS entity_generations(asset TEXT NOT NULL,generation TEXT NOT NULL,PRIMARY KEY(asset,generation)) STRICT;
      CREATE TABLE IF NOT EXISTS entity_process_retries(request TEXT PRIMARY KEY,image TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS entity_registrations(id TEXT PRIMARY KEY,asset TEXT NOT NULL UNIQUE) STRICT;`);
  }
  private allocate(id: Uuid, kind: Entity['entity_type'], alias?: string): void {
    if (this.store.db.prepare('SELECT id FROM entity_identity WHERE id=?').get(id)) refuse('identity_conflict');
    if (alias !== undefined && this.store.db.prepare('SELECT id FROM entity_identity WHERE alias_fold=?').get(caseFold(alias))) refuse('identity_conflict');
    this.store.db.prepare('INSERT INTO entity_identity VALUES(?,?,1,?)').run(id, kind, alias === undefined ? null : caseFold(alias));
  }
  private rename(image: Entity): void {
    const folded = image.alias === undefined ? null : caseFold(image.alias);
    if (folded !== null && this.store.db.prepare('SELECT id FROM entity_identity WHERE alias_fold=? AND id<>?').get(folded, image.id)) refuse('identity_conflict');
    this.store.db.prepare('UPDATE entity_identity SET alias_fold=? WHERE id=?').run(folded, image.id);
  }
  private live(id: Uuid, kind: Entity['entity_type']): void {
    const row = this.store.db.prepare('SELECT kind,alive FROM entity_identity WHERE id=?').get(id);
    if (!row || EntityRow.parse(row).kind !== kind || !EntityRow.parse(row).alive) refuse(kind === 'asset' ? 'asset_not_found' : 'entity_not_found');
  }
  known(id: Uuid, kind: Entity['entity_type']): boolean {
    const row = this.store.db.prepare('SELECT kind,alive FROM entity_identity WHERE id=?').get(id);
    return row !== undefined && EntityRow.parse(row).kind === kind;
  }
  isLive(id: Uuid, kind: Entity['entity_type']): boolean {
    const row = this.store.db.prepare('SELECT kind,alive FROM entity_identity WHERE id=?').get(id);
    if (row === undefined) return false;
    const identity = EntityRow.parse(row);
    return identity.kind === kind && identity.alive !== 0;
  }
  asset(id: Uuid): Asset {
    this.live(id, 'asset');
    return Asset.parse(JSON.parse(ImageRow.parse(this.store.db.prepare('SELECT image FROM entity_assets WHERE id=?').get(id)).image));
  }
  observation(id: Uuid): Observation {
    this.live(id, 'observation');
    return Observation.parse(JSON.parse(ImageRow.parse(this.store.db.prepare('SELECT image FROM entity_observations WHERE id=?').get(id)).image));
  }
  track(id: Uuid): Track {
    this.live(id, 'track');
    return Track.parse(JSON.parse(ImageRow.parse(this.store.db.prepare('SELECT image FROM entity_tracks WHERE id=?').get(id)).image));
  }
  geofeature(id: Uuid): Geofeature {
    this.live(id, 'geofeature');
    return Geofeature.parse(JSON.parse(ImageRow.parse(this.store.db.prepare('SELECT image FROM entity_geofeatures WHERE id=?').get(id)).image));
  }
  byAlias(kind: Entity['entity_type'], alias: string): Uuid {
    const row = this.store.db.prepare('SELECT id FROM entity_identity WHERE kind=? AND alive=1 AND alias_fold=?').get(kind, caseFold(alias));
    if (!row) refuse(kind === 'asset' ? 'asset_not_found' : 'entity_not_found');
    return z.object({ id: Uuid }).parse(row).id;
  }
  saveAsset(tx: Transaction, value: Asset, required = false): Asset {
    const image = Asset.parse(value);
    if (!required && Buffer.byteLength(JSON.stringify(image)) > this.store.settings.resourceImageBytes - 1024) refuse('resource_limit');
    this.rename(image);
    this.store.db.prepare('UPDATE entity_assets SET image=? WHERE id=?').run(JSON.stringify(image), image.id);
    tx.change({ kind: 'put', resource_kind: 'asset', resource_id: image.id, version: image.version, image });
    return image;
  }
  private saveObservation(value: Observation): Observation {
    const image = Observation.parse(value);
    if (Buffer.byteLength(JSON.stringify(image)) > this.store.settings.resourceImageBytes) refuse('resource_limit');
    this.rename(image);
    this.store.db.prepare('UPDATE entity_observations SET image=? WHERE id=?').run(JSON.stringify(image), image.id);
    return image;
  }
  private saveTrack(tx: Transaction, value: Track): Track {
    const image = Track.parse(value);
    this.rename(image);
    this.store.db.prepare('UPDATE entity_tracks SET image=? WHERE id=?').run(JSON.stringify(image), image.id);
    tx.change({ kind: 'put', resource_kind: 'track', resource_id: image.id, version: image.version, image });
    return image;
  }
  private saveGeofeature(tx: Transaction, value: Geofeature): Geofeature {
    const image = Geofeature.parse(value);
    this.rename(image);
    this.store.db.prepare('UPDATE entity_geofeatures SET image=? WHERE id=?').run(JSON.stringify(image), image.id);
    tx.change({ kind: 'put', resource_kind: 'geofeature', resource_id: image.id, version: image.version, image });
    return image;
  }
  register(tx: Transaction, request: RequestOf<'RegisterAsset'>) {
    this.identity.checkRegistration(request.request_id);
    if (this.known(request.asset_id, 'asset')) this.asset(request.asset_id);
    if (tx.retry('RegisterAsset', request.request_id, credentialFacts(request))) return { asset: this.asset(request.asset_id), api_key: this.identity.key(request.api_key_id) };
    if (this.store.db.prepare('SELECT id FROM entity_registrations WHERE id=? OR asset=?').get(request.registration_id, request.asset_id)) refuse('identity_conflict');
    this.allocate(request.asset_id, 'asset', request.alias);
    const asset: Asset = { dataset_id: this.store.dataset, id: request.asset_id, entity_type: 'asset', version: zero, edit_revision: zero,
      ...(request.alias === undefined ? {} : { alias: request.alias }), ...(request.description === undefined ? {} : { description: request.description }),
      type: request.type ?? { kind: null }, capabilities: request.capabilities ?? { commands: [] }, process_generation: request.process_generation,
      status: { state: 'value', classification: 'state_until_changed', observed_at: null, evidence: null, value: { condition: 'unknown' } },
      communications: { health: 'offline', capacity: { state: 'value', classification: 'state_until_changed', observed_at: null, evidence: null, value: { bandwidth_bps: null } } },
      heartbeat: { last_contact_at: null }, task_queue: { requested_task_ids: [], revision: zero, confirmed: null },
      task_control: { revision: zero, requested: null, confirmed: null } };
    this.store.db.prepare('INSERT INTO entity_assets VALUES(?,?)').run(asset.id, JSON.stringify(asset));
    this.store.db.prepare('INSERT INTO entity_generations VALUES(?,?)').run(asset.id, asset.process_generation);
    this.store.db.prepare('INSERT INTO entity_registrations VALUES(?,?)').run(request.registration_id, asset.id);
    const key = this.identity.createKey(tx, { request_id: request.request_id, api_key_id: request.api_key_id, secret: request.secret }, asset.id);
    tx.remember('RegisterAsset', request.request_id, credentialFacts(request));
    return { asset: this.saveAsset(tx, asset), api_key: key };
  }
  update(tx: Transaction, request: RequestOf<'UpdateAsset'>) {
    const asset = this.asset(request.asset_id);
    if (tx.retry('UpdateAsset', request.request_id, request)) return { asset, ...(request.report === undefined ? {} : { evidence_disposition: 'duplicate' as const }) };
    const authored = request.alias !== undefined || request.description !== undefined || request.type !== undefined || request.capabilities !== undefined;
    if (authored && request.expected_edit_revision !== asset.edit_revision) refuse('edit_conflict');
    let disposition: 'accepted' | 'duplicate' | undefined;
    let changed = authored;
    if (request.report) {
      const result = this.assetReport(tx, asset, request.report);
      disposition = result.disposition;
      changed ||= result.changed;
    }
    if (authored) {
      if (request.alias === null) delete asset.alias;
      else if (request.alias !== undefined) asset.alias = request.alias;
      if (request.description === null) delete asset.description;
      else if (request.description !== undefined) asset.description = request.description;
      if (request.type !== undefined) asset.type = request.type;
      if (request.capabilities !== undefined) asset.capabilities = request.capabilities;
      asset.edit_revision = next(asset.edit_revision);
    }
    if (changed) { asset.version = next(asset.version); this.saveAsset(tx, asset); }
    if (authored || disposition === 'accepted') tx.remember('UpdateAsset', request.request_id, request);
    return { asset, ...(disposition === undefined ? {} : { evidence_disposition: disposition }) };
  }
  private assetReport(tx: Transaction, asset: Asset, report: AssetReport): { disposition: 'accepted' | 'duplicate'; changed: boolean } {
    if (report.dataset_id !== this.store.dataset) refuse('dataset_mismatch');
    if (this.evidence.duplicate(report)) return { disposition: 'duplicate', changed: false };
    if (report.origin.process_generation !== asset.process_generation) refuse('generation_mismatch');
    this.evidence.admit(tx, report, 'asset');
    let changed = false;
    const s = report.sections;
    if (s.status && eligible(asset.status, report)) { asset.status = sourced(readSections.status, s.status, report, 'status'); changed = true; }
    if (s.communications && eligible(asset.communications.capacity, report)) { asset.communications.capacity = sourced(readSections.communications, s.communications, report, 'communications'); changed = true; }
    if (s.telemetry && eligible(asset.telemetry, report)) { asset.telemetry = sourced(readSections.telemetry, s.telemetry, report, 'telemetry'); changed = true; }
    if (s.attitude && eligible(asset.attitude, report)) { asset.attitude = sourced(readSections.attitude, s.attitude, report, 'attitude'); changed = true; }
    if (s.power && eligible(asset.power, report)) { asset.power = sourced(readSections.power, s.power, report, 'power'); changed = true; }
    if (s.camera && eligible(asset.camera, report)) { asset.camera = sourced(readSections.camera, s.camera, report, 'camera'); changed = true; }
    if (s.camera_optics && eligible(asset.camera_optics, report)) { asset.camera_optics = sourced(readSections.camera_optics, s.camera_optics, report, 'camera_optics'); changed = true; }
    if (s.gimbal && eligible(asset.gimbal, report)) { asset.gimbal = sourced(readSections.gimbal, s.gimbal, report, 'gimbal'); changed = true; }
    if (report.mode === 'current' && report.contact_proof !== undefined) {
      this.prove(tx, asset, report, report.contact_proof.challenge_id);
      changed = true;
    }
    return { disposition: 'accepted', changed };
  }
  begin(tx: Transaction, request: RequestOf<'BeginAssetContact'>): ContactChallenge {
    const asset = this.asset(request.asset_id);
    const allocation = this.temporary.validateContext(request.allocation_context);
    const contacts = this.temporary.receipts('contact');
    for (const receipt of contacts) {
      if (receipt.state === 'ready' && ContactData.parse(JSON.parse(receipt.data)).deadline <= performance.now()) this.temporary.set({ ...receipt, state: 'consumed' });
    }
    const existing = contacts.find(receipt => {
      const data = ContactData.parse(JSON.parse(receipt.data));
      return receipt.context === allocation.context && receipt.request === request.request_id ||
        data.challenge.asset_id === asset.id && receipt.state === 'ready' && data.deadline > performance.now();
    });
    if (existing && (existing.context !== allocation.context || existing.request !== request.request_id)) refuse('contact_busy');
    const reserved = this.temporary.reserve('contact', request.allocation_context, request.request_id, request);
    if (!reserved.fresh) return ContactData.parse(JSON.parse(reserved.receipt.data)).challenge;
    tx.retainedBytes += Buffer.byteLength(JSON.stringify(request)) + 16384;
    if (request.mode === 'current' ? request.process_generation !== asset.process_generation : request.expected_process_generation !== asset.process_generation) refuse('generation_mismatch');
    if (request.mode === 'replace' && this.store.db.prepare('SELECT generation FROM entity_generations WHERE asset=? AND generation=?').get(asset.id, request.process_generation)) refuse('generation_mismatch');
    const issued = now();
    const duration = Math.min(10_000, Math.floor(reserved.receipt.deadline - performance.now()));
    if (duration < 1) refuse('allocation_expired');
    const challenge = ContactChallenge.parse({ challenge_id: reserved.receipt.id, asset_id: asset.id, process_generation: request.process_generation,
      mode: request.mode, core_run_id: this.store.run, issued_at: issued, expires_at: new Date(Date.parse(issued) + duration).toISOString(),
      ...(request.mode === 'replace' ? { expected_process_generation: request.expected_process_generation } : {}) });
    this.temporary.set({ ...reserved.receipt, state: 'ready', data: JSON.stringify({ challenge, deadline: performance.now() + duration, consumed: null }) });
    return challenge;
  }
  private prove(tx: Transaction, asset: Asset, report: AssetReport, challengeId: Uuid): void {
    let receipt;
    try { receipt = this.temporary.get(challengeId); }
    catch (error) { if (error instanceof Refusal && error.code === 'allocation_expired') refuse('challenge_expired'); throw error; }
    if (receipt.kind !== 'contact') refuse('challenge_context_mismatch');
    const data = ContactData.parse(JSON.parse(receipt.data));
    if (data.consumed !== null) refuse('challenge_consumed');
    const c = data.challenge;
    if (performance.now() >= data.deadline) refuse('challenge_expired');
    if (c.asset_id !== asset.id || c.process_generation !== asset.process_generation || report.generated_at === null ||
      instant(report.generated_at) < instant(c.issued_at) || instant(report.generated_at) >= instant(c.expires_at)) refuse('challenge_context_mismatch');
    this.temporary.set({ ...receipt, state: 'consumed', data: JSON.stringify({ ...data, consumed: report.report_id }) });
    asset.heartbeat.last_contact_at = now();
    asset.communications.health = 'healthy';
    const contacted = performance.now();
    tx.committed.push(() => { this.contact.set(asset.id, contacted); this.store.metrics.contact_refreshes++; });
  }
  replace(tx: Transaction, request: RequestOf<'ReplaceAssetProcess'>) {
    const asset = this.asset(request.asset_id);
    if (tx.retry('ReplaceAssetProcess', request.request_id, request)) {
      const row = ImageRow.parse(this.store.db.prepare('SELECT image FROM entity_process_retries WHERE request=?').get(request.request_id));
      return { asset: Asset.parse(JSON.parse(row.image)), evidence_disposition: 'duplicate' as const };
    }
    if (asset.process_generation !== request.expected_process_generation || this.store.db.prepare('SELECT generation FROM entity_generations WHERE asset=? AND generation=?').get(asset.id, request.process_generation)) refuse('generation_mismatch');
    let receipt;
    try { receipt = this.temporary.get(request.challenge_id); } catch { refuse('challenge_expired'); }
    if (receipt.kind !== 'contact') refuse('challenge_context_mismatch');
    const c = ContactData.parse(JSON.parse(receipt.data)).challenge;
    if (c.mode !== 'replace' || c.expected_process_generation !== request.expected_process_generation) refuse('challenge_context_mismatch');
    asset.process_generation = request.process_generation;
    this.store.db.prepare('INSERT INTO entity_generations VALUES(?,?)').run(asset.id, asset.process_generation);
    const report = this.assetReport(tx, asset, request.first_report);
    if (report.disposition !== 'accepted') refuse('challenge_consumed');
    asset.version = next(asset.version);
    this.saveAsset(tx, asset);
    const image = JSON.stringify(asset);
    tx.retainedBytes += Buffer.byteLength(image);
    this.store.db.prepare('INSERT INTO entity_process_retries VALUES(?,?)').run(request.request_id, image);
    tx.remember('ReplaceAssetProcess', request.request_id, request);
    return { asset, evidence_disposition: 'accepted' as const };
  }
  deleteAsset(tx: Transaction, request: RequestOf<'DeleteAsset'>): { deleted: true } {
    if (tx.retry('DeleteAsset', request.request_id, request)) return { deleted: true };
    const asset = this.asset(request.asset_id);
    this.identity.revokeAsset(tx, asset.id);
    this.store.db.prepare('UPDATE entity_identity SET alive=0,alias_fold=NULL WHERE id=?').run(asset.id);
    tx.committed.push(() => this.contact.delete(asset.id));
    tx.change({ kind: 'delete', resource_kind: 'asset', resource_id: asset.id, version: next(asset.version) });
    tx.remember('DeleteAsset', request.request_id, request);
    this.identity.activity(tx, 'asset', 'Asset deleted');
    return { deleted: true };
  }
  createObservation(tx: Transaction, request: RequestOf<'CreateObservation'>) {
    if (tx.retry('CreateObservation', request.request_id, request)) {
      const observation = this.observation(request.observation_id);
      return { observation, track: this.track(observation.track_id), ...(request.report ? { evidence_disposition: 'duplicate' as const } : {}) };
    }
    if (request.source_asset_id !== undefined) this.asset(request.source_asset_id);
    const subject = request.publisher_subject === undefined ? null : JSON.stringify([request.publisher_subject.id, request.publisher_subject.lifetime_id]);
    if (subject !== null && this.store.db.prepare('SELECT id FROM entity_observations WHERE publisher=? AND subject=?').get(request.publisher_id, subject)) refuse('identity_conflict');
    const trackId = id();
    this.allocate(request.observation_id, 'observation', request.alias);
    this.allocate(trackId, 'track');
    const observation: Observation = { dataset_id: this.store.dataset, id: request.observation_id, entity_type: 'observation', version: zero, edit_revision: zero,
      publisher_id: request.publisher_id, track_id: trackId,
      ...(request.source_asset_id === undefined ? {} : { source_asset_id: request.source_asset_id }),
      ...(request.publisher_subject === undefined ? {} : { publisher_subject: request.publisher_subject }),
      ...(request.alias === undefined ? {} : { alias: request.alias }), ...(request.description === undefined ? {} : { description: request.description }),
      type: { state: 'value', classification: 'state_until_changed', observed_at: null, evidence: null, value: { kind: null } } };
    if (request.report) this.observationReport(tx, observation, request.report);
    const track = this.fuse(observation);
    this.store.db.prepare('INSERT INTO entity_observations VALUES(?,?,?,?)').run(observation.id, JSON.stringify(Observation.parse(observation)), observation.publisher_id, subject);
    this.store.db.prepare('INSERT INTO entity_tracks VALUES(?,?,?)').run(track.id, JSON.stringify(track), observation.id);
    this.saveTrack(tx, track);
    tx.remember('CreateObservation', request.request_id, request);
    return { observation, track, ...(request.report ? { evidence_disposition: 'accepted' as const } : {}) };
  }
  private fuse(observation: Observation, old?: Track): Track {
    return { dataset_id: observation.dataset_id, id: observation.track_id, entity_type: 'track', version: old ? next(old.version) : zero,
      edit_revision: old?.edit_revision ?? zero, ...(old?.alias === undefined ? {} : { alias: old.alias }), ...(old?.description === undefined ? {} : { description: old.description }),
      sources: [{ observation_id: observation.id, publisher_id: observation.publisher_id, ...(observation.source_asset_id === undefined ? {} : { source_asset_id: observation.source_asset_id }) }],
      type: observation.type, ...(observation.telemetry === undefined ? {} : { telemetry: observation.telemetry }),
      ...(observation.attitude === undefined ? {} : { attitude: observation.attitude }), ...(observation.geometry === undefined ? {} : { geometry: observation.geometry }) };
  }
  private observationReport(tx: Transaction, observation: Observation, report: ObservationReport): boolean {
    if (report.dataset_id !== this.store.dataset) refuse('dataset_mismatch');
    if (report.origin.publisher_id !== observation.publisher_id) refuse('identity_conflict');
    this.evidence.admit(tx, report, 'observation');
    let changed = false;
    const s = report.sections;
    if (s.type && eligible(observation.type, report)) { observation.type = sourced(readSections.type, s.type, report, 'type'); changed = true; }
    if (s.telemetry && eligible(observation.telemetry, report)) { observation.telemetry = sourced(readSections.telemetry, s.telemetry, report, 'telemetry'); changed = true; }
    if (s.attitude && eligible(observation.attitude, report)) { observation.attitude = sourced(readSections.attitude, s.attitude, report, 'attitude'); changed = true; }
    if (s.geometry && eligible(observation.geometry, report)) { observation.geometry = sourced(readSections.geometry, s.geometry, report, 'geometry'); changed = true; }
    return changed;
  }
  reportObservation(tx: Transaction, request: RequestOf<'ReportObservation'>) {
    const observation = this.observation(request.observation_id);
    if (request.publisher_id !== observation.publisher_id) refuse('identity_conflict');
    let track = this.track(observation.track_id);
    if (this.evidence.duplicate(request.report)) return { observation, track, evidence_disposition: 'duplicate' as const };
    if (this.observationReport(tx, observation, request.report)) {
      observation.version = next(observation.version);
      this.saveObservation(observation);
      track = this.saveTrack(tx, this.fuse(observation, track));
    }
    return { observation, track, evidence_disposition: 'accepted' as const };
  }
  editObservation(tx: Transaction, request: RequestOf<'EditObservation'>): Observation {
    const image = this.observation(request.observation_id);
    if (tx.retry('EditObservation', request.request_id, request)) return image;
    this.descriptive(image, request.expected_edit_revision, request.edits);
    tx.remember('EditObservation', request.request_id, request);
    return this.saveObservation(image);
  }
  editTrack(tx: Transaction, request: RequestOf<'EditTrack'>): Track {
    const image = this.track(request.track_id);
    if (tx.retry('EditTrack', request.request_id, request)) return image;
    this.descriptive(image, request.expected_edit_revision, request.edits);
    tx.remember('EditTrack', request.request_id, request);
    return this.saveTrack(tx, image);
  }
  private descriptive(image: Observation | Track | Geofeature, expected: string, edits: RequestOf<'EditTrack'>['edits']): void {
    if (image.edit_revision !== expected) refuse('edit_conflict');
    if (edits.alias === null) delete image.alias;
    else if (edits.alias !== undefined) image.alias = edits.alias;
    if (edits.description === null) delete image.description;
    else if (edits.description !== undefined) image.description = edits.description;
    image.edit_revision = next(image.edit_revision);
    image.version = next(image.version);
  }
  createGeofeature(tx: Transaction, request: RequestOf<'CreateGeofeature'>): Geofeature {
    if (this.known(request.geofeature_id, 'geofeature')) this.geofeature(request.geofeature_id);
    if (tx.retry('CreateGeofeature', request.request_id, request)) return this.geofeature(request.geofeature_id);
    this.allocate(request.geofeature_id, 'geofeature', request.alias);
    const image: Geofeature = { dataset_id: this.store.dataset, id: request.geofeature_id, entity_type: 'geofeature', version: zero, edit_revision: zero, geometry_revision: zero,
      geometry: request.geometry, type: request.type ?? { kind: null }, ...(request.alias === undefined ? {} : { alias: request.alias }), ...(request.description === undefined ? {} : { description: request.description }) };
    this.store.db.prepare('INSERT INTO entity_geofeatures VALUES(?,?)').run(image.id, JSON.stringify(image));
    tx.remember('CreateGeofeature', request.request_id, request);
    return this.saveGeofeature(tx, image);
  }
  editGeofeature(tx: Transaction, request: RequestOf<'EditGeofeature'>): Geofeature {
    const image = this.geofeature(request.geofeature_id);
    if (tx.retry('EditGeofeature', request.request_id, request)) return image;
    this.descriptive(image, request.expected_edit_revision, request.edits);
    if (request.edits.type !== undefined) image.type = request.edits.type;
    if (request.edits.geometry !== undefined) { image.geometry = request.edits.geometry; image.geometry_revision = next(image.geometry_revision); }
    tx.remember('EditGeofeature', request.request_id, request);
    return this.saveGeofeature(tx, image);
  }
  deleteGeofeature(tx: Transaction, request: RequestOf<'DeleteGeofeature'>, guarded: (id: Uuid) => boolean): { deleted: true } {
    if (tx.retry('DeleteGeofeature', request.request_id, request)) return { deleted: true };
    const image = this.geofeature(request.geofeature_id);
    if (guarded(image.id)) refuse('identity_conflict');
    this.store.db.prepare('UPDATE entity_identity SET alive=0,alias_fold=NULL WHERE id=?').run(image.id);
    tx.change({ kind: 'delete', resource_kind: 'geofeature', resource_id: image.id, version: next(image.version) });
    tx.remember('DeleteGeofeature', request.request_id, request);
    return { deleted: true };
  }
  restartContact(): void {
    let after = '';
    while (true) {
      const batch = this.assets(after, 16);
      for (const image of batch) {
        if (image.communications.health !== 'offline' || image.heartbeat.last_contact_at !== null) {
          image.communications.health = 'offline'; image.heartbeat.last_contact_at = null;
          image.version = next(image.version); this.store.transact(null, tx => this.saveAsset(tx, image, true));
        }
        after = image.id;
      }
      if (batch.length < 16) break;
    }
  }
  tick(): void {
    for (const [assetId, at] of this.contact) {
      const elapsed = performance.now() - at;
      const health = elapsed < 15_000 ? 'healthy' : elapsed < 60_000 ? 'degraded' : 'offline';
      const asset = this.asset(assetId);
      if (health !== asset.communications.health) this.store.transact(null, tx => { asset.communications.health = health; asset.version = next(asset.version); this.saveAsset(tx, asset, true); });
      if (health === 'offline') this.contact.delete(assetId);
    }
  }
  assets(after: string, limit: number): Asset[] {
    return this.store.db.prepare('SELECT a.image FROM entity_assets a JOIN entity_identity i ON i.id=a.id WHERE i.alive=1 AND a.id>? ORDER BY a.id LIMIT ?').all(after, limit).map(row => Asset.parse(JSON.parse(ImageRow.parse(row).image)));
  }
  observations(after: string, limit: number): Observation[] {
    return this.store.db.prepare('SELECT image FROM entity_observations WHERE id>? ORDER BY id LIMIT ?').all(after, limit).map(row => Observation.parse(JSON.parse(ImageRow.parse(row).image)));
  }
  trackObservations(track: Uuid, after: string, limit: number): Observation[] {
    this.track(track);
    return this.store.db.prepare('SELECT o.image FROM entity_tracks t JOIN entity_observations o ON o.id=t.observation WHERE t.id=? AND o.id>? ORDER BY o.id LIMIT ?')
      .all(track, after, limit).map(row => Observation.parse(JSON.parse(ImageRow.parse(row).image)));
  }
  tracks(after: string, limit: number): Track[] {
    return this.store.db.prepare('SELECT image FROM entity_tracks WHERE id>? ORDER BY id LIMIT ?').all(after, limit).map(row => Track.parse(JSON.parse(ImageRow.parse(row).image)));
  }
  geofeatures(after: string, limit: number): Geofeature[] {
    return this.store.db.prepare('SELECT a.image FROM entity_geofeatures a JOIN entity_identity i ON i.id=a.id WHERE i.alive=1 AND a.id>? ORDER BY a.id LIMIT ?').all(after, limit).map(row => Geofeature.parse(JSON.parse(ImageRow.parse(row).image)));
  }
  *picture(source: Database.Database): Generator<Asset | Track | Geofeature> {
    for (const row of source.prepare('SELECT a.image FROM entity_assets a JOIN entity_identity i ON i.id=a.id WHERE i.alive=1 ORDER BY a.id').iterate()) yield Asset.parse(JSON.parse(ImageRow.parse(row).image));
    for (const row of source.prepare('SELECT a.image FROM entity_geofeatures a JOIN entity_identity i ON i.id=a.id WHERE i.alive=1 ORDER BY a.id').iterate()) yield Geofeature.parse(JSON.parse(ImageRow.parse(row).image));
    for (const row of source.prepare('SELECT image FROM entity_tracks ORDER BY id').iterate()) yield Track.parse(JSON.parse(ImageRow.parse(row).image));
  }
  sourceForHistory(kind: 'asset' | 'observation' | 'track', entity: Uuid): { source: Uuid; tracks: Uuid[] } {
    if (!this.known(entity, kind)) refuse('entity_not_found');
    if (kind === 'track') {
      const track = this.track(entity);
      const source = track.sources[0];
      if (!source) throw new Error('missing_track_source');
      return { source: source.observation_id, tracks: [entity] };
    }
    return { source: entity, tracks: kind === 'observation' ? [this.observation(entity).track_id] : [] };
  }
  clearDataset(): void {
    this.store.db.exec('DELETE FROM entity_process_retries; DELETE FROM entity_registrations; DELETE FROM entity_generations; DELETE FROM entity_tracks; DELETE FROM entity_observations; DELETE FROM entity_assets; DELETE FROM entity_geofeatures; DELETE FROM entity_identity');
    this.contact.clear();
  }
}
