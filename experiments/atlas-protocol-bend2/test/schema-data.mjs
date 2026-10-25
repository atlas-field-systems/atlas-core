import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(resolve(process.argv[2]));
const { default: bend } = await import(moduleUrl);
const require = createRequire(moduleUrl);
const { default: Ajv2020 } = await import(
  pathToFileURL(require.resolve("ajv/dist/2020.js"))
);

function list(node) {
  const values = [];
  while (node.$ === "Con") {
    values.push(node.head);
    node = node.tail;
  }
  assert.equal(node.$, "Nil");
  return values;
}

function json(node) {
  switch (node.$) {
    case "JNull":
      return null;
    case "JBool":
    case "JStr":
      return node.value;
    case "JNum": {
      const value = Number(node.raw);
      assert(
        Number.isFinite(value),
        "Schema numeric metadata must remain finite.",
      );
      return value;
    }
    case "JArr":
      return list(node.items).map(json);
    case "JObj": {
      const entries = list(node.members).map(({ key, value }) => [
        key,
        json(value),
      ]);
      assert.equal(
        new Set(entries.map(([key]) => key)).size,
        entries.length,
        "Duplicate schema member.",
      );
      return Object.fromEntries(entries);
    }
    default:
      assert.fail(`Unexpected schema constructor ${node.$}`);
  }
}

const publicInventory = `
Uuid NewId Opaque Alias Counter Sequence Secret Timestamp Float Integer PageSize Latitude Longitude Time Position Altitude
Point LineString Polygon Geometry
Description AssetDescription AssetType SubjectKind SubjectType GeofeatureKind GeofeatureType Status Telemetry Attitude Gimbal Camera CameraOptics Capacity Health Heartbeat Reserve Power PowerTimes
Command CreateTask Capabilities
AssetOrigin PublisherOrigin Origin Constituent Constituents SectionName SectionEvidence SectionError EvidenceDisposition AssetReport ObservationReport
ExecutionState NonterminalState ResultDeclaration ResultDeclarations TaskQueue TaskControl ExecutionPayload ExecutionEvidence ReportTaskExecution ReportTaskResults QueueConfirmation ConfirmTaskOrder Task
PublisherSubject Communications TrackSource Asset Observation Track Geofeature
ContentType Sha256 ObjectLength Association Associations ObjectMetadata UploadDescriptor ObjectEdits ContentDescriptor ObjectImage
Operator ApiKey ResourceUsage Activity MessageLimits NegotiatedLimits TemporaryLimits HealthData Readiness
TimeStatus HistoryReading HistoryFirst Continuation HistoryQuery HistoryPage Release Released
ErrorObject HttpError
ResourceKind Put Delete Change Changes ReadSnapshot SnapshotPage ReplayBatch ReplayProgress ReplayMessage ReadChanges ReplayPage SubscribeChanges UnsubscribeChanges Subscribed Unsubscribed Authenticate ClientFrame ServerFrame
AssignedTasks BeginAssetContact ContactChallenge ReplaceAssetProcess
`
  .trim()
  .split(/\s+/);
const sections = [
  "status",
  "communications",
  "telemetry",
  "attitude",
  "power",
  "camera",
  "camera_optics",
  "gimbal",
  "type",
  "geometry",
];
const names = list(bend.names());
assert.equal(new Set(names).size, names.length);
assert.equal(new Set(list(bend.public_names())).size, publicInventory.length);
assert.deepEqual(
  [...list(bend.public_names())].sort(),
  [...publicInventory].sort(),
);
assert.deepEqual(list(bend.section_names()), sections);
assert.deepEqual(bend.schema("NoSuchSchema"), { $: "JMissing" });
assert.deepEqual(bend.schema("Request.CreateTask"), { $: "JMissing" });
assert.deepEqual(bend.schema("Response.CreateTask"), { $: "JMissing" });
for (const section of sections) {
  assert(names.includes(`InputSection.${section}`));
  assert(names.includes(`ReadSection.${section}`));
}
for (const command of ["move_to", "pause", "resume"])
  assert(names.includes(`Command.${command}`));

const schemas = Object.fromEntries(
  names.map((name) => [name, json(bend.schema(name))]),
);
const keywords = new Set([
  "title",
  "type",
  "$ref",
  "const",
  "enum",
  "anyOf",
  "oneOf",
  "properties",
  "required",
  "additionalProperties",
  "minProperties",
  "maxProperties",
  "propertyNames",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
]);
const directChildren = ["additionalProperties", "propertyNames", "items"];
const listChildren = ["anyOf", "oneOf", "prefixItems"];
let references = 0;
function inspect(schema) {
  if (typeof schema === "boolean") return;
  for (const key of Object.keys(schema))
    assert(keywords.has(key), `Nonstandard or unsupported keyword ${key}`);
  if (schema.$ref) {
    assert(schema.$ref.startsWith("#/components/schemas/"));
    assert(
      Object.hasOwn(schemas, schema.$ref.slice("#/components/schemas/".length)),
      `Dangling ${schema.$ref}`,
    );
    references++;
  }
  if (schema.type === "object") {
    if (schema.propertyNames) {
      assert.equal(schema.maxProperties, 16);
      assert.equal(schema.propertyNames.$ref, "#/components/schemas/Uuid");
    } else {
      assert.equal(schema.additionalProperties, false);
      assert.equal(new Set(schema.required).size, schema.required.length);
      for (const key of schema.required)
        assert(Object.hasOwn(schema.properties, key));
    }
  }
  for (const child of Object.values(schema.properties ?? {})) inspect(child);
  for (const key of directChildren)
    if (schema[key] !== undefined) inspect(schema[key]);
  for (const key of listChildren)
    for (const child of schema[key] ?? []) inspect(child);
}

const ajv = new Ajv2020({ strict: true, strictSchema: false, allErrors: true });
const documentId = "urn:atlas:bend:structural-schemas";
ajv.addSchema({
  $id: documentId,
  $schema: "https://json-schema.org/draft/2020-12/schema",
  components: { schemas },
});
const validators = new Map();
for (const [name, schema] of Object.entries(schemas)) {
  assert.equal(schema.title, name);
  inspect(schema);
  assert(ajv.validateSchema(schema), `${name} is not JSON Schema 2020-12.`);
  validators.set(
    name,
    ajv.getSchema(`${documentId}#/components/schemas/${name}`),
  );
}

const floatBounds = Object.fromEntries(
  list(bend.schema("Float").members).map(({ key, value }) => [key, value]),
);
assert.equal(BigInt(floatBounds.maximum.raw), 2n ** 1024n - 2n ** 971n);
assert.equal(BigInt(floatBounds.minimum.raw), -(2n ** 1024n - 2n ** 971n));

let cases = 0;
function check(name, value, accepted) {
  const validator = validators.get(name);
  assert(validator, name);
  const before = structuredClone(value);
  const result = validator(value);
  assert.equal(
    result,
    accepted,
    `${name} expected ${accepted}, got ${JSON.stringify(validator.errors)} for ${JSON.stringify(value)}`,
  );
  assert.deepEqual(value, before, `${name} mutated its input.`);
  cases++;
}

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const dataset = id(1),
  assetId = id(2),
  observationId = id(3),
  trackId = id(4),
  generation = id(5),
  publisherId = id(6);
const at = "2026-10-25T12:00:00.123456789Z";
const later = "2026-10-25T12:00:10.123456789Z";
const assetOrigin = { kind: "asset_process", process_generation: generation };
const publisherOrigin = { kind: "publisher", publisher_id: publisherId };
const constituent = { origin: assetOrigin, reading_id: id(7) };
const constituents = {
  position: constituent,
  altitude: constituent,
  ground_speed: constituent,
};
const sectionEvidence = (section) => ({
  dataset_id: dataset,
  entity_id: assetId,
  origin: assetOrigin,
  report_id: id(8),
  sequence: "1",
  section,
});
const input = (value) => ({
  state: "value",
  classification: "state_until_changed",
  observed_at: null,
  value,
});
const read = (section, value) => ({
  ...input(value),
  evidence: sectionEvidence(section),
});
const initial = (value) => ({ ...input(value), evidence: null });
const telemetry = { position: null, altitude: null, ground_speed: 0 };
const point = { type: "Point", coordinates: [-180, 90] };
const line = {
  type: "LineString",
  coordinates: [
    [0, 0],
    [180, 0],
  ],
};
const polygon = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ],
  ],
};
const queue = { requested_task_ids: [], revision: "0", confirmed: null };
const control = { revision: "0", requested: null, confirmed: null };
const command = {
  command: "move_to",
  scheduling: "queued",
  inputs: {
    target: { kind: "position", position: { latitude: 0, longitude: 0 } },
  },
};
const task = {
  ...command,
  dataset_id: dataset,
  task_id: id(9),
  request_id: id(10),
  asset_id: assetId,
  version: "0",
  accepted_at: at,
  submission_sequence: "1",
  result_declarations: [],
  execution_state: "pending",
  cancellation_request_id: null,
};
const evidence = (payload) => ({
  dataset_id: dataset,
  asset_id: assetId,
  origin: assetOrigin,
  report_id: id(11),
  sequence: "1",
  generated_at: null,
  payload,
});
const payload = { task_id: task.task_id, event: "state", state: "completed" };
const communications = {
  health: "offline",
  capacity: initial({ bandwidth_bps: null }),
};
const asset = {
  dataset_id: dataset,
  id: assetId,
  entity_type: "asset",
  version: "0",
  edit_revision: "0",
  type: { kind: null },
  capabilities: { commands: [] },
  process_generation: generation,
  status: initial({ condition: "unknown" }),
  communications,
  heartbeat: { last_contact_at: null },
  task_queue: queue,
  task_control: control,
};
const observation = {
  dataset_id: dataset,
  id: observationId,
  entity_type: "observation",
  version: "0",
  edit_revision: "0",
  publisher_id: publisherId,
  track_id: trackId,
  type: initial({ kind: null }),
};
const source = { observation_id: observationId, publisher_id: publisherId };
const track = {
  dataset_id: dataset,
  id: trackId,
  entity_type: "track",
  version: "0",
  edit_revision: "0",
  sources: [source],
  type: initial({ kind: null }),
};
const geofeature = {
  dataset_id: dataset,
  id: id(12),
  entity_type: "geofeature",
  version: "0",
  edit_revision: "0",
  type: { kind: null },
  geometry: point,
  geometry_revision: "0",
};
const storage = {
  byte_length: "0",
  sha256: "0".repeat(64),
  content_type: "application/octet-stream",
};
const object = {
  ...storage,
  dataset_id: dataset,
  object_id: id(13),
  version: "0",
  edit_revision: "0",
  created_at: at,
  metadata: { associations: [] },
};
const limits = {
  max_message_bytes: 4194304,
  max_json_values: 262144,
  max_changes: 1000,
};
const messageLimits = {
  ...limits,
  max_request_bytes: 1048576,
  max_request_json_values: 65536,
  max_control_bytes: 16384,
  max_control_json_values: 4096,
  max_json_depth: 32,
  max_object_bytes: 2000000000,
};
const temporaryLimits = {
  max_snapshot_captures: 0,
  max_snapshot_captures_per_key: 0,
  max_snapshot_bytes: "0",
  max_total_snapshot_bytes: "0",
  max_history_views: 0,
  max_history_views_per_key: 0,
  max_history_references_per_view: 0,
  max_total_history_references: 0,
  max_history_bytes: "0",
  max_contact_challenges: 0,
  max_allocation_receipts: 0,
};
const reading = {
  source_entity_kind: "asset",
  source_entity_id: assetId,
  source_evidence: constituent,
  quantity: "position",
  value: null,
  observed_at: null,
  time_status: "unknown",
  track_ids: [],
};
const historyFirst = {
  entity_id: assetId,
  query_id: id(14),
  allocation_context: "allocation",
};
const assetReport = {
  dataset_id: dataset,
  entity_id: assetId,
  origin: assetOrigin,
  report_id: id(15),
  sequence: "1",
  generated_at: at,
  mode: "current",
  sections: { status: input({ condition: "healthy" }) },
};
const observationReport = {
  ...assetReport,
  entity_id: observationId,
  origin: publisherOrigin,
  sections: { type: input({ kind: "aircraft" }) },
};
const put = {
  kind: "put",
  resource_kind: "asset",
  resource_id: assetId,
  version: "0",
  image: asset,
};
const deletion = {
  kind: "delete",
  resource_kind: "asset",
  resource_id: assetId,
  version: "1",
};
const batchData = { previous_cursor: "a", commit_cursor: "b", changes: [put] };
const batch = { type: "change_batch", data: batchData };
const progress = {
  type: "progress",
  data: { previous_cursor: "b", through_cursor: "c" },
};
const replay = {
  replay_boundary: "c",
  messages: [batch, progress],
  through_cursor: "c",
  next_page_token: null,
};
const snapshot = {
  load_id: id(16),
  capture_id: id(17),
  baseline_cursor: "a",
  expires_at: later,
  limits,
  items: [put],
  next_page_token: null,
  release_token: "release",
};
const context = { dataset_id: dataset, protocol_version: "0.1.0" };
const authenticate = {
  ...context,
  type: "authenticate",
  request_id: id(18),
  api_key: "A".repeat(43),
};
const clientFrame = {
  ...context,
  type: "read_snapshot",
  request_id: id(18),
  data: {
    allocation_context: "allocation",
    load_id: id(16),
    page_size: 10,
    ...limits,
  },
};
const serverFrame = {
  ...context,
  type: "read_snapshot_result",
  request_id: id(18),
  data: snapshot,
};
const error = {
  code: "invalid_request",
  message: "invalid",
  request_id: id(19),
};
const challenge = {
  challenge_id: id(20),
  asset_id: assetId,
  process_generation: generation,
  core_run_id: id(21),
  issued_at: at,
  expires_at: later,
  mode: "current",
};
const samples = {
  Uuid: assetId,
  NewId: id(1),
  Opaque: " ",
  Alias: "Asset",
  Counter: "18446744073709551615",
  Sequence: "1",
  Secret: "A".repeat(43),
  Timestamp: at,
  Float: -1.5,
  Integer: 0,
  PageSize: 1000,
  Latitude: -90,
  Longitude: 180,
  Time: null,
  Position: { latitude: 0, longitude: 0 },
  Altitude: { metres: -1, reference: "wgs84_ellipsoid" },
  Point: point,
  LineString: line,
  Polygon: polygon,
  Geometry: polygon,
  Description: { name: "Asset" },
  AssetDescription: { name: "Asset", manufacturer: "Maker", model: "M" },
  AssetType: { kind: "drone", variant: null },
  SubjectKind: "person",
  SubjectType: { kind: null },
  GeofeatureKind: "route",
  GeofeatureType: { kind: "route" },
  Status: { condition: "unknown" },
  Telemetry: telemetry,
  Attitude: { heading: null, pitch: 90, roll: null },
  Gimbal: { bearing: null, elevation: -90 },
  Camera: { zoom_ratio: 1 },
  CameraOptics: { horizontal_fov: 90, vertical_fov: null },
  Capacity: { bandwidth_bps: null },
  Health: "offline",
  Heartbeat: { last_contact_at: null },
  Reserve: { id: id(22), kind: "fuel", remaining_percent: null },
  Power: { external_power: null, reserves: [] },
  PowerTimes: { reserves: { [id(22)]: { remaining_percent: null } } },
  Command: command,
  CreateTask: {
    ...command,
    request_id: id(10),
    task_id: id(9),
    asset_id: assetId,
  },
  Capabilities: {
    commands: [
      { command: "move_to", scheduling: ["queued"] },
      { command: "pause", scheduling: ["immediate"] },
    ],
  },
  AssetOrigin: assetOrigin,
  PublisherOrigin: publisherOrigin,
  Origin: publisherOrigin,
  Constituent: constituent,
  Constituents: constituents,
  SectionName: "communications",
  SectionEvidence: sectionEvidence("status"),
  SectionError: { code: "sensor" },
  EvidenceDisposition: "accepted",
  AssetReport: assetReport,
  ObservationReport: observationReport,
  ExecutionState: "pending",
  NonterminalState: "paused",
  ResultDeclaration: { object_id: id(13), required: true },
  ResultDeclarations: [],
  TaskQueue: queue,
  TaskControl: control,
  ExecutionPayload: payload,
  ExecutionEvidence: evidence(payload),
  ReportTaskExecution: { evidence: evidence(payload) },
  ReportTaskResults: {
    evidence: evidence({
      task_id: id(9),
      declarations: [{ object_id: id(13), required: true }],
    }),
  },
  QueueConfirmation: { queue_revision: "0" },
  ConfirmTaskOrder: { evidence: evidence({ queue_revision: "0" }) },
  Task: task,
  PublisherSubject: { id: "track-1", lifetime_id: id(23) },
  Communications: communications,
  TrackSource: source,
  Asset: asset,
  Observation: observation,
  Track: track,
  Geofeature: geofeature,
  ContentType: "image/jpeg",
  Sha256: "a".repeat(64),
  ObjectLength: "2000000000",
  Association: { kind: "track", id: trackId },
  Associations: [{ kind: "track", id: trackId }],
  ObjectMetadata: object.metadata,
  UploadDescriptor: {
    ...storage,
    request_id: id(24),
    object_id: id(13),
    metadata: object.metadata,
  },
  ObjectEdits: { name: null },
  ContentDescriptor: { ...storage, object_id: id(13), disposition: "inline" },
  ObjectImage: object,
  Operator: { operator_id: id(25), name: "Operator", edit_revision: "0" },
  ApiKey: {
    api_key_id: id(26),
    operator_id: null,
    created_at: at,
    revoked_at: null,
  },
  ResourceUsage: { kind: "assets", used: "0", capacity: "100" },
  Activity: {
    activity_id: id(27),
    at,
    category: "reset",
    message: "",
    api_key_id: null,
    operator_id: null,
    operator_deleted: false,
  },
  MessageLimits: messageLimits,
  NegotiatedLimits: limits,
  TemporaryLimits: temporaryLimits,
  HealthData: {
    healthy: true,
    protocol_version: "0.1.0",
    core_run_id: id(21),
    limits: messageLimits,
    temporary_limits: temporaryLimits,
    allocation_context: "allocation",
    allocation_expires_at: later,
  },
  Readiness: { ready: false },
  TimeStatus: "unknown",
  HistoryReading: reading,
  HistoryFirst: historyFirst,
  Continuation: { page_token: "page" },
  HistoryQuery: historyFirst,
  HistoryPage: {
    query_id: id(14),
    view_id: id(28),
    source: "core",
    baseline_cursor: "a",
    expires_at: later,
    release_token: "release",
    readings: [reading],
    next_page_token: null,
  },
  Release: { release_token: "release" },
  Released: { released: true },
  ErrorObject: error,
  HttpError: {
    kind: "error",
    status: 400,
    body: { dataset_id: dataset, error },
  },
  ResourceKind: "object",
  Put: put,
  Delete: deletion,
  Change: put,
  Changes: [put],
  ReadSnapshot: clientFrame.data,
  SnapshotPage: snapshot,
  ReplayBatch: batch,
  ReplayProgress: progress,
  ReplayMessage: batch,
  ReadChanges: { from_cursor: "a", ...limits },
  ReplayPage: replay,
  SubscribeChanges: { subscription_id: id(29), from_cursor: "a", ...limits },
  UnsubscribeChanges: { subscription_id: id(29) },
  Subscribed: { subscription_id: id(29), handoff_cursor: "c", limits },
  Unsubscribed: { subscription_id: id(29) },
  Authenticate: authenticate,
  ClientFrame: clientFrame,
  ServerFrame: serverFrame,
  AssignedTasks: {
    asset_id: assetId,
    process_generation: generation,
    read_id: id(30),
    core_run_id: id(21),
    captured_at: at,
    instructions_valid_until: later,
    task_queue: queue,
    task_control: control,
    tasks: [task],
    next_page_token: null,
  },
  BeginAssetContact: {
    request_id: id(31),
    allocation_context: "allocation",
    asset_id: assetId,
    process_generation: generation,
    mode: "current",
  },
  ContactChallenge: challenge,
  ReplaceAssetProcess: {
    request_id: id(32),
    asset_id: assetId,
    expected_process_generation: id(33),
    process_generation: generation,
    challenge_id: id(20),
    first_report: { ...assetReport, contact_proof: { challenge_id: id(20) } },
  },
};
assert.deepEqual(Object.keys(samples).sort(), [...publicInventory].sort());
for (const [name, sample] of Object.entries(samples)) {
  check(name, sample, true);
  if (sample !== null && !Array.isArray(sample) && typeof sample === "object")
    check(name, { ...sample, unexpected: true }, false);
}

const sectionValues = {
  status: { condition: "healthy" },
  communications: { bandwidth_bps: 1 },
  telemetry,
  attitude: { heading: 0, pitch: 0, roll: 0 },
  power: { external_power: false, reserves: [] },
  camera: { zoom_ratio: 1 },
  camera_optics: { horizontal_fov: 90, vertical_fov: 60 },
  gimbal: { bearing: 0, elevation: 0 },
  type: { kind: "person" },
  geometry: point,
};
for (const [section, value] of Object.entries(sectionValues)) {
  const inputValue = {
    ...input(value),
    ...(section === "telemetry" ? { constituents } : {}),
  };
  const readValue = { ...inputValue, evidence: sectionEvidence(section) };
  check(`InputSection.${section}`, inputValue, true);
  check(`InputSection.${section}`, readValue, false);
  check(`ReadSection.${section}`, readValue, true);
  check(`ReadSection.${section}`, inputValue, false);
  check(
    `ReadSection.${section}`,
    {
      ...readValue,
      evidence: sectionEvidence(section === "status" ? "type" : "status"),
    },
    false,
  );
  for (const state of ["error", "withdrawn"]) {
    const result = {
      state,
      classification: "dated_measurement",
      observed_at: at,
      ...(state === "error" ? { error: { code: "sensor" } } : {}),
    };
    check(`InputSection.${section}`, result, true);
    check(
      `ReadSection.${section}`,
      { ...result, evidence: sectionEvidence(section) },
      true,
    );
    check(`ReadSection.${section}`, { ...result, evidence: null }, false);
    check(`InputSection.${section}`, { ...result, value }, false);
  }
}

for (const [name, required] of Object.entries({
  Position: ["latitude", "longitude"],
  Altitude: ["metres", "reference"],
  Telemetry: ["position", "altitude", "ground_speed"],
  Command: ["command", "scheduling", "inputs"],
  CreateTask: [
    "request_id",
    "task_id",
    "asset_id",
    "command",
    "scheduling",
    "inputs",
  ],
  AssetReport: [
    "dataset_id",
    "entity_id",
    "origin",
    "report_id",
    "sequence",
    "generated_at",
    "mode",
    "sections",
  ],
  Task: [
    "dataset_id",
    "task_id",
    "request_id",
    "asset_id",
    "version",
    "accepted_at",
    "submission_sequence",
    "result_declarations",
    "execution_state",
    "cancellation_request_id",
    "command",
    "scheduling",
    "inputs",
  ],
  Asset: [
    "dataset_id",
    "id",
    "entity_type",
    "version",
    "edit_revision",
    "type",
    "capabilities",
    "process_generation",
    "status",
    "communications",
    "heartbeat",
    "task_queue",
    "task_control",
  ],
  AssignedTasks: [
    "asset_id",
    "process_generation",
    "read_id",
    "core_run_id",
    "captured_at",
    "instructions_valid_until",
    "task_queue",
    "task_control",
    "tasks",
    "next_page_token",
  ],
  Authenticate: [
    "type",
    "request_id",
    "dataset_id",
    "protocol_version",
    "api_key",
  ],
  ClientFrame: ["type", "request_id", "dataset_id", "protocol_version", "data"],
  SnapshotPage: [
    "load_id",
    "capture_id",
    "baseline_cursor",
    "expires_at",
    "limits",
    "items",
    "next_page_token",
    "release_token",
  ],
  BeginAssetContact: [
    "request_id",
    "allocation_context",
    "asset_id",
    "process_generation",
    "mode",
  ],
  ReplaceAssetProcess: [
    "request_id",
    "asset_id",
    "expected_process_generation",
    "process_generation",
    "challenge_id",
    "first_report",
  ],
})) {
  for (const key of required) {
    const omitted = { ...samples[name] };
    delete omitted[key];
    check(name, omitted, false);
  }
}

for (const name of ["Counter", "Sequence"]) {
  for (const value of [
    "18446744073709551616",
    "99999999999999999999",
    "01",
    "-0",
    "+1",
    "1.0",
    "1e0",
    "1\n",
  ])
    check(name, value, false);
  const bound = 18446744073709551615n;
  for (let power = 0; power <= 20; power++) {
    for (const offset of [-1n, 0n, 1n]) {
      const value = bound + offset * 10n ** BigInt(power);
      check(
        name,
        String(value),
        value >= (name === "Counter" ? 0n : 1n) && value <= bound,
      );
    }
  }
}
check("Counter", "0", true);
check("Sequence", "0", false);
for (const [name, values] of Object.entries({
  ObjectLength: ["2000000001", "9999999999", "00"],
  Uuid: ["ABCDEFAB-0000-4000-8000-000000000002", `${assetId}\n`],
  NewId: ["00000000-0000-1000-8000-000000000001"],
  Timestamp: [
    `${at}\n`,
    "2026-10-25T12:00:00+00:00",
    "2026-10-25T12:00:00.1234567890Z",
  ],
  Secret: ["B".repeat(43)],
  ContentType: ["image/jpeg;charset=utf-8", " image/jpeg", "image/jpeg\n"],
  Alias: ["", " \t\n", "\u0085\u2000\u3000"],
})) {
  for (const value of values) check(name, value, false);
}
check("Alias", "😀".repeat(128), true);
check("Alias", "😀".repeat(129), false);
for (const [name, bad] of [
  ["Integer", 0.1],
  ["Integer", 2147483648],
  ["PageSize", 0],
  ["PageSize", 1001],
  ["Latitude", 90.1],
  ["Longitude", -180.1],
  ["Float", Infinity],
])
  check(name, bad, false);
check("Time", at, true);
check("AssetType", { kind: "drone" }, false);
check("AssetType", { kind: "tracker", variant: null }, false);
check("Telemetry", { ...telemetry, airspeed: null }, true);
check("Telemetry", { ...telemetry, ground_speed: -1 }, false);
check("Camera", { zoom_ratio: 1, recording: null }, true);
check("Camera", { zoom_ratio: 0.5 }, false);
check("CameraOptics", { horizontal_fov: 0, vertical_fov: 180 }, false);
check("Capacity", { bandwidth_bps: 0 }, false);
check(
  "Reserve",
  {
    id: id(22),
    kind: "battery",
    remaining_percent: 0,
    voltage_volts: null,
    current_amperes: -1,
  },
  true,
);
check("Reserve", { id: id(22), kind: "battery", remaining_percent: 0 }, false);
check("Reserve", { ...samples.Reserve, voltage_volts: null }, false);
check(
  "Power",
  { external_power: null, reserves: Array(17).fill(samples.Reserve) },
  false,
);
check(
  "PowerTimes",
  { reserves: { invalid: { remaining_percent: null } } },
  false,
);
check(
  "PowerTimes",
  {
    reserves: Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [id(100 + i), {}]),
    ),
  },
  false,
);
check("PowerTimes", { reserves: { [id(22)]: { unknown: null } } }, false);
check("Point", { type: "Point", coordinates: [0, 0, 0] }, false);
check("LineString", { type: "LineString", coordinates: [[0, 0]] }, false);
check(
  "LineString",
  { type: "LineString", coordinates: Array(1024).fill([0, 0]) },
  true,
);
check(
  "LineString",
  { type: "LineString", coordinates: Array(1025).fill([0, 0]) },
  false,
);
check(
  "Polygon",
  {
    type: "Polygon",
    coordinates: [polygon.coordinates[0], polygon.coordinates[0]],
  },
  false,
);
check(
  "Polygon",
  {
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [0, 0],
      ],
    ],
  },
  false,
);
check("Command.move_to", command, true);
check(
  "Command.pause",
  { command: "pause", scheduling: "immediate", inputs: {} },
  true,
);
check(
  "Command.resume",
  { command: "resume", scheduling: "immediate", inputs: {}, expires_at: later },
  true,
);
check("Command", { ...command, scheduling: "immediate" }, false);
check("Command", { ...command, expires_at: later }, false);
check(
  "Command",
  { command: "pause", scheduling: "immediate", inputs: { target: point } },
  false,
);
check(
  "Command",
  { command: "resume", scheduling: "immediate", inputs: {} },
  false,
);
check("CreateTask", { ...samples.CreateTask, asset_id: null }, false);
check(
  "Capabilities",
  { commands: [{ command: "pause", scheduling: ["queued"] }] },
  false,
);
check(
  "Capabilities",
  {
    commands: [
      { command: "pause", scheduling: ["immediate"] },
      { command: "pause", scheduling: ["immediate"] },
    ],
  },
  false,
);
check(
  "AssetReport",
  { ...assetReport, mode: "history_only", sections: {} },
  false,
);
check("ObservationReport", { ...observationReport, sections: {} }, false);
check(
  "ObservationReport",
  { ...observationReport, contact_proof: { challenge_id: id(20) } },
  false,
);
check(
  "AssetReport",
  { ...assetReport, sections: { type: input({ kind: null }) } },
  false,
);
check("Task", { ...task, execution_state: "completed" }, true);
check(
  "Task",
  { ...task, execution_state: "completed", cancellation_request_id: id(40) },
  false,
);
check("Task", { ...task, execution_state: "cancellation_requested" }, false);
check("TaskQueue", { ...queue, requested_task_ids: [id(9), id(9)] }, false);
check(
  "QueueConfirmation",
  { queue_revision: "0", control_revision: "0" },
  false,
);
check(
  "QueueConfirmation",
  { queue_revision: "0", control_revision: "0", queue_state: "paused" },
  true,
);
for (const state of ["acknowledged", "in_progress", "paused", "completed"])
  check("ExecutionPayload", { ...payload, state }, true);
check("ExecutionPayload", { ...payload, state: "failed" }, false);
check(
  "ExecutionPayload",
  { ...payload, state: "failed", reason: "failed" },
  true,
);
check(
  "ExecutionPayload",
  { ...payload, state: "cancelled", cancellation_request_id: id(40) },
  true,
);
check(
  "ExecutionPayload",
  {
    ...payload,
    event: "cancellation_refused",
    state: "pending",
    cancellation_request_id: id(40),
    reason: "cannot cancel",
  },
  true,
);
check(
  "ExecutionPayload",
  { ...payload, queue_state: "paused", control_revision: "1", applied_at: at },
  true,
);
check(
  "ExecutionPayload",
  { ...payload, queue_state: "running", control_revision: "1", applied_at: at },
  false,
);
check(
  "ExecutionPayload",
  {
    ...payload,
    queue_state: "running",
    control_revision: "1",
    applied_at: at,
    read_id: id(30),
    core_run_id: id(21),
    captured_at: at,
    instructions_valid_until: later,
    queue_revision: "0",
  },
  true,
);
check(
  "ReportTaskResults",
  { evidence: evidence({ task_id: id(9), declarations: [] }) },
  false,
);
check(
  "ReportTaskResults",
  {
    evidence: evidence({
      task_id: id(9),
      declarations: [samples.ResultDeclaration, samples.ResultDeclaration],
    }),
  },
  true,
);
check("ObjectEdits", {}, false);
check("ObjectMetadata", { ...object.metadata, name: null }, false);
check(
  "Associations",
  [
    { kind: "track", id: trackId },
    { kind: "asset", id: trackId },
  ],
  true,
);
check(
  "Associations",
  [
    { kind: "track", id: trackId },
    { kind: "track", id: trackId },
  ],
  false,
);
check("HistoryReading", { ...reading, track_ids: [trackId] }, false);
check(
  "HistoryReading",
  {
    ...reading,
    source_entity_kind: "observation",
    source_evidence: { ...constituent, origin: publisherOrigin },
    track_ids: [trackId],
  },
  true,
);
check("HistoryQuery", { ...historyFirst, page_token: "token" }, false);
check(
  "HistoryFirst",
  { ...historyFirst, time_groups: ["known", "known"] },
  false,
);
check("ErrorObject", { ...error, code: "cursor_expired" }, false);
check(
  "ErrorObject",
  {
    ...error,
    code: "cursor_expired",
    details: { earliest_recoverable_cursor: "a" },
  },
  true,
);
check("ErrorObject", { ...error, details: { unexpected: "value" } }, false);
check("HttpError", { ...samples.HttpError, status: 401 }, false);
for (const [kind, image, resourceId] of [
  ["track", track, trackId],
  ["geofeature", geofeature, geofeature.id],
  ["task", task, task.task_id],
  ["object", object, object.object_id],
])
  check(
    "Put",
    {
      kind: "put",
      resource_kind: kind,
      resource_id: resourceId,
      version: "0",
      image,
    },
    true,
  );
check(
  "Put",
  { ...put, resource_kind: "observation", image: observation },
  false,
);
for (const kind of ["task", "track", "observation"])
  check("Delete", { ...deletion, resource_kind: kind }, false);
check("Changes", [], false);
check("Changes", [put, put], false);
check("ReadSnapshot", { page_token: "token" }, true);
check("ReadChanges", { page_token: "token" }, true);
check("ReadSnapshot", { ...clientFrame.data, page_size: undefined }, false);
check("ClientFrame", { ...authenticate, api_key: "wrong" }, false);
const clientData = {
  read_changes: samples.ReadChanges,
  release_snapshot: samples.Release,
  subscribe_changes: samples.SubscribeChanges,
  unsubscribe_changes: samples.UnsubscribeChanges,
};
for (const [type, data] of Object.entries(clientData)) {
  check("ClientFrame", { ...context, type, request_id: id(18), data }, true);
  check("ClientFrame", { ...context, type, data }, false);
}
const serverData = {
  authenticated: { core_run_id: id(21), limits },
  read_changes_result: replay,
  snapshot_released: { released: true },
  subscribed: samples.Subscribed,
  unsubscribed: samples.Unsubscribed,
};
for (const [type, data] of Object.entries(serverData))
  check("ServerFrame", { ...context, type, request_id: id(18), data }, true);
const eventData = {
  change_batch: { ...batchData, subscription_id: id(29) },
  progress: {
    previous_cursor: "a",
    through_cursor: "b",
    subscription_id: id(29),
  },
  handoff_complete: { subscription_id: id(29), handoff_cursor: "b" },
  gap: {
    subscription_id: id(29),
    reason: "limits_changed",
    earliest_recoverable_cursor: "a",
  },
};
for (const [type, data] of Object.entries(eventData)) {
  check("ServerFrame", { ...context, type, data }, true);
  check("ServerFrame", { ...context, type, request_id: id(18), data }, false);
}
check("ServerFrame", { ...context, type: "error", error }, true);
check(
  "ServerFrame",
  { ...context, type: "error", request_id: id(18), error },
  true,
);
check(
  "BeginAssetContact",
  { ...samples.BeginAssetContact, mode: "replace" },
  false,
);
check(
  "BeginAssetContact",
  {
    ...samples.BeginAssetContact,
    mode: "replace",
    expected_process_generation: id(33),
  },
  true,
);
check(
  "ContactChallenge",
  { ...challenge, expected_process_generation: id(33) },
  false,
);
check(
  "ContactChallenge",
  { ...challenge, mode: "replace", expected_process_generation: id(33) },
  true,
);

console.log(
  `PASS ${names.length} definitions, ${publicInventory.length} public schemas, ${sections.length} sections, ${references} resolved references, ${cases} structural cases.`,
);
