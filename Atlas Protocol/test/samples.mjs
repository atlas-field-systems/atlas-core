export const id = '11111111-1111-4111-8111-111111111111';
export const assetId = '22222222-2222-4222-8222-222222222222';
export const processId = '33333333-3333-4333-8333-333333333333';
export const requestId = '44444444-4444-4444-8444-444444444444';
export const taskId = '55555555-5555-4555-8555-555555555555';
export const observationId = '66666666-6666-4666-8666-666666666666';
export const trackId = '77777777-7777-4777-8777-777777777777';
export const time = '2026-10-23T00:00:00.100Z';
export const later = '2026-10-23T00:00:10Z';
export const origin = { kind: 'asset_process', process_generation: processId };
export const queue = { requested_task_ids: [], revision: '0', confirmed: null };
export const control = { revision: '0', requested: null, confirmed: null };
const initial = (value) => ({
  state: 'value',
  classification: 'state_until_changed',
  observed_at: null,
  value,
  evidence: null,
  time_status: Object.fromEntries(Object.keys(value).map((key) => [key, 'unknown'])),
});
export const asset = {
  dataset_id: id,
  id: assetId,
  entity_type: 'asset',
  version: '0',
  edit_revision: '0',
  type: { kind: null },
  capabilities: { commands: [] },
  process_generation: processId,
  status: initial({ condition: 'unknown' }),
  communications: { health: 'offline', capacity: initial({ bandwidth_bps: null }) },
  heartbeat: { last_contact_at: null },
  task_queue: queue,
  task_control: control,
};
export const observation = {
  dataset_id: id,
  id: observationId,
  entity_type: 'observation',
  version: '0',
  edit_revision: '0',
  publisher_id: processId,
  track_id: trackId,
  type: initial({ kind: null }),
};
export const track = {
  dataset_id: id,
  id: trackId,
  entity_type: 'track',
  version: '0',
  edit_revision: '0',
  sources: [{ observation_id: observationId, publisher_id: processId }],
  type: initial({ kind: null }),
};
export const geometry = { type: 'Point', coordinates: [0, 0] };
const mixedRing = [
  ...Array.from({ length: 256 }, (_, i) => [i / 256, i === 128 ? Number.MIN_VALUE : 0]),
  ...Array.from({ length: 256 }, (_, i) => [1, i / 256]),
  ...Array.from({ length: 256 }, (_, i) => [1 - i / 256, 1]),
  ...Array.from({ length: 255 }, (_, i) => [0, 1 - i / 255]),
  [0, 0],
];
export const mixedPolygon = { type: 'Polygon', coordinates: [mixedRing] };
export const geofeature = {
  dataset_id: id,
  id: requestId,
  entity_type: 'geofeature',
  version: '0',
  edit_revision: '0',
  type: { kind: null },
  geometry,
  geometry_revision: '0',
};
export const createTask = {
  request_id: requestId,
  task_id: taskId,
  asset_id: assetId,
  command: 'move_to',
  scheduling: 'queued',
  inputs: { target: { kind: 'position', position: { latitude: 0, longitude: 0 } } },
};
export const task = {
  ...createTask,
  dataset_id: id,
  version: '0',
  accepted_at: time,
  submission_sequence: '1',
  execution_state: 'pending',
  cancellation_request_id: null,
  result_declarations: [],
};
export const storage = {
  byte_length: '0',
  sha256: '0'.repeat(64),
  content_type: 'application/octet-stream',
};
export const object = {
  dataset_id: id,
  object_id: requestId,
  version: '0',
  edit_revision: '0',
  created_at: time,
  ...storage,
  metadata: { associations: [] },
};
export const apiKey = {
  api_key_id: requestId,
  operator_id: null,
  created_at: time,
  revoked_at: null,
};
export const operator = { operator_id: requestId, name: 'Operator', edit_revision: '0' };
export const limits = { max_message_bytes: 4194304, max_json_values: 262144, max_changes: 1000 };
export const health = {
  healthy: true,
  protocol_version: '0.2.0',
  core_run_id: requestId,
  allocation_context: 'allocation context',
  allocation_expires_at: later,
  limits: {
    ...limits,
    max_request_bytes: 1048576,
    max_request_json_values: 65536,
    max_control_bytes: 16384,
    max_control_json_values: 4096,
    max_json_depth: 32,
    max_object_bytes: 2000000000,
  },
  temporary_limits: {
    max_snapshot_captures: 1,
    max_snapshot_captures_per_key: 1,
    max_snapshot_bytes: '2147483648',
    max_total_snapshot_bytes: '2147483648',
    max_history_views: 1,
    max_history_views_per_key: 1,
    max_history_references_per_view: 1000,
    max_total_history_references: 1000,
    max_history_bytes: '2147483648',
    max_contact_challenges: 1,
    max_allocation_receipts: 10,
  },
};
export const report = {
  dataset_id: id,
  entity_id: assetId,
  origin,
  report_id: requestId,
  sequence: '1',
  generated_at: time,
  mode: 'current',
  sections: {
    status: {
      state: 'value',
      classification: 'dated_measurement',
      observed_at: null,
      value: { condition: 'healthy' },
    },
  },
};
export const observationReport = {
  ...report,
  entity_id: observationId,
  origin: { kind: 'publisher', publisher_id: processId },
  sections: {
    type: {
      state: 'value',
      classification: 'dated_measurement',
      observed_at: null,
      value: { kind: 'person' },
    },
  },
};
export const evidence = (payload) => ({
  dataset_id: id,
  asset_id: assetId,
  origin,
  report_id: requestId,
  sequence: '1',
  generated_at: null,
  payload,
});
export const historyFirst = {
  entity_id: assetId,
  query_id: requestId,
  allocation_context: 'context',
};
export const historyPage = {
  query_id: requestId,
  view_id: requestId,
  source: 'core',
  baseline_cursor: 'cursor',
  expires_at: later,
  release_token: 'release',
  readings: [],
  next_page_token: null,
};
export const snapshotFirst = {
  allocation_context: 'context',
  load_id: requestId,
  page_size: 100,
  ...limits,
};
export const snapshot = {
  load_id: requestId,
  capture_id: requestId,
  baseline_cursor: 'cursor',
  expires_at: later,
  limits,
  items: [],
  next_page_token: null,
  release_token: 'release',
};
export const replay = {
  replay_boundary: 'cursor',
  messages: [],
  through_cursor: 'cursor',
  next_page_token: null,
};
const page = (value) => ({ items: [value], next_page_token: null });
const retry = { request_id: requestId };
const edit = { ...retry, expected_edit_revision: '0' };
const assetRequest = { asset_id: assetId };
const objectRequest = { object_id: requestId };
const trackRequest = { track_id: trackId };
const observationRequest = { observation_id: observationId };
const geofeatureRequest = { geofeature_id: requestId };
const taskRequest = { task_id: taskId };
const operatorRequest = { operator_id: requestId };
const deleted = { deleted: true };
export const examples = {
  ListResources: [{}, page({ kind: 'storage', used: '0', capacity: '2147483648' })],
  ReadActivity: [
    {},
    page({
      activity_id: requestId,
      at: time,
      category: 'core_started',
      message: '',
      api_key_id: null,
      operator_id: null,
      operator_deleted: false,
    }),
  ],
  ListApiKeys: [{}, page(apiKey)],
  CreateApiKey: [{ ...retry, api_key_id: requestId, secret: 'A'.repeat(43) }, apiKey],
  RevokeApiKey: [
    { ...retry, api_key_id: requestId },
    { ...apiKey, revoked_at: time },
  ],
  ListOperators: [{}, page(operator)],
  GetOperator: [operatorRequest, operator],
  CreateOperator: [{ ...retry, ...operatorRequest, name: 'Operator' }, operator],
  EditOperator: [{ ...edit, ...operatorRequest, edits: { description: null } }, operator],
  DeleteOperator: [{ ...retry, ...operatorRequest }, deleted],
  GetHealth: [{}, health],
  GetReadiness: [{}, { ready: true }],
  GetReference: [{}, null],
  RegisterAsset: [
    {
      ...retry,
      asset_id: assetId,
      registration_id: requestId,
      process_generation: processId,
      api_key_id: requestId,
      secret: 'A'.repeat(43),
    },
    { asset, api_key: apiKey },
  ],
  ListAssets: [{}, page(asset)],
  GetAsset: [assetRequest, asset],
  GetAssetByAlias: [{ alias: 'A' }, { ...asset, alias: 'A' }],
  UpdateAsset: [
    { ...retry, ...assetRequest, report },
    { asset, evidence_disposition: 'accepted' },
  ],
  DeleteAsset: [{ ...retry, ...assetRequest }, deleted],
  GetAssetStatus: [
    assetRequest,
    {
      asset_id: assetId,
      status: asset.status,
      communications: asset.communications,
      heartbeat: asset.heartbeat,
    },
  ],
  GetAssetMovementHistory: [historyFirst, historyPage],
  GetAssetObjects: [
    assetRequest,
    page({ ...object, metadata: { associations: [{ kind: 'asset', id: assetId }] } }),
  ],
  CreateObservation: [
    { ...retry, ...observationRequest, publisher_id: processId },
    { observation, track },
  ],
  ReportObservation: [
    { ...observationRequest, publisher_id: processId, report: observationReport },
    { observation, track, evidence_disposition: 'accepted' },
  ],
  EditObservation: [{ ...edit, ...observationRequest, edits: { alias: null } }, observation],
  ListObservations: [{}, page(observation)],
  GetObservation: [observationRequest, observation],
  GetObservationByAlias: [{ alias: 'O' }, { ...observation, alias: 'O' }],
  GetObservationMovementHistory: [{ ...historyFirst, entity_id: observationId }, historyPage],
  GetObservationObjects: [
    observationRequest,
    page({ ...object, metadata: { associations: [{ kind: 'observation', id: observationId }] } }),
  ],
  ListTracks: [{}, page(track)],
  GetTrack: [trackRequest, track],
  GetTrackByAlias: [{ alias: 'T' }, { ...track, alias: 'T' }],
  EditTrack: [{ ...edit, ...trackRequest, edits: { description: null } }, track],
  GetTrackObservations: [trackRequest, page(observation)],
  GetTrackMovementHistory: [{ ...historyFirst, entity_id: trackId }, historyPage],
  GetTrackObjects: [
    trackRequest,
    page({ ...object, metadata: { associations: [{ kind: 'track', id: trackId }] } }),
  ],
  CreateGeofeature: [{ ...retry, ...geofeatureRequest, geometry }, geofeature],
  ListGeofeatures: [{}, page(geofeature)],
  GetGeofeature: [geofeatureRequest, geofeature],
  GetGeofeatureByAlias: [{ alias: 'G' }, { ...geofeature, alias: 'G' }],
  EditGeofeature: [{ ...edit, ...geofeatureRequest, edits: { geometry } }, geofeature],
  DeleteGeofeature: [{ ...retry, ...geofeatureRequest }, deleted],
  GetGeofeatureObjects: [
    geofeatureRequest,
    page({ ...object, metadata: { associations: [{ kind: 'geofeature', id: requestId }] } }),
  ],
  CreateTask: [createTask, task],
  ListTasks: [{}, page(task)],
  GetTask: [taskRequest, task],
  ReportTaskExecution: [
    { evidence: evidence({ ...taskRequest, event: 'state', state: 'in_progress' }) },
    { task, evidence_disposition: 'accepted' },
  ],
  RequestTaskCancellation: [
    { ...retry, ...taskRequest },
    { ...task, cancellation_request_id: requestId },
  ],
  ReportTaskResults: [
    {
      evidence: evidence({
        ...taskRequest,
        declarations: [{ object_id: requestId, required: true }],
      }),
    },
    { task, evidence_disposition: 'accepted' },
  ],
  GetTaskObjects: [taskRequest, page(object)],
  GetAssignedTasks: [
    { ...assetRequest, process_generation: processId, read_id: requestId },
    {
      ...assetRequest,
      process_generation: processId,
      read_id: requestId,
      core_run_id: requestId,
      captured_at: time,
      instructions_valid_until: '2026-10-23T00:00:10.100Z',
      task_queue: { ...queue, requested_task_ids: [taskId] },
      task_control: control,
      tasks: [task],
      next_page_token: null,
    },
  ],
  SetTaskOrder: [{ ...retry, ...assetRequest, expected_queue_revision: '0', task_ids: [] }, asset],
  ConfirmTaskOrder: [
    { evidence: evidence({ queue_revision: '0' }) },
    { asset, evidence_disposition: 'accepted' },
  ],
  UploadObject: [
    { ...retry, ...objectRequest, ...storage, metadata: { associations: [] } },
    object,
  ],
  ListObjects: [{}, page(object)],
  GetObject: [objectRequest, object],
  EditObject: [{ ...edit, ...objectRequest, edits: { name: null } }, object],
  DeleteObject: [{ ...retry, ...objectRequest }, deleted],
  ReadObjectContent: [{ ...objectRequest, disposition: 'inline' }, null],
  ReleaseHistoryView: [{ release_token: 'release' }, { released: true }],
  ReadSnapshot: [snapshotFirst, snapshot],
  ReleaseSnapshot: [{ release_token: 'release' }, { released: true }],
  ReadChanges: [{ from_cursor: 'cursor', ...limits }, replay],
  BeginAssetContact: [
    {
      ...retry,
      ...assetRequest,
      process_generation: processId,
      allocation_context: 'context',
      mode: 'current',
    },
    {
      challenge_id: requestId,
      ...assetRequest,
      process_generation: processId,
      mode: 'current',
      core_run_id: requestId,
      issued_at: time,
      expires_at: later,
    },
  ],
  ReplaceAssetProcess: [
    {
      ...retry,
      ...assetRequest,
      expected_process_generation: requestId,
      process_generation: processId,
      challenge_id: requestId,
      first_report: { ...report, contact_proof: { challenge_id: requestId } },
    },
    { asset, evidence_disposition: 'accepted' },
  ],
};

export const wssExamples = {
  SubscribeChanges: [
    { subscription_id: requestId, from_cursor: 'cursor', ...limits },
    { subscription_id: requestId, handoff_cursor: 'cursor', limits },
  ],
  UnsubscribeChanges: [{ subscription_id: requestId }, { subscription_id: requestId }],
};
