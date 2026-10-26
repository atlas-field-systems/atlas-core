import { join } from 'node:path';
import { z } from 'zod';
import { PROTOCOL_VERSION, Secret, Uuid, exchanges } from '@atlas/protocol';
import { exportReference } from '@atlas/protocol/reference';
import type { ExchangeName, RequestOf, ResponseOf } from '@atlas/protocol';
import { Store } from './database.js';
import type { Transaction } from './database.js';
import { Identity } from './identity.js';
import { Evidence } from './evidence.js';
import { Entities } from './entities.js';
import { Tasks } from './tasks.js';
import { Objects } from './objects.js';
import { Reads } from './reads.js';
import { Temporary } from './temporary.js';
import { refuse } from './fault.js';
import type { Settings } from './settings.js';

export type PublicOperation = { [K in ExchangeName]: { name: K; request: RequestOf<K> } }[ExchangeName];
export const Context = z.strictObject({ verifier: z.string().regex(/^[0-9a-f]{64}$/), dataset: z.string().optional(), protocol: z.string().optional(), attempt: Uuid.optional() });
export type Context = z.infer<typeof Context>;
const Name = z.custom<ExchangeName>((value) => typeof value === 'string' && Object.hasOwn(exchanges, value));
const Incoming = z.strictObject({ name: Name, request: z.unknown() });
export function isPublicOperation(value: unknown): value is PublicOperation {
  const parsed = Incoming.safeParse(value);
  return parsed.success && exchanges[parsed.data.name].request.schema.safeParse(parsed.data.request).success;
}
const ordinary = new Set<ExchangeName>(['CreateApiKey', 'CreateOperator', 'EditOperator', 'RegisterAsset', 'UpdateAsset', 'CreateObservation', 'ReportObservation',
  'EditObservation', 'EditTrack', 'CreateGeofeature', 'EditGeofeature', 'CreateTask', 'UploadObject', 'EditObject']);
export class Engine {
  readonly store: Store;
  readonly identity: Identity;
  readonly entities: Entities;
  readonly tasks: Tasks;
  readonly objects: Objects;
  readonly temporary: Temporary;
  readonly reads: Reads;
  state: 'starting' | 'serving' | 'draining' = 'starting';
  pressure = false;
  constructor(readonly directory: string, readonly settings: Settings, establish?: { dataset: Uuid; actionId: Uuid }) {
    this.store = new Store(join(directory, 'core.sqlite'), settings, establish);
    this.identity = new Identity(this.store);
    this.temporary = new Temporary(this.store);
    this.entities = new Entities(this.store, this.identity, new Evidence(this.store), this.temporary);
    this.objects = new Objects(this.store, association => {
      if (association.kind === 'task') this.tasks.get(association.id);
      else if (!this.entities.known(association.id, association.kind)) refuse('entity_not_found');
    });
    this.tasks = new Tasks(this.store, this.entities, this.identity, this.temporary, (task, object, required) => this.objects.declare(task, object, required));
    this.reads = new Reads(this.store, this.entities, this.identity, this.tasks, this.objects, this.temporary, join(directory, 'captures'));
    this.store.transact(null, tx => this.entities.restartContact(tx));
    this.state = 'serving';
  }
  authorize(context: Context, discovery = false) {
    const authority = this.identity.authorize(context.verifier);
    if (!discovery) {
      if (context.protocol !== undefined && context.protocol !== PROTOCOL_VERSION) refuse('protocol_mismatch');
      if (context.dataset === undefined) refuse('dataset_required');
      if (!Uuid.safeParse(context.dataset).success) refuse('invalid_request');
      if (context.dataset !== this.store.dataset) refuse('dataset_mismatch');
      if (context.protocol === undefined) refuse('invalid_request');
    }
    return authority;
  }
  async execute(operation: PublicOperation, context: Context): Promise<ResponseOf<ExchangeName>> {
    const authority = this.authorize(context, operation.name === 'GetHealth');
    if (this.state !== 'serving' && operation.name !== 'GetHealth' && operation.name !== 'GetReadiness') refuse('resource_limit');
    if (this.pressure && ordinary.has(operation.name)) { await this.reads.expireHistory(); if (this.pressure) refuse('storage_limit'); }
    let data: unknown, cursor: string | undefined;
    switch (operation.name) {
      case 'ReadSnapshot': data = await this.reads.snapshot(operation.request, context.verifier); break;
      case 'GetAssetMovementHistory': data = await this.reads.history('asset', operation.request, context.verifier); break;
      case 'GetObservationMovementHistory': data = await this.reads.history('observation', operation.request, context.verifier); break;
      case 'GetTrackMovementHistory': data = await this.reads.history('track', operation.request, context.verifier); break;
      case 'ReleaseSnapshot': data = await this.reads.release(operation.request.release_token, 'snapshot'); break;
      case 'ReleaseHistoryView': data = await this.reads.release(operation.request.release_token, 'history'); break;
      case 'GetReference': return { kind: 'reference', status: 200, media: 'application/vnd.oai.openapi+json', document: new TextDecoder().decode(exportReference()) };
      case 'ReadObjectContent': {
        const image = this.objects.get(operation.request.object_id);
        return { kind: 'content', status: 200, descriptor: { object_id: image.object_id, byte_length: image.byte_length, sha256: image.sha256, content_type: image.content_type, disposition: operation.request.disposition } };
      }
      default: {
        const committed = this.store.transact(authority, tx => {
          this.authorize(context, operation.name === 'GetHealth');
          return this.dispatch(tx, operation, context);
        });
        data = committed.data; cursor = committed.cursor;
      }
    }
    this.authorize(context, operation.name === 'GetHealth');
    const result = { kind: 'success', status: operation.name === 'GetReadiness' && this.state !== 'serving' ? 503 : 200,
      body: { dataset_id: this.store.dataset, data, ...(cursor === undefined ? {} : { commit_cursor: cursor }) } };
    return exchanges[operation.name].response.schema.parse(result);
  }
  private dispatch(tx: Transaction, operation: PublicOperation, context: Context): unknown {
    const identity = this.identity, entities = this.entities, tasks = this.tasks, objects = this.objects, reads = this.reads;
    switch (operation.name) {
      case 'ListResources': return reads.resources(operation.request);
      case 'ReadActivity': return reads.activity(operation.request);
      case 'ListApiKeys': return reads.keys(operation.request);
      case 'CreateApiKey': return identity.createKey(tx, operation.request);
      case 'RevokeApiKey': return identity.revokeKey(tx, operation.request);
      case 'ListOperators': return reads.operators(operation.request);
      case 'GetOperator': return identity.operator(operation.request.operator_id);
      case 'CreateOperator': return identity.createOperator(tx, operation.request);
      case 'EditOperator': return identity.editOperator(tx, operation.request);
      case 'DeleteOperator': return identity.deleteOperator(tx, operation.request);
      case 'GetHealth': return { healthy: this.state === 'serving' && !this.pressure && !objects.degraded, protocol_version: PROTOCOL_VERSION,
        core_run_id: this.store.run, limits: this.settings.limits, temporary_limits: this.settings.temporary,
        ...this.temporary.context(this.authorize(context, true).keyId) };
      case 'GetReadiness': return { ready: this.state === 'serving' };
      case 'RegisterAsset': return entities.register(tx, operation.request);
      case 'ListAssets': return reads.assets(operation.request);
      case 'GetAsset': return entities.asset(operation.request.asset_id);
      case 'GetAssetByAlias': return entities.asset(entities.byAlias('asset', operation.request.alias));
      case 'UpdateAsset': return entities.update(tx, operation.request);
      case 'DeleteAsset': return entities.deleteAsset(tx, operation.request);
      case 'GetAssetStatus': { const asset = entities.asset(operation.request.asset_id); return { asset_id: asset.id, status: asset.status, communications: asset.communications, heartbeat: asset.heartbeat }; }
      case 'GetAssetObjects': return reads.associated('asset', operation.request);
      case 'CreateObservation': return entities.createObservation(tx, operation.request);
      case 'ReportObservation': return entities.reportObservation(tx, operation.request);
      case 'EditObservation': return entities.editObservation(tx, operation.request);
      case 'ListObservations': return reads.observations(operation.request);
      case 'GetObservation': return entities.observation(operation.request.observation_id);
      case 'GetObservationByAlias': return entities.observation(entities.byAlias('observation', operation.request.alias));
      case 'GetObservationObjects': return reads.associated('observation', operation.request);
      case 'ListTracks': return reads.tracks(operation.request);
      case 'GetTrack': return entities.track(operation.request.track_id);
      case 'GetTrackByAlias': return entities.track(entities.byAlias('track', operation.request.alias));
      case 'EditTrack': return entities.editTrack(tx, operation.request);
      case 'GetTrackObservations': return reads.trackObservations(operation.request);
      case 'GetTrackObjects': return reads.associated('track', operation.request);
      case 'CreateGeofeature': return entities.createGeofeature(tx, operation.request);
      case 'ListGeofeatures': return reads.geofeatures(operation.request);
      case 'GetGeofeature': return entities.geofeature(operation.request.geofeature_id);
      case 'GetGeofeatureByAlias': return entities.geofeature(entities.byAlias('geofeature', operation.request.alias));
      case 'EditGeofeature': return entities.editGeofeature(tx, operation.request);
      case 'DeleteGeofeature': return entities.deleteGeofeature(tx, operation.request, feature => tasks.guarded(feature));
      case 'GetGeofeatureObjects': return reads.associated('geofeature', operation.request);
      case 'CreateTask': return tasks.create(tx, operation.request);
      case 'ListTasks': return reads.taskList(operation.request);
      case 'GetTask': return tasks.get(operation.request.task_id);
      case 'ReportTaskExecution': return tasks.execution(tx, operation.request);
      case 'RequestTaskCancellation': return tasks.cancel(tx, operation.request);
      case 'ReportTaskResults': return tasks.results(tx, operation.request);
      case 'GetTaskObjects': return reads.associated('task', operation.request);
      case 'GetAssignedTasks': return tasks.assigned(operation.request);
      case 'SetTaskOrder': return tasks.order(tx, operation.request);
      case 'ConfirmTaskOrder': return tasks.confirm(tx, operation.request);
      case 'UploadObject': if (context.attempt === undefined) refuse('invalid_request'); return objects.publish(tx, context.attempt);
      case 'ListObjects': return reads.objectList(operation.request);
      case 'GetObject': return objects.get(operation.request.object_id);
      case 'EditObject': return objects.edit(tx, operation.request);
      case 'DeleteObject': return objects.delete(tx, operation.request);
      case 'ReadChanges': return reads.replay(operation.request);
      case 'BeginAssetContact': return entities.begin(operation.request);
      case 'ReplaceAssetProcess': return entities.replace(tx, operation.request);
      case 'ReadSnapshot': case 'GetAssetMovementHistory': case 'GetObservationMovementHistory': case 'GetTrackMovementHistory':
      case 'ReleaseSnapshot': case 'ReleaseHistoryView': case 'GetReference': case 'ReadObjectContent': throw new Error('async_operation_in_transaction');
      default: { const exhaustive: never = operation; return exhaustive; }
    }
  }
  provision(request: RequestOf<'CreateApiKey'>): void {
    Secret.parse(request.secret);
    this.store.transact(null, tx => this.identity.createKey(tx, request));
  }
  async tick(): Promise<void> { this.store.transact(null, tx => this.entities.tick(tx)); await this.reads.cleanup(); this.temporary.expire(); this.store.checkpoint(); }
  async close(): Promise<void> { this.state = 'draining'; await this.reads.close(); this.store.close(); }
  establish(dataset: Uuid, action: Uuid, hard: boolean): void {
    this.store.db.transaction(() => {
      this.entities.clearDataset(); this.entities.evidence.clearDataset(); this.tasks.clearDataset(); this.objects.clearDataset(); this.identity.clearDataset(hard);
      this.store.db.exec(hard ? 'DELETE FROM retry; DELETE FROM commit_log; DELETE FROM temporary_receipts' : "DELETE FROM retry WHERE scope NOT LIKE 'setup/%'; DELETE FROM commit_log; DELETE FROM temporary_receipts");
      this.store.setMeta('dataset', dataset); this.store.setMeta('sequence', '0'); this.store.setMeta('earliest', '0');
      this.store.setMeta('establishment', JSON.stringify({ dataset, actionId: action }));
    })();
  }
}
