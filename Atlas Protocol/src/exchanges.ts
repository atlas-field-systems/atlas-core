import { z } from 'zod';
import { caseFoldEquals } from 'unicode-case-folding';
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
import { ObjectEdits, ObjectImage, UploadDescriptor } from './objects.js';
import { Activity, ApiKey, Operator, ResourceUsage } from './administration.js';
import { Continuation, HistoryPage, HistoryQuery, Release, Released } from './history.js';
import {
  associatedQuery,
  filters,
  listQuery,
  page,
  selected,
  selectedAlias,
  selectedPage,
  selection,
} from './queries.js';
import { ReadChanges, ReadSnapshot, ReplayPage, SnapshotPage } from './synchronization.js';
import { messageBudget } from './json.js';
import type { Budget } from './json.js';
import {
  committedPost,
  post,
  pageSize,
  historyMatches,
  durationMatches,
  assetResult,
  observationResult,
  taskResult,
  assetEvidenceResult,
  GetHealthExchange,
  GetReadinessExchange,
  GetReferenceExchange,
  ReadObjectContentExchange,
} from './exchange.js';
export type { JsonExchange } from './exchange.js';

const deleted = z.strictObject({ deleted: z.literal(true) });
const retry = { request_id: NewId };
const edit = { ...retry, expected_edit_revision: Counter };
const descriptiveEdits = z
  .strictObject({
    alias: Alias.nullable().exactOptional(),
    description: Description.nullable().exactOptional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Empty edit');
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

const ListResourcesExchange = post(
  'ListResources',
  '/messages/list_resources',
  listQuery(filters.resources),
  page(ResourceUsage, (value) => value.kind),
  (request, { data }) =>
    pageSize(request, data.items) &&
    selectedPage(request, data.items, (a, f) => selected(f?.kinds, a.kind)),
);
const ReadActivityExchange = post(
  'ReadActivity',
  '/messages/read_activity',
  listQuery(filters.activity),
  page(Activity, (value) => value.activity_id),
  (request, { data }) =>
    pageSize(request, data.items) &&
    selectedPage(request, data.items, (a, f) => selected(f?.categories, a.category)),
);
const ListApiKeysExchange = post(
  'ListApiKeys',
  '/messages/list_api_keys',
  listQuery(filters.api_keys),
  page(ApiKey, (value) => value.api_key_id),
  (request, { data }) =>
    pageSize(request, data.items) &&
    selectedPage(
      request,
      data.items,
      (a, f) =>
        selected(f?.ids, a.api_key_id) && selected(f?.operator_ids, a.operator_id ?? undefined),
    ),
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
  (request, { data }) =>
    request === undefined ||
    (request.api_key_id === data.api_key_id && (request.operator_id ?? null) === data.operator_id),
);
const RevokeApiKeyExchange = committedPost(
  'RevokeApiKey',
  '/messages/revoke_api_key',
  z.strictObject({ ...retry, api_key_id: Uuid }),
  ApiKey,
  (request, { data }) =>
    data.revoked_at !== null && (request === undefined || request.api_key_id === data.api_key_id),
);
const ListOperatorsExchange = post(
  'ListOperators',
  '/messages/list_operators',
  listQuery(filters.operators),
  page(Operator, (value) => value.operator_id),
  (request, { data }) =>
    pageSize(request, data.items) &&
    selectedPage(request, data.items, (a, f) => selected(f?.ids, a.operator_id)),
);
const GetOperatorExchange = post(
  'GetOperator',
  '/messages/get_operator',
  z.strictObject({ operator_id: Uuid }),
  Operator,
  (request, { data }) => request === undefined || request.operator_id === data.operator_id,
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
  (request, { data }) => request === undefined || request.operator_id === data.operator_id,
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
  (request, { data }) => request === undefined || request.operator_id === data.operator_id,
);
const DeleteOperatorExchange = committedPost(
  'DeleteOperator',
  '/messages/delete_operator',
  z.strictObject({ ...retry, operator_id: Uuid }),
  deleted,
  () => true,
);
const RegisterAssetExchange = committedPost(
  'RegisterAsset',
  '/messages/register_asset',
  RegisterAsset,
  z.strictObject({ asset: Asset, api_key: ApiKey }),
  (request, { data }) =>
    request === undefined ||
    (request.asset_id === data.asset.id && request.api_key_id === data.api_key.api_key_id),
);
const ListAssetsExchange = post(
  'ListAssets',
  '/messages/list_assets',
  listQuery(filters.assets),
  page(Asset, (value) => value.id),
  (request, { data }) =>
    pageSize(request, data.items) &&
    selectedPage(request, data.items, (a, f) => selection.asset(f, a)),
);
const GetAssetExchange = post(
  'GetAsset',
  '/messages/get_asset',
  z.strictObject({ asset_id: Uuid }),
  Asset,
  (request, { data }) => request === undefined || request.asset_id === data.id,
);
const GetAssetByAliasExchange = post(
  'GetAssetByAlias',
  '/messages/get_asset_by_alias',
  z.strictObject({ alias: Alias }),
  Asset,
  (request, { data }) =>
    request === undefined ||
    (data.alias !== undefined && caseFoldEquals(request.alias, data.alias)),
);
const UpdateAssetExchange = post(
  'UpdateAsset',
  '/messages/update_asset',
  UpdateAsset,
  assetResult,
  (request, { data, commit_cursor }) =>
    request === undefined ||
    (request.asset_id === data.asset.id &&
      (request.report !== undefined) === (data.evidence_disposition !== undefined) &&
      ((request.alias === undefined &&
        request.description === undefined &&
        request.type === undefined &&
        request.capabilities === undefined) ||
        commit_cursor !== undefined)),
);
const DeleteAssetExchange = committedPost(
  'DeleteAsset',
  '/messages/delete_asset',
  z.strictObject({ ...retry, asset_id: Uuid }),
  deleted,
  () => true,
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
  (request, { data }) => request === undefined || request.asset_id === data.asset_id,
);
const GetAssetMovementHistoryExchange = post(
  'GetAssetMovementHistory',
  '/messages/get_asset_movement_history',
  HistoryQuery,
  HistoryPage,
  (request, { data }) => historyMatches('asset', request, data),
);
const GetAssetObjectsExchange = post(
  'GetAssetObjects',
  '/messages/get_asset_objects',
  associatedQuery({ asset_id: Uuid }),
  page(ObjectImage, (value) => value.object_id),
  (request, { data }) =>
    pageSize(request, data.items) &&
    (request === undefined ||
      'page_token' in request ||
      data.items.every((item) =>
        item.metadata.associations.some(
          (association) => association.kind === 'asset' && association.id === request.asset_id,
        ),
      )),
);
const CreateObservationExchange = committedPost(
  'CreateObservation',
  '/messages/create_observation',
  CreateObservation,
  observationResult,
  (request, { data }) =>
    request === undefined ||
    (request.observation_id === data.observation.id &&
      request.publisher_id === data.observation.publisher_id &&
      request.source_asset_id === data.observation.source_asset_id &&
      request.publisher_subject?.id === data.observation.publisher_subject?.id &&
      request.publisher_subject?.lifetime_id === data.observation.publisher_subject?.lifetime_id &&
      (request.report !== undefined) === (data.evidence_disposition !== undefined)),
);
const ReportObservationExchange = post(
  'ReportObservation',
  '/messages/report_observation',
  ReportObservation,
  observationResult.safeExtend({ evidence_disposition: EvidenceDisposition }),
  (request, { data }) =>
    request === undefined ||
    (request.observation_id === data.observation.id &&
      request.publisher_id === data.observation.publisher_id),
);
const EditObservationExchange = committedPost(
  'EditObservation',
  '/messages/edit_observation',
  z.strictObject({ ...edit, observation_id: Uuid, edits: descriptiveEdits }),
  Observation,
  (request, { data }) => request === undefined || request.observation_id === data.id,
);
const ListObservationsExchange = post(
  'ListObservations',
  '/messages/list_observations',
  listQuery(filters.observations),
  page(Observation, (value) => value.id),
  (request, { data }) =>
    pageSize(request, data.items) &&
    selectedPage(
      request,
      data.items,
      (a, f) =>
        selected(f?.ids, a.id) &&
        selectedAlias(f?.aliases, a.alias) &&
        selected(f?.kinds, a.type.state === 'value' ? a.type.value.kind : undefined) &&
        selected(f?.publisher_ids, a.publisher_id) &&
        selected(f?.source_asset_ids, a.source_asset_id) &&
        selected(f?.track_ids, a.track_id),
    ),
);
const GetObservationExchange = post(
  'GetObservation',
  '/messages/get_observation',
  z.strictObject({ observation_id: Uuid }),
  Observation,
  (request, { data }) => request === undefined || request.observation_id === data.id,
);
const GetObservationByAliasExchange = post(
  'GetObservationByAlias',
  '/messages/get_observation_by_alias',
  z.strictObject({ alias: Alias }),
  Observation,
  (request, { data }) =>
    request === undefined ||
    (data.alias !== undefined && caseFoldEquals(request.alias, data.alias)),
);
const GetObservationMovementHistoryExchange = post(
  'GetObservationMovementHistory',
  '/messages/get_observation_movement_history',
  HistoryQuery,
  HistoryPage,
  (request, { data }) => historyMatches('observation', request, data),
);
const GetObservationObjectsExchange = post(
  'GetObservationObjects',
  '/messages/get_observation_objects',
  associatedQuery({ observation_id: Uuid }),
  page(ObjectImage, (value) => value.object_id),
  (request, { data }) =>
    pageSize(request, data.items) &&
    (request === undefined ||
      'page_token' in request ||
      data.items.every((item) =>
        item.metadata.associations.some(
          (association) =>
            association.kind === 'observation' && association.id === request.observation_id,
        ),
      )),
);
const ListTracksExchange = post(
  'ListTracks',
  '/messages/list_tracks',
  listQuery(filters.tracks),
  page(Track, (value) => value.id),
  (request, { data }) =>
    pageSize(request, data.items) &&
    selectedPage(request, data.items, (a, f) => selection.track(f, a)),
);
const GetTrackExchange = post(
  'GetTrack',
  '/messages/get_track',
  z.strictObject({ track_id: Uuid }),
  Track,
  (request, { data }) => request === undefined || request.track_id === data.id,
);
const GetTrackByAliasExchange = post(
  'GetTrackByAlias',
  '/messages/get_track_by_alias',
  z.strictObject({ alias: Alias }),
  Track,
  (request, { data }) =>
    request === undefined ||
    (data.alias !== undefined && caseFoldEquals(request.alias, data.alias)),
);
const EditTrackExchange = committedPost(
  'EditTrack',
  '/messages/edit_track',
  z.strictObject({ ...edit, track_id: Uuid, edits: descriptiveEdits }),
  Track,
  (request, { data }) => request === undefined || request.track_id === data.id,
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
  (request, { data }) =>
    pageSize(request, data.items) &&
    (request === undefined ||
      'page_token' in request ||
      data.items.every(
        (item) =>
          item.track_id === request.track_id &&
          selected(request.publisher_ids, item.publisher_id) &&
          selected(request.source_asset_ids, item.source_asset_id),
      )),
);
const GetTrackMovementHistoryExchange = post(
  'GetTrackMovementHistory',
  '/messages/get_track_movement_history',
  HistoryQuery,
  HistoryPage,
  (request, { data }) => historyMatches('track', request, data),
);
const GetTrackObjectsExchange = post(
  'GetTrackObjects',
  '/messages/get_track_objects',
  associatedQuery({ track_id: Uuid }),
  page(ObjectImage, (value) => value.object_id),
  (request, { data }) =>
    pageSize(request, data.items) &&
    (request === undefined ||
      'page_token' in request ||
      data.items.every((item) =>
        item.metadata.associations.some(
          (association) => association.kind === 'track' && association.id === request.track_id,
        ),
      )),
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
  (request, { data }) => request === undefined || request.geofeature_id === data.id,
);
const ListGeofeaturesExchange = post(
  'ListGeofeatures',
  '/messages/list_geofeatures',
  listQuery(filters.geofeatures),
  page(Geofeature, (value) => value.id),
  (request, { data }) =>
    pageSize(request, data.items) &&
    selectedPage(request, data.items, (a, f) => selection.geofeature(f, a)),
);
const GetGeofeatureExchange = post(
  'GetGeofeature',
  '/messages/get_geofeature',
  z.strictObject({ geofeature_id: Uuid }),
  Geofeature,
  (request, { data }) => request === undefined || request.geofeature_id === data.id,
);
const GetGeofeatureByAliasExchange = post(
  'GetGeofeatureByAlias',
  '/messages/get_geofeature_by_alias',
  z.strictObject({ alias: Alias }),
  Geofeature,
  (request, { data }) =>
    request === undefined ||
    (data.alias !== undefined && caseFoldEquals(request.alias, data.alias)),
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
  (request, { data }) => request === undefined || request.geofeature_id === data.id,
);
const DeleteGeofeatureExchange = committedPost(
  'DeleteGeofeature',
  '/messages/delete_geofeature',
  z.strictObject({ ...retry, geofeature_id: Uuid }),
  deleted,
  () => true,
);
const GetGeofeatureObjectsExchange = post(
  'GetGeofeatureObjects',
  '/messages/get_geofeature_objects',
  associatedQuery({ geofeature_id: Uuid }),
  page(ObjectImage, (value) => value.object_id),
  (request, { data }) =>
    pageSize(request, data.items) &&
    (request === undefined ||
      'page_token' in request ||
      data.items.every((item) =>
        item.metadata.associations.some(
          (association) =>
            association.kind === 'geofeature' && association.id === request.geofeature_id,
        ),
      )),
);
const CreateTaskExchange = committedPost(
  'CreateTask',
  '/messages/create_task',
  CreateTask,
  Task,
  (request, { data }) =>
    request === undefined ||
    (request.request_id === data.request_id &&
      request.task_id === data.task_id &&
      request.asset_id === data.asset_id &&
      request.command === data.command &&
      request.scheduling === data.scheduling &&
      JSON.stringify(request.inputs) === JSON.stringify(data.inputs) &&
      (request.command !== 'resume' ||
        (data.command === 'resume' && request.expires_at === data.expires_at))),
);
const ListTasksExchange = post(
  'ListTasks',
  '/messages/list_tasks',
  listQuery(filters.tasks),
  page(Task, (value) => value.task_id),
  (request, { data }) =>
    pageSize(request, data.items) &&
    selectedPage(request, data.items, (a, f) => selection.task(f, a)),
);
const GetTaskExchange = post(
  'GetTask',
  '/messages/get_task',
  z.strictObject({ task_id: Uuid }),
  Task,
  (request, { data }) => request === undefined || request.task_id === data.task_id,
);
const ReportTaskExecutionExchange = post(
  'ReportTaskExecution',
  '/messages/report_task_execution',
  ReportTaskExecution,
  taskResult,
  (request, { data }) =>
    request === undefined ||
    (request.evidence.asset_id === data.task.asset_id &&
      request.evidence.payload.task_id === data.task.task_id),
);
const RequestTaskCancellationExchange = post(
  'RequestTaskCancellation',
  '/messages/request_task_cancellation',
  z.strictObject({ ...retry, task_id: Uuid }),
  Task,
  (request, { data, commit_cursor }) =>
    (request === undefined || request.task_id === data.task_id) &&
    (data.execution_state === 'completed' ||
      data.execution_state === 'failed' ||
      data.execution_state === 'cancelled' ||
      (data.cancellation_request_id !== null &&
        commit_cursor !== undefined &&
        (request === undefined || data.cancellation_request_id === request.request_id))),
);
const ReportTaskResultsExchange = post(
  'ReportTaskResults',
  '/messages/report_task_results',
  ReportTaskResults,
  taskResult,
  (request, { data }) =>
    request === undefined ||
    (request.evidence.asset_id === data.task.asset_id &&
      request.evidence.payload.task_id === data.task.task_id),
);
const GetTaskObjectsExchange = post(
  'GetTaskObjects',
  '/messages/get_task_objects',
  associatedQuery({ task_id: Uuid }),
  page(ObjectImage, (value) => value.object_id),
  (request, { data }) => pageSize(request, data.items),
);
const GetAssignedTasksExchange = post(
  'GetAssignedTasks',
  '/messages/get_assigned_tasks',
  z.union([assignedFirst, Continuation]),
  AssignedTasks,
  (request, { data }) =>
    pageSize(request, data.tasks) &&
    (request === undefined ||
      'page_token' in request ||
      (request.asset_id === data.asset_id &&
        request.process_generation === data.process_generation &&
        request.read_id === data.read_id)),
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
  (request, { data }) => request === undefined || request.asset_id === data.id,
);
const ConfirmTaskOrderExchange = post(
  'ConfirmTaskOrder',
  '/messages/confirm_task_order',
  ConfirmTaskOrder,
  assetEvidenceResult,
  (request, { data }) => request === undefined || request.evidence.asset_id === data.asset.id,
);
const UploadObjectExchange = Object.freeze({
  ...committedPost(
    'UploadObject',
    '/objects',
    UploadDescriptor,
    ObjectImage,
    (request, { data }) =>
      request === undefined ||
      (request.object_id === data.object_id &&
        request.byte_length === data.byte_length &&
        request.sha256 === data.sha256 &&
        request.content_type === data.content_type),
  ),
  transport: 'upload',
  requestMedia: 'multipart/form-data',
});
const ListObjectsExchange = post(
  'ListObjects',
  '/messages/list_objects',
  listQuery(filters.objects),
  page(ObjectImage, (value) => value.object_id),
  (request, { data }) =>
    pageSize(request, data.items) &&
    selectedPage(request, data.items, (a, f) => selection.object(f, a)),
);
const GetObjectExchange = post(
  'GetObject',
  '/messages/get_object',
  z.strictObject({ object_id: Uuid }),
  ObjectImage,
  (request, { data }) => request === undefined || request.object_id === data.object_id,
);
const EditObjectExchange = committedPost(
  'EditObject',
  '/messages/edit_object',
  z.strictObject({ ...edit, object_id: Uuid, edits: ObjectEdits }),
  ObjectImage,
  (request, { data }) => request === undefined || request.object_id === data.object_id,
);
const DeleteObjectExchange = committedPost(
  'DeleteObject',
  '/messages/delete_object',
  z.strictObject({ ...retry, object_id: Uuid }),
  deleted,
  () => true,
);

const ReleaseHistoryViewExchange = post(
  'ReleaseHistoryView',
  '/messages/release_history_view',
  Release,
  Released,
  () => true,
);
const snapshot = post(
  'ReadSnapshot',
  '/messages/read_snapshot',
  ReadSnapshot,
  SnapshotPage,
  (request, { data }) =>
    pageSize(request, data.items) &&
    (request === undefined ||
      'page_token' in request ||
      (request.load_id === data.load_id &&
        data.limits.max_message_bytes <= request.max_message_bytes &&
        data.limits.max_json_values <= request.max_json_values &&
        data.limits.max_changes <= request.max_changes)),
);
const ReadSnapshotExchange = Object.freeze({
  ...snapshot,
  response: { ...snapshot.response, messageLimits: { path: ['data', 'limits'] } },
  responseBudget(request: ReadSnapshot | undefined, budget: Budget): Budget {
    return request === undefined || 'page_token' in request
      ? budget
      : messageBudget(budget, request);
  },
});
const ReleaseSnapshotExchange = post(
  'ReleaseSnapshot',
  '/messages/release_snapshot',
  Release,
  Released,
  () => true,
);
const changes = post(
  'ReadChanges',
  '/messages/read_changes',
  ReadChanges,
  ReplayPage,
  (request, { data }) => {
    if (request === undefined || 'page_token' in request) return true;
    const first = data.messages[0];
    return (
      (first === undefined ? data.through_cursor : first.data.previous_cursor) ===
      request.from_cursor
    );
  },
);
const ReadChangesExchange = Object.freeze({
  ...changes,
  responseBudget(request: ReadChanges | undefined, budget: Budget): Budget {
    return request === undefined || 'page_token' in request
      ? budget
      : messageBudget(budget, request);
  },
});
const BeginAssetContactExchange = post(
  'BeginAssetContact',
  '/messages/begin_asset_contact',
  BeginAssetContact,
  ContactChallenge,
  (request, { data }) =>
    request === undefined ||
    (request.asset_id === data.asset_id &&
      request.process_generation === data.process_generation &&
      (request.mode === 'current'
        ? data.mode === 'current'
        : data.mode === 'replace' &&
          request.expected_process_generation === data.expected_process_generation)),
);
const ReplaceAssetProcessExchange = committedPost(
  'ReplaceAssetProcess',
  '/messages/replace_asset_process',
  ReplaceAssetProcess,
  assetEvidenceResult,
  (request, { data }) =>
    request === undefined ||
    (request.asset_id === data.asset.id &&
      request.process_generation === data.asset.process_generation),
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
