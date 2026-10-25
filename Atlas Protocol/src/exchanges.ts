import { z } from 'zod';
import {
  Alias,
  Counter,
  NewId,
  Opaque,
  ordered,
  PageSize,
  Secret,
  text,
  Timestamp,
  timestampNanoseconds,
  Uuid,
  uniqueArray,
} from './scalars.js';
import {
  AssetDescription,
  AssetType,
  Description,
  GeofeatureType,
  Heartbeat,
} from './components.js';
import { Capabilities, CreateTask } from './commands.js';
import {
  Asset,
  assetEvidenceMatches,
  Communications,
  Geofeature,
  Observation,
  PublisherSubject,
  reportSequencesMatch,
  Track,
} from './entities.js';
import { Geometry } from './geometry.js';
import { AssetReport, EvidenceDisposition, ObservationReport, readSections } from './reports.js';
import {
  ConfirmTaskOrder,
  ReportTaskExecution,
  ReportTaskResults,
  Task,
  TaskControl,
  TaskQueue,
} from './tasks.js';
import { ContentDescriptor, ObjectEdits, ObjectImage, UploadDescriptor } from './objects.js';
import {
  Activity,
  ApiKey,
  HealthData,
  Operator,
  Readiness,
  ResourceUsage,
} from './administration.js';
import { Continuation, HistoryPage, HistoryQuery, Release, Released } from './history.js';
import { associatedQuery, filters, listQuery, page } from './queries.js';
import { ReadChanges, ReadSnapshot, ReplayPage, SnapshotPage } from './synchronization.js';
import { HttpError } from './errors.js';
import { contract } from './json.js';
import type { JsonContract } from './json.js';
import { headers } from './bindings.js';

const empty = z.strictObject({});
const deleted = z.strictObject({ deleted: z.literal(true) });
const retry = { request_id: NewId };
const edit = { ...retry, expected_edit_revision: Counter };
const descriptiveEdits = z
  .strictObject({
    alias: Alias.nullable().exactOptional(),
    description: Description.nullable().exactOptional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Empty edit');
const assetResult = z.strictObject({
  asset: Asset,
  evidence_disposition: EvidenceDisposition.exactOptional(),
});
const observationResult = z
  .strictObject({
    observation: Observation,
    track: Track,
    evidence_disposition: EvidenceDisposition.exactOptional(),
  })
  .refine(
    (value) =>
      value.observation.dataset_id === value.track.dataset_id &&
      value.observation.track_id === value.track.id &&
      value.track.sources.some(
        (source) =>
          source.observation_id === value.observation.id &&
          source.publisher_id === value.observation.publisher_id &&
          source.source_asset_id === value.observation.source_asset_id,
      ),
    'Observation Track pair differs',
  )
  .refine(
    (value) =>
      (['type', 'telemetry', 'attitude', 'geometry'] as const).every(
        (section) =>
          JSON.stringify(value.observation[section]) === JSON.stringify(value.track[section]),
      ),
    'Observation Track sections differ',
  );
const taskResult = z.strictObject({ task: Task, evidence_disposition: EvidenceDisposition });
const assetEvidenceResult = assetResult.extend({ evidence_disposition: EvidenceDisposition });
const RegisterAsset = z.strictObject({
  asset_id: NewId,
  registration_id: NewId,
  ...retry,
  process_generation: NewId,
  api_key_id: NewId,
  secret: Secret,
  alias: Alias.exactOptional(),
  description: AssetDescription.exactOptional(),
  type: AssetType.exactOptional(),
  capabilities: Capabilities.exactOptional(),
});
const UpdateAsset = z
  .strictObject({
    asset_id: Uuid,
    ...retry,
    expected_edit_revision: Counter.exactOptional(),
    alias: Alias.nullable().exactOptional(),
    description: AssetDescription.nullable().exactOptional(),
    type: AssetType.exactOptional(),
    capabilities: Capabilities.exactOptional(),
    report: AssetReport.exactOptional(),
  })
  .refine((value) => {
    const authored = ['alias', 'description', 'type', 'capabilities'].some((key) =>
      Object.hasOwn(value, key),
    );
    return (
      (authored || value.report !== undefined) &&
      (!authored || value.expected_edit_revision !== undefined) &&
      (!value.report || value.report.entity_id === value.asset_id)
    );
  }, 'Invalid Asset update context');
const CreateObservation = z
  .strictObject({
    observation_id: NewId,
    ...retry,
    publisher_id: Uuid,
    source_asset_id: Uuid.exactOptional(),
    publisher_subject: PublisherSubject.exactOptional(),
    alias: Alias.exactOptional(),
    description: Description.exactOptional(),
    report: ObservationReport.exactOptional(),
  })
  .refine(
    (value) =>
      !value.report ||
      (value.report.entity_id === value.observation_id &&
        value.report.origin.publisher_id === value.publisher_id),
    'Observation report context differs',
  );
const ReportObservation = z
  .strictObject({ observation_id: Uuid, publisher_id: Uuid, report: ObservationReport })
  .refine(
    (value) =>
      value.report.entity_id === value.observation_id &&
      value.report.origin.publisher_id === value.publisher_id,
    'Observation report context differs',
  );
const assignedFirst = z.strictObject({
  asset_id: Uuid,
  process_generation: Uuid,
  read_id: NewId,
  page_size: PageSize.exactOptional(),
});
function durationMatches(from: string, until: string, minimum: bigint, maximum = minimum): boolean {
  try {
    const duration = timestampNanoseconds(until) - timestampNanoseconds(from);
    return duration >= minimum && duration <= maximum;
  } catch {
    return false;
  }
}
export const AssignedTasks = z
  .strictObject({
    asset_id: Uuid,
    process_generation: Uuid,
    read_id: Uuid,
    core_run_id: Uuid,
    captured_at: Timestamp,
    instructions_valid_until: Timestamp,
    task_queue: TaskQueue,
    task_control: TaskControl,
    tasks: z.array(Task).max(1000),
    next_page_token: Opaque.nullable(),
  })
  .refine(
    (value) =>
      durationMatches(value.captured_at, value.instructions_valid_until, 10000000000n) &&
      value.tasks.every(
        (task) =>
          task.asset_id === value.asset_id &&
          !['completed', 'failed', 'cancelled'].includes(task.execution_state),
      ) &&
      ordered(value.tasks, (task) => task.task_id),
    'Invalid assigned work context',
  )
  .meta({ id: 'AssignedTasks' });
const beginBase = {
  ...retry,
  allocation_context: Opaque,
  asset_id: Uuid,
  process_generation: Uuid,
};
export const BeginAssetContact = z
  .discriminatedUnion('mode', [
    z.strictObject({ ...beginBase, mode: z.literal('current') }),
    z
      .strictObject({
        ...beginBase,
        mode: z.literal('replace'),
        process_generation: NewId,
        expected_process_generation: Uuid,
      })
      .refine(
        (value) => value.process_generation !== value.expected_process_generation,
        'Generation unchanged',
      ),
  ])
  .meta({ id: 'BeginAssetContact' });
const challengeBase = {
  challenge_id: Uuid,
  asset_id: Uuid,
  process_generation: Uuid,
  core_run_id: Uuid,
  issued_at: Timestamp,
  expires_at: Timestamp,
};
export const ContactChallenge = z
  .discriminatedUnion('mode', [
    z.strictObject({ ...challengeBase, mode: z.literal('current') }),
    z.strictObject({
      ...challengeBase,
      mode: z.literal('replace'),
      expected_process_generation: Uuid,
    }),
  ])
  .refine(
    (value) => durationMatches(value.issued_at, value.expires_at, 1n, 10000000000n),
    'Invalid challenge interval',
  )
  .meta({ id: 'ContactChallenge' });
export const ReplaceAssetProcess = z
  .strictObject({
    ...retry,
    asset_id: Uuid,
    expected_process_generation: Uuid,
    process_generation: NewId,
    challenge_id: Uuid,
    first_report: AssetReport,
  })
  .refine(
    (value) =>
      value.expected_process_generation !== value.process_generation &&
      value.first_report.entity_id === value.asset_id &&
      value.first_report.origin.process_generation === value.process_generation &&
      value.first_report.mode === 'current' &&
      value.first_report.contact_proof?.challenge_id === value.challenge_id,
    'Invalid first process report',
  )
  .meta({ id: 'ReplaceAssetProcess' });

function envelope<D extends z.ZodType>(data: D) {
  return z.strictObject({ dataset_id: Uuid, data, commit_cursor: Opaque.exactOptional() });
}
function committedEnvelope<D extends z.ZodType>(data: D) {
  return envelope(data).extend({ commit_cursor: Opaque });
}
function responseSchema<S extends z.ZodType, N extends readonly number[]>(success: S, statuses: N) {
  return z.union([
    z.strictObject({ kind: z.literal('success'), status: z.literal(statuses), body: success }),
    HttpError,
  ]);
}
export type JsonExchange<
  M extends 'GET' | 'POST',
  O extends string,
  P extends string,
  R extends z.ZodType,
  S extends z.ZodType,
  N extends readonly number[],
> = Readonly<{
  method: M;
  operationId: O;
  path: P;
  request: JsonContract<R>;
  response: JsonContract<ReturnType<typeof responseSchema<S, N>>>;
  success: S;
  successStatuses: N;
  headers: typeof headers;
  requestMedia: string;
  responseMedia: string;
  transport: string;
  discovery: boolean;
  committed: boolean;
}>;
function exchange<
  const M extends 'GET' | 'POST',
  const O extends string,
  const P extends string,
  R extends z.ZodType,
  S extends z.ZodType,
  const N extends readonly number[],
>(
  method: M,
  operationId: O,
  path: P,
  request: R,
  success: S,
  committed: boolean,
  statuses: N,
): JsonExchange<M, O, P, R, S, N> {
  return Object.freeze({
    operationId,
    method,
    path,
    request: contract(request),
    response: contract(responseSchema(success, statuses), 'http_response'),
    success,
    successStatuses: statuses,
    headers,
    requestMedia: 'application/json',
    responseMedia: 'application/json',
    transport: 'json',
    discovery: operationId === 'GetHealth',
    committed,
  });
}
function post<
  const O extends string,
  const P extends string,
  R extends z.ZodType,
  D extends z.ZodType,
>(operationId: O, path: P, request: R, data: D) {
  return exchange('POST', operationId, path, request, envelope(data), false, [200]);
}
function committedPost<
  const O extends string,
  const P extends string,
  R extends z.ZodType,
  D extends z.ZodType,
>(operationId: O, path: P, request: R, data: D) {
  return exchange('POST', operationId, path, request, committedEnvelope(data), true, [200]);
}
function get<
  const O extends string,
  const P extends string,
  R extends z.ZodType,
  D extends z.ZodType,
>(operationId: O, path: P, request: R, data: D) {
  return exchange('GET', operationId, path, request, envelope(data), false, [200]);
}
const reference = get('GetReference', '/reference', empty, empty);
const referenceResult = z.strictObject({
  kind: z.literal('reference'),
  status: z.literal(200),
  media: z.enum(['application/vnd.oai.openapi+json', 'text/html']),
  document: text(4194304),
});
const content = get(
  'ReadObjectContent',
  '/objects/{object_id}/content',
  z.strictObject({ object_id: Uuid, disposition: z.enum(['inline', 'attachment']) }),
  ContentDescriptor,
);
const contentResult = z.strictObject({
  kind: z.literal('content'),
  status: z.literal(200),
  descriptor: ContentDescriptor,
});
const ListResourcesExchange = post(
  'ListResources',
  '/messages/list_resources',
  listQuery(filters.resources),
  page(ResourceUsage, (value) => value.kind),
);
const ReadActivityExchange = post(
  'ReadActivity',
  '/messages/read_activity',
  listQuery(filters.activity),
  page(Activity, (value) => value.activity_id),
);
const ListApiKeysExchange = post(
  'ListApiKeys',
  '/messages/list_api_keys',
  listQuery(filters.api_keys),
  page(ApiKey, (value) => value.api_key_id),
);
const CreateApiKeyExchange = committedPost(
  'CreateApiKey',
  '/messages/create_api_key',
  z.strictObject({
    ...retry,
    api_key_id: NewId,
    secret: Secret,
    operator_id: Uuid.exactOptional(),
  }),
  ApiKey,
);
const RevokeApiKeyExchange = committedPost(
  'RevokeApiKey',
  '/messages/revoke_api_key',
  z.strictObject({ ...retry, api_key_id: Uuid }),
  ApiKey,
);
const ListOperatorsExchange = post(
  'ListOperators',
  '/messages/list_operators',
  listQuery(filters.operators),
  page(Operator, (value) => value.operator_id),
);
const GetOperatorExchange = post(
  'GetOperator',
  '/messages/get_operator',
  z.strictObject({ operator_id: Uuid }),
  Operator,
);
const CreateOperatorExchange = committedPost(
  'CreateOperator',
  '/messages/create_operator',
  z.strictObject({
    ...retry,
    operator_id: NewId,
    name: text(256, true),
    description: text(4096).exactOptional(),
  }),
  Operator,
);
const EditOperatorExchange = committedPost(
  'EditOperator',
  '/messages/edit_operator',
  z.strictObject({
    ...edit,
    operator_id: Uuid,
    edits: z
      .strictObject({
        name: text(256, true).exactOptional(),
        description: text(4096).nullable().exactOptional(),
      })
      .refine((value) => Object.keys(value).length > 0, 'Empty edit'),
  }),
  Operator,
);
const DeleteOperatorExchange = committedPost(
  'DeleteOperator',
  '/messages/delete_operator',
  z.strictObject({ ...retry, operator_id: Uuid }),
  deleted,
);
const GetHealthExchange = get('GetHealth', '/health', empty, HealthData);
const GetReadinessExchange = exchange(
  'GET',
  'GetReadiness',
  '/readiness',
  empty,
  envelope(Readiness),
  false,
  [200, 503],
);
const GetReferenceExchange = Object.freeze({
  ...reference,
  transport: 'reference',
  responseMedia: 'application/vnd.oai.openapi+json',
  response: contract(z.union([referenceResult, HttpError]), 'http_response'),
});
const RegisterAssetExchange = committedPost(
  'RegisterAsset',
  '/messages/register_asset',
  RegisterAsset,
  z.strictObject({ asset: Asset, api_key: ApiKey }),
);
const ListAssetsExchange = post(
  'ListAssets',
  '/messages/list_assets',
  listQuery(filters.assets),
  page(Asset, (value) => value.id),
);
const GetAssetExchange = post(
  'GetAsset',
  '/messages/get_asset',
  z.strictObject({ asset_id: Uuid }),
  Asset,
);
const GetAssetByAliasExchange = post(
  'GetAssetByAlias',
  '/messages/get_asset_by_alias',
  z.strictObject({ alias: Alias }),
  Asset,
);
const UpdateAssetExchange = post('UpdateAsset', '/messages/update_asset', UpdateAsset, assetResult);
const DeleteAssetExchange = committedPost(
  'DeleteAsset',
  '/messages/delete_asset',
  z.strictObject({ ...retry, asset_id: Uuid }),
  deleted,
);
const GetAssetStatusExchange = post(
  'GetAssetStatus',
  '/messages/get_asset_status',
  z.strictObject({ asset_id: Uuid }),
  z
    .strictObject({
      asset_id: Uuid,
      status: readSections.status,
      communications: Communications,
      heartbeat: Heartbeat,
    })
    .refine(
      (value) =>
        [value.status, value.communications.capacity].every((section) =>
          assetEvidenceMatches(section.evidence, value.asset_id),
        ) && reportSequencesMatch([value.status.evidence, value.communications.capacity.evidence]),
      'Asset status evidence scope differs',
    ),
);
const GetAssetMovementHistoryExchange = Object.freeze({
  ...post(
    'GetAssetMovementHistory',
    '/messages/get_asset_movement_history',
    HistoryQuery,
    HistoryPage,
  ),
  historyKind: 'asset',
});
const GetAssetObjectsExchange = post(
  'GetAssetObjects',
  '/messages/get_asset_objects',
  associatedQuery({ asset_id: Uuid }),
  page(ObjectImage, (value) => value.object_id),
);
const CreateObservationExchange = committedPost(
  'CreateObservation',
  '/messages/create_observation',
  CreateObservation,
  observationResult,
);
const ReportObservationExchange = post(
  'ReportObservation',
  '/messages/report_observation',
  ReportObservation,
  observationResult.safeExtend({ evidence_disposition: EvidenceDisposition }),
);
const EditObservationExchange = committedPost(
  'EditObservation',
  '/messages/edit_observation',
  z.strictObject({ ...edit, observation_id: Uuid, edits: descriptiveEdits }),
  Observation,
);
const ListObservationsExchange = post(
  'ListObservations',
  '/messages/list_observations',
  listQuery(filters.observations),
  page(Observation, (value) => value.id),
);
const GetObservationExchange = post(
  'GetObservation',
  '/messages/get_observation',
  z.strictObject({ observation_id: Uuid }),
  Observation,
);
const GetObservationByAliasExchange = post(
  'GetObservationByAlias',
  '/messages/get_observation_by_alias',
  z.strictObject({ alias: Alias }),
  Observation,
);
const GetObservationMovementHistoryExchange = Object.freeze({
  ...post(
    'GetObservationMovementHistory',
    '/messages/get_observation_movement_history',
    HistoryQuery,
    HistoryPage,
  ),
  historyKind: 'observation',
});
const GetObservationObjectsExchange = post(
  'GetObservationObjects',
  '/messages/get_observation_objects',
  associatedQuery({ observation_id: Uuid }),
  page(ObjectImage, (value) => value.object_id),
);
const ListTracksExchange = post(
  'ListTracks',
  '/messages/list_tracks',
  listQuery(filters.tracks),
  page(Track, (value) => value.id),
);
const GetTrackExchange = post(
  'GetTrack',
  '/messages/get_track',
  z.strictObject({ track_id: Uuid }),
  Track,
);
const GetTrackByAliasExchange = post(
  'GetTrackByAlias',
  '/messages/get_track_by_alias',
  z.strictObject({ alias: Alias }),
  Track,
);
const EditTrackExchange = committedPost(
  'EditTrack',
  '/messages/edit_track',
  z.strictObject({ ...edit, track_id: Uuid, edits: descriptiveEdits }),
  Track,
);
const GetTrackObservationsExchange = post(
  'GetTrackObservations',
  '/messages/get_track_observations',
  z.union([
    z.strictObject({
      track_id: Uuid,
      page_size: PageSize.exactOptional(),
      publisher_ids: uniqueArray(Uuid).exactOptional(),
      source_asset_ids: uniqueArray(Uuid).exactOptional(),
    }),
    Continuation,
  ]),
  page(Observation, (value) => value.id),
);
const GetTrackMovementHistoryExchange = Object.freeze({
  ...post(
    'GetTrackMovementHistory',
    '/messages/get_track_movement_history',
    HistoryQuery,
    HistoryPage,
  ),
  historyKind: 'track',
});
const GetTrackObjectsExchange = post(
  'GetTrackObjects',
  '/messages/get_track_objects',
  associatedQuery({ track_id: Uuid }),
  page(ObjectImage, (value) => value.object_id),
);
const CreateGeofeatureExchange = committedPost(
  'CreateGeofeature',
  '/messages/create_geofeature',
  z.strictObject({
    ...retry,
    geofeature_id: NewId,
    geometry: Geometry,
    alias: Alias.exactOptional(),
    description: Description.exactOptional(),
    type: GeofeatureType.exactOptional(),
  }),
  Geofeature,
);
const ListGeofeaturesExchange = post(
  'ListGeofeatures',
  '/messages/list_geofeatures',
  listQuery(filters.geofeatures),
  page(Geofeature, (value) => value.id),
);
const GetGeofeatureExchange = post(
  'GetGeofeature',
  '/messages/get_geofeature',
  z.strictObject({ geofeature_id: Uuid }),
  Geofeature,
);
const GetGeofeatureByAliasExchange = post(
  'GetGeofeatureByAlias',
  '/messages/get_geofeature_by_alias',
  z.strictObject({ alias: Alias }),
  Geofeature,
);
const EditGeofeatureExchange = committedPost(
  'EditGeofeature',
  '/messages/edit_geofeature',
  z.strictObject({
    ...edit,
    geofeature_id: Uuid,
    edits: z
      .strictObject({
        alias: Alias.nullable().exactOptional(),
        description: Description.nullable().exactOptional(),
        type: GeofeatureType.exactOptional(),
        geometry: Geometry.exactOptional(),
      })
      .refine((value) => Object.keys(value).length > 0, 'Empty edit'),
  }),
  Geofeature,
);
const DeleteGeofeatureExchange = committedPost(
  'DeleteGeofeature',
  '/messages/delete_geofeature',
  z.strictObject({ ...retry, geofeature_id: Uuid }),
  deleted,
);
const GetGeofeatureObjectsExchange = post(
  'GetGeofeatureObjects',
  '/messages/get_geofeature_objects',
  associatedQuery({ geofeature_id: Uuid }),
  page(ObjectImage, (value) => value.object_id),
);
const CreateTaskExchange = committedPost('CreateTask', '/messages/create_task', CreateTask, Task);
const ListTasksExchange = post(
  'ListTasks',
  '/messages/list_tasks',
  listQuery(filters.tasks),
  page(Task, (value) => value.task_id),
);
const GetTaskExchange = post(
  'GetTask',
  '/messages/get_task',
  z.strictObject({ task_id: Uuid }),
  Task,
);
const ReportTaskExecutionExchange = post(
  'ReportTaskExecution',
  '/messages/report_task_execution',
  ReportTaskExecution,
  taskResult,
);
const RequestTaskCancellationExchange = post(
  'RequestTaskCancellation',
  '/messages/request_task_cancellation',
  z.strictObject({ ...retry, task_id: Uuid }),
  Task,
);
const ReportTaskResultsExchange = post(
  'ReportTaskResults',
  '/messages/report_task_results',
  ReportTaskResults,
  taskResult,
);
const GetTaskObjectsExchange = post(
  'GetTaskObjects',
  '/messages/get_task_objects',
  associatedQuery({ task_id: Uuid }),
  page(ObjectImage, (value) => value.object_id),
);
const GetAssignedTasksExchange = post(
  'GetAssignedTasks',
  '/messages/get_assigned_tasks',
  z.union([assignedFirst, Continuation]),
  AssignedTasks,
);
const SetTaskOrderExchange = committedPost(
  'SetTaskOrder',
  '/messages/set_task_order',
  z.strictObject({
    ...retry,
    asset_id: Uuid,
    expected_queue_revision: Counter,
    task_ids: uniqueArray(Uuid),
  }),
  Asset,
);
const ConfirmTaskOrderExchange = post(
  'ConfirmTaskOrder',
  '/messages/confirm_task_order',
  ConfirmTaskOrder,
  assetEvidenceResult,
);
const UploadObjectExchange = Object.freeze({
  ...committedPost('UploadObject', '/objects', UploadDescriptor, ObjectImage),
  transport: 'upload',
  requestMedia: 'multipart/form-data',
});
const ListObjectsExchange = post(
  'ListObjects',
  '/messages/list_objects',
  listQuery(filters.objects),
  page(ObjectImage, (value) => value.object_id),
);
const GetObjectExchange = post(
  'GetObject',
  '/messages/get_object',
  z.strictObject({ object_id: Uuid }),
  ObjectImage,
);
const EditObjectExchange = committedPost(
  'EditObject',
  '/messages/edit_object',
  z.strictObject({ ...edit, object_id: Uuid, edits: ObjectEdits }),
  ObjectImage,
);
const DeleteObjectExchange = committedPost(
  'DeleteObject',
  '/messages/delete_object',
  z.strictObject({ ...retry, object_id: Uuid }),
  deleted,
);
const ReadObjectContentExchange = Object.freeze({
  ...content,
  transport: 'content',
  responseMedia: 'binary',
  response: contract(z.union([contentResult, HttpError]), 'http_response'),
});
const ReleaseHistoryViewExchange = post(
  'ReleaseHistoryView',
  '/messages/release_history_view',
  Release,
  Released,
);
const ReadSnapshotExchange = post(
  'ReadSnapshot',
  '/messages/read_snapshot',
  ReadSnapshot,
  SnapshotPage,
);
const ReleaseSnapshotExchange = post(
  'ReleaseSnapshot',
  '/messages/release_snapshot',
  Release,
  Released,
);
const ReadChangesExchange = post('ReadChanges', '/messages/read_changes', ReadChanges, ReplayPage);
const BeginAssetContactExchange = post(
  'BeginAssetContact',
  '/messages/begin_asset_contact',
  BeginAssetContact,
  ContactChallenge,
);
const ReplaceAssetProcessExchange = committedPost(
  'ReplaceAssetProcess',
  '/messages/replace_asset_process',
  ReplaceAssetProcess,
  assetEvidenceResult,
);
export type ExchangeCatalog = {
  readonly ListResources: typeof ListResourcesExchange;
  readonly ReadActivity: typeof ReadActivityExchange;
  readonly ListApiKeys: typeof ListApiKeysExchange;
  readonly CreateApiKey: typeof CreateApiKeyExchange;
  readonly RevokeApiKey: typeof RevokeApiKeyExchange;
  readonly ListOperators: typeof ListOperatorsExchange;
  readonly GetOperator: typeof GetOperatorExchange;
  readonly CreateOperator: typeof CreateOperatorExchange;
  readonly EditOperator: typeof EditOperatorExchange;
  readonly DeleteOperator: typeof DeleteOperatorExchange;
  readonly GetHealth: typeof GetHealthExchange;
  readonly GetReadiness: typeof GetReadinessExchange;
  readonly GetReference: typeof GetReferenceExchange;
  readonly RegisterAsset: typeof RegisterAssetExchange;
  readonly ListAssets: typeof ListAssetsExchange;
  readonly GetAsset: typeof GetAssetExchange;
  readonly GetAssetByAlias: typeof GetAssetByAliasExchange;
  readonly UpdateAsset: typeof UpdateAssetExchange;
  readonly DeleteAsset: typeof DeleteAssetExchange;
  readonly GetAssetStatus: typeof GetAssetStatusExchange;
  readonly GetAssetMovementHistory: typeof GetAssetMovementHistoryExchange;
  readonly GetAssetObjects: typeof GetAssetObjectsExchange;
  readonly CreateObservation: typeof CreateObservationExchange;
  readonly ReportObservation: typeof ReportObservationExchange;
  readonly EditObservation: typeof EditObservationExchange;
  readonly ListObservations: typeof ListObservationsExchange;
  readonly GetObservation: typeof GetObservationExchange;
  readonly GetObservationByAlias: typeof GetObservationByAliasExchange;
  readonly GetObservationMovementHistory: typeof GetObservationMovementHistoryExchange;
  readonly GetObservationObjects: typeof GetObservationObjectsExchange;
  readonly ListTracks: typeof ListTracksExchange;
  readonly GetTrack: typeof GetTrackExchange;
  readonly GetTrackByAlias: typeof GetTrackByAliasExchange;
  readonly EditTrack: typeof EditTrackExchange;
  readonly GetTrackObservations: typeof GetTrackObservationsExchange;
  readonly GetTrackMovementHistory: typeof GetTrackMovementHistoryExchange;
  readonly GetTrackObjects: typeof GetTrackObjectsExchange;
  readonly CreateGeofeature: typeof CreateGeofeatureExchange;
  readonly ListGeofeatures: typeof ListGeofeaturesExchange;
  readonly GetGeofeature: typeof GetGeofeatureExchange;
  readonly GetGeofeatureByAlias: typeof GetGeofeatureByAliasExchange;
  readonly EditGeofeature: typeof EditGeofeatureExchange;
  readonly DeleteGeofeature: typeof DeleteGeofeatureExchange;
  readonly GetGeofeatureObjects: typeof GetGeofeatureObjectsExchange;
  readonly CreateTask: typeof CreateTaskExchange;
  readonly ListTasks: typeof ListTasksExchange;
  readonly GetTask: typeof GetTaskExchange;
  readonly ReportTaskExecution: typeof ReportTaskExecutionExchange;
  readonly RequestTaskCancellation: typeof RequestTaskCancellationExchange;
  readonly ReportTaskResults: typeof ReportTaskResultsExchange;
  readonly GetTaskObjects: typeof GetTaskObjectsExchange;
  readonly GetAssignedTasks: typeof GetAssignedTasksExchange;
  readonly SetTaskOrder: typeof SetTaskOrderExchange;
  readonly ConfirmTaskOrder: typeof ConfirmTaskOrderExchange;
  readonly UploadObject: typeof UploadObjectExchange;
  readonly ListObjects: typeof ListObjectsExchange;
  readonly GetObject: typeof GetObjectExchange;
  readonly EditObject: typeof EditObjectExchange;
  readonly DeleteObject: typeof DeleteObjectExchange;
  readonly ReadObjectContent: typeof ReadObjectContentExchange;
  readonly ReleaseHistoryView: typeof ReleaseHistoryViewExchange;
  readonly ReadSnapshot: typeof ReadSnapshotExchange;
  readonly ReleaseSnapshot: typeof ReleaseSnapshotExchange;
  readonly ReadChanges: typeof ReadChangesExchange;
  readonly BeginAssetContact: typeof BeginAssetContactExchange;
  readonly ReplaceAssetProcess: typeof ReplaceAssetProcessExchange;
};
export const exchanges: ExchangeCatalog = Object.freeze({
  ListResources: ListResourcesExchange,
  ReadActivity: ReadActivityExchange,
  ListApiKeys: ListApiKeysExchange,
  CreateApiKey: CreateApiKeyExchange,
  RevokeApiKey: RevokeApiKeyExchange,
  ListOperators: ListOperatorsExchange,
  GetOperator: GetOperatorExchange,
  CreateOperator: CreateOperatorExchange,
  EditOperator: EditOperatorExchange,
  DeleteOperator: DeleteOperatorExchange,
  GetHealth: GetHealthExchange,
  GetReadiness: GetReadinessExchange,
  GetReference: GetReferenceExchange,
  RegisterAsset: RegisterAssetExchange,
  ListAssets: ListAssetsExchange,
  GetAsset: GetAssetExchange,
  GetAssetByAlias: GetAssetByAliasExchange,
  UpdateAsset: UpdateAssetExchange,
  DeleteAsset: DeleteAssetExchange,
  GetAssetStatus: GetAssetStatusExchange,
  GetAssetMovementHistory: GetAssetMovementHistoryExchange,
  GetAssetObjects: GetAssetObjectsExchange,
  CreateObservation: CreateObservationExchange,
  ReportObservation: ReportObservationExchange,
  EditObservation: EditObservationExchange,
  ListObservations: ListObservationsExchange,
  GetObservation: GetObservationExchange,
  GetObservationByAlias: GetObservationByAliasExchange,
  GetObservationMovementHistory: GetObservationMovementHistoryExchange,
  GetObservationObjects: GetObservationObjectsExchange,
  ListTracks: ListTracksExchange,
  GetTrack: GetTrackExchange,
  GetTrackByAlias: GetTrackByAliasExchange,
  EditTrack: EditTrackExchange,
  GetTrackObservations: GetTrackObservationsExchange,
  GetTrackMovementHistory: GetTrackMovementHistoryExchange,
  GetTrackObjects: GetTrackObjectsExchange,
  CreateGeofeature: CreateGeofeatureExchange,
  ListGeofeatures: ListGeofeaturesExchange,
  GetGeofeature: GetGeofeatureExchange,
  GetGeofeatureByAlias: GetGeofeatureByAliasExchange,
  EditGeofeature: EditGeofeatureExchange,
  DeleteGeofeature: DeleteGeofeatureExchange,
  GetGeofeatureObjects: GetGeofeatureObjectsExchange,
  CreateTask: CreateTaskExchange,
  ListTasks: ListTasksExchange,
  GetTask: GetTaskExchange,
  ReportTaskExecution: ReportTaskExecutionExchange,
  RequestTaskCancellation: RequestTaskCancellationExchange,
  ReportTaskResults: ReportTaskResultsExchange,
  GetTaskObjects: GetTaskObjectsExchange,
  GetAssignedTasks: GetAssignedTasksExchange,
  SetTaskOrder: SetTaskOrderExchange,
  ConfirmTaskOrder: ConfirmTaskOrderExchange,
  UploadObject: UploadObjectExchange,
  ListObjects: ListObjectsExchange,
  GetObject: GetObjectExchange,
  EditObject: EditObjectExchange,
  DeleteObject: DeleteObjectExchange,
  ReadObjectContent: ReadObjectContentExchange,
  ReleaseHistoryView: ReleaseHistoryViewExchange,
  ReadSnapshot: ReadSnapshotExchange,
  ReleaseSnapshot: ReleaseSnapshotExchange,
  ReadChanges: ReadChangesExchange,
  BeginAssetContact: BeginAssetContactExchange,
  ReplaceAssetProcess: ReplaceAssetProcessExchange,
});
export type ExchangeName = keyof typeof exchanges;
export type AssignedTasks = z.output<typeof AssignedTasks>;
export type BeginAssetContact = z.output<typeof BeginAssetContact>;
export type ContactChallenge = z.output<typeof ContactChallenge>;
export type ReplaceAssetProcess = z.output<typeof ReplaceAssetProcess>;

export type RequestOf<K extends ExchangeName> = z.output<ExchangeCatalog[K]['request']['schema']>;
export type ResponseOf<K extends ExchangeName> = z.output<ExchangeCatalog[K]['response']['schema']>;
