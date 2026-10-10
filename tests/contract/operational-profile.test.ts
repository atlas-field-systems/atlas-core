import assert from "node:assert/strict";
import { contractValidator } from "../../Atlas SDK/src/index.js";
import protocol from "../../Atlas Protocol/protocol.json" with { type: "json" };
import type { components } from "../../Atlas SDK/generated/protocol.js";

const ajv = contractValidator(protocol);
const telemetry = ajv.compile({ $ref: "atlas#/components/schemas/TelemetryPatch" });
for (const body of [null, { heading_deg: 0 }, { heading_deg: 359.99999999999994 }, { heading_deg: null }]) {
  assert.equal(telemetry(body), true, "sparse telemetry retains null and valid heading bounds");
}
for (const body of [{ heading_deg: 360 }, { heading_deg: -1 }, {}, { position: { latitude: 10 } }]) {
  assert.equal(telemetry(body), false, "invalid heading and incomplete position are rejected");
}
const sourceTime = ajv.compile({ $ref: "atlas#/components/schemas/NullableSourceInstant" });
for (const time of [null, "2026-10-09T10:00:00.500+00:00", "2026-10-09T10:00:00Z"]) assert(sourceTime(time));
assert.equal(sourceTime("not-a-date"), false);

const readiness = ajv.compile({ $ref: "atlas#/components/schemas/ReadinessResponse" });
const readinessSuccess = {
  dataset_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  read_context: { source: "http", commit_cursor: "7" },
  data: { ready: true, checks: { sqlite: true, filesystem: true } },
} satisfies components["schemas"]["ReadinessResponse"];
assert(readiness(readinessSuccess));
assert.equal(readinessSuccess.read_context.source, "http");
assert.equal(readinessSuccess.read_context.commit_cursor, "7");
assert.equal(readiness({ read_context: readinessSuccess.read_context, data: readinessSuccess.data }), false);
assert.equal(readiness({ dataset_id: readinessSuccess.dataset_id, data: readinessSuccess.data }), false);
for (const read_context of [
  null,
  {},
  { source: "http" },
  { commit_cursor: "7" },
  { source: "local", commit_cursor: "7" },
  { source: "http", commit_cursor: 7 },
  { source: "http", commit_cursor: null },
  { source: "http", commit_cursor: { value: "7" } },
]) {
  assert.equal(readiness({ ...readinessSuccess, read_context }), false, "invalid HTTP read context is rejected");
}

const taskSuccess = {
  dataset_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  commit_cursor: "1",
  data: {
    id: "11111111-1111-4111-8111-111111111111",
    asset_id: "22222222-2222-4222-8222-222222222222",
    command: "move_to",
    input: { target: { kind: "position", position: { latitude: 10, longitude: 20 } } },
    scheduling: "queued",
    submission_sequence: "1",
    status: "pending",
    execution_status: "pending",
    execution_id: null,
    progress: null,
    failure: null,
    cancellation_requests: [],
    acknowledged_at: null,
    started_at: null,
    finished_at: null,
    created_at: "2026-10-09T10:00:00Z",
    updated_at: "2026-10-09T10:00:00Z",
    version: "1",
  },
} satisfies components["schemas"]["TaskMutationResponse"];
const taskMutation = ajv.compile({ $ref: "atlas#/components/schemas/TaskMutationResponse" });
assert(taskMutation(taskSuccess));
assert.equal(taskMutation({ dataset_id: taskSuccess.dataset_id, data: taskSuccess.data }), false);
console.log(
  "PASS operational heading bounds, source timestamp profile and discovery envelope with required HTTP read context",
);
