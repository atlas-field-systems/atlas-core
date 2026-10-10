import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ValidateFunction } from "../../Atlas SDK/node_modules/ajv/dist/ajv.js";
import protocol from "../../Atlas SDK/generated/protocol.json" with { type: "json" };
import { contractValidator, type components } from "../../Atlas SDK/src/index.js";
import { canonicalJSON } from "../../Atlas SDK/src/facts.js";
import { createHTTPSFetch } from "../../Atlas SDK/src/node.js";
import { openReportingRuntime } from "../../examples/s1/reporting-runtime.js";
import { grant, type S1Config } from "../../examples/s1/workflow.js";

type S = components["schemas"];

/** Independent Protocol bodies and requests, without SDK mutation/report helpers. */
export async function runDirectWorkflow(config: S1Config) {
  const validator = contractValidator(protocol);
  const schemas = {
    health: validator.compile<S["HealthResponse"]>({ $ref: "atlas#/components/schemas/HealthResponse" }),
    registration: validator.compile<S["RegistrationResponse"]>({
      $ref: "atlas#/components/schemas/RegistrationResponse",
    }),
    asset: validator.compile<S["AssetResponse"]>({ $ref: "atlas#/components/schemas/AssetResponse" }),
    assetMutation: validator.compile<S["AssetMutationResponse"]>({
      $ref: "atlas#/components/schemas/AssetMutationResponse",
    }),
    assets: validator.compile<S["AssetPageResponse"]>({ $ref: "atlas#/components/schemas/AssetPageResponse" }),
    report: validator.compile<S["EntityReportResponse"]>({ $ref: "atlas#/components/schemas/EntityReportResponse" }),
    status: validator.compile<S["StatusResponse"]>({ $ref: "atlas#/components/schemas/StatusResponse" }),
    statusReport: validator.compile<S["StatusReportResponse"]>({
      $ref: "atlas#/components/schemas/StatusReportResponse",
    }),
    task: validator.compile<S["TaskMutationResponse"]>({ $ref: "atlas#/components/schemas/TaskMutationResponse" }),
    taskRead: validator.compile<S["TaskResponse"]>({ $ref: "atlas#/components/schemas/TaskResponse" }),
    taskReport: validator.compile<S["TaskReportResponse"]>({ $ref: "atlas#/components/schemas/TaskReportResponse" }),
    tasks: validator.compile<S["TaskPageResponse"]>({ $ref: "atlas#/components/schemas/TaskPageResponse" }),
    assigned: validator.compile<S["AssignedTaskPageResponse"]>({
      $ref: "atlas#/components/schemas/AssignedTaskPageResponse",
    }),
    history: validator.compile<S["MovementPageResponse"]>({ $ref: "atlas#/components/schemas/MovementPageResponse" }),
    ready: validator.compile<S["ReadinessResponse"]>({ $ref: "atlas#/components/schemas/ReadinessResponse" }),
  };
  const transport = createHTTPSFetch({ ca: await readFile(config.caPath), maxJSONBytes: 1048576, timeoutMs: 5000 });
  const administrator = await readFile(config.adminKeyPath, "utf8");
  let datasetId = "";
  const request = (method: string, path: string, credential: string, body?: unknown) =>
    transport(config.baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${credential}`,
        "Atlas-Protocol-Version": protocol.info.version,
        ...(datasetId ? { "Atlas-Dataset-ID": datasetId } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async <T>(
    method: string,
    path: string,
    credential: string,
    schema: ValidateFunction<T>,
    body?: unknown,
  ): Promise<T> => {
    const response = await request(method, path, credential, body);
    assert(response.ok, `${method} ${path} returned ${response.status}`);
    const value: unknown = await response.json();
    assert(schema(value), `Invalid ${method} ${path} response`);
    assert.equal(response.headers.get("Atlas-Protocol-Version"), protocol.info.version);
    if (datasetId) assert.equal(response.headers.get("Atlas-Dataset-ID"), datasetId);
    return value;
  };
  const health = await json("GET", "/health", administrator, schemas.health);
  datasetId = health.dataset_id;
  const assetId = randomUUID();
  const directory = join(config.stateDirectory, `direct-${assetId}`);
  const runtime = await openReportingRuntime(directory, assetId);
  const enrollment = await grant(config, runtime, join(directory, "grant"));
  const registration: S["RegisterAssetRequest"] = {
    id: assetId,
    type: "asset",
    registration_id: randomUUID(),
    alias: "Direct Demonstrator",
    command_manifest: [{ command: "move_to", scheduling: ["queued"], cancellation: true, progress: true }],
    enrollment,
  };
  const registered = await json("POST", "/entities", runtime.credential(), schemas.registration, registration);
  assert.equal(registered.data.entity.components.status.value, "unknown");
  assert.equal(registered.data.entity.components.communications.state, "offline");
  assert.equal(registered.data.entity.components.heartbeat.last_seen, null);
  assert.equal(registered.data.entity.components.telemetry, undefined);
  assert.equal(registered.data.entity.process_authority, null);
  const createTask = (): S["CreateTaskRequest"] => ({
    asset_id: assetId,
    idempotency_key: randomUUID(),
    command: "move_to",
    input: { target: { kind: "position", position: { latitude: 10, longitude: 20 } } },
  });
  const first = await json("POST", "/tasks", administrator, schemas.task, createTask());
  const second = await json("POST", "/tasks", administrator, schemas.task, createTask());
  const assigned = await json("GET", `/entities/${assetId}/tasks`, runtime.credential(), schemas.assigned);
  assert.deepEqual(
    assigned.data.items.map((task) => task.id),
    [first.data.id, second.data.id],
  );
  assert.equal(assigned.data.task_queue.confirmed_revision, null);
  const challenge = await json(
    "GET",
    `/health?asset_id=${assetId}&process_generation=1`,
    runtime.credential(),
    schemas.health,
  );
  const signer = runtime.signer();
  let sequence = 0;
  const signed = async (kind: string, targetId: string, payload: unknown, timing: Partial<S["ReportContext"]> = {}) => {
    const reportContext: S["ReportContext"] = {
      asset_id: assetId,
      process_generation: "1",
      sequence: String(++sequence),
      generated_at: new Date().toISOString(),
      evidence_kind: "current",
      evidence_origin: null,
      retained_evidence_id: null,
      contact_challenge: challenge.data.contact_challenge?.token ?? null,
      process_proof: "",
      ...timing,
    };
    const { process_proof: ignored, ...context } = reportContext;
    void ignored;
    const facts = canonicalJSON({
      kind,
      dataset_id: datasetId,
      protocol_version: protocol.info.version,
      target_id: targetId,
      report_context: context,
      payload,
    });
    reportContext.process_proof = Buffer.from(await signer.sign(facts)).toString("base64url");
    return { reportContext, facts };
  };
  const payload = { components: { status: { value: "ready" } } } as const;
  const firstFacts = await signed("checkin", assetId, payload);
  const claim = {
    transfer_id: randomUUID(),
    process_id: signer.processId,
    expected_generation: "0",
    process_public_key: signer.publicKey,
  };
  const recoveryProof = Buffer.from(
    await runtime.authorizer().authorize(
      canonicalJSON({
        kind: "authority_transfer",
        dataset_id: datasetId,
        asset_id: assetId,
        ...claim,
        report_digest: createHash("sha256").update(firstFacts.facts).digest("base64url"),
      }),
    ),
  ).toString("base64url");
  const established = await json("POST", `/entities/${assetId}/checkin`, runtime.credential(), schemas.report, {
    ...payload,
    report_context: firstFacts.reportContext,
    authority_claim: { ...claim, recovery_proof: recoveryProof },
  });
  assert.equal(established.data.acceptance.contact_refreshed, true);
  const executionId = randomUUID();
  const progress = {
    kind: "report",
    status: "in_progress",
    execution_id: executionId,
    progress: { distance_remaining_m: 5.1 },
  } as const;
  const progressFacts = await signed("task_report", first.data.id, progress);
  const progressed = await json("PATCH", `/tasks/${first.data.id}/status`, runtime.credential(), schemas.taskReport, {
    ...progress,
    report_context: progressFacts.reportContext,
  });
  assert.equal(progressed.data.task.status, "in_progress");
  const completion = {
    kind: "report",
    status: "completed",
    execution_id: executionId,
    progress: { distance_remaining_m: 4.9 },
  } as const;
  const completeFacts = await signed("task_report", first.data.id, completion);
  const completionBody = { ...completion, report_context: completeFacts.reportContext };
  const finished = await json(
    "PATCH",
    `/tasks/${first.data.id}/status`,
    runtime.credential(),
    schemas.taskReport,
    completionBody,
  );
  assert.equal(finished.data.task.status, "completed");
  const replay = await json(
    "PATCH",
    `/tasks/${first.data.id}/status`,
    runtime.credential(),
    schemas.taskReport,
    completionBody,
  );
  assert.equal(replay.data.acceptance.disposition, "duplicate");
  const cancelId = randomUUID();
  const intent = await json("PATCH", `/tasks/${second.data.id}/status`, administrator, schemas.task, {
    kind: "cancellation_request",
    request_id: cancelId,
  });
  assert.equal(intent.data.status, "cancellation_requested");
  const cancellation = {
    kind: "report",
    status: "cancelled",
    cancellation_response: { request_id: cancelId, outcome: "confirmed" },
  } as const;
  const cancellationFacts = await signed("task_report", second.data.id, cancellation);
  const cancelled = await json("PATCH", `/tasks/${second.data.id}/status`, runtime.credential(), schemas.taskReport, {
    ...cancellation,
    report_context: cancellationFacts.reportContext,
  });
  assert.equal(cancelled.data.task.status, "cancelled");
  const observedAt = "2026-10-10T00:00:00.500+00:00";
  const telemetry = { components: { telemetry: { position: { latitude: 10, longitude: 20 }, speed_mps: 2 } } };
  const telemetryFacts = await signed("entity_report", assetId, telemetry, {
    observation_times: { position: { observed_at: observedAt }, speed_mps: { observed_at: null } },
  });
  await json("PATCH", `/entities/${assetId}`, runtime.credential(), schemas.report, {
    ...telemetry,
    report_context: telemetryFacts.reportContext,
  });
  const heading = { components: { telemetry: { heading_deg: 90 } } };
  const headingFacts = await signed("entity_report", assetId, heading, {
    observation_times: { heading_deg: { observed_at: "2026-10-10T00:10:00Z" } },
  });
  await json("PATCH", `/entities/${assetId}`, runtime.credential(), schemas.report, {
    ...heading,
    report_context: headingFacts.reportContext,
  });
  const historyQuery = "?from=2020-01-01T00%3A00%3A00Z&to=2030-01-01T00%3A00%3A00Z&time_basis=observed_at&limit=1";
  const history = await json(
    "GET",
    `/entities/${assetId}/movement-history${historyQuery}`,
    administrator,
    schemas.history,
  );
  assert.equal(history.data.items.length, 1);
  assert.equal(history.data.items[0]?.quantities.position?.observed_at, observedAt);
  const statusPayload = { status: { value: "ready" } } as const;
  const statusFacts = await signed("status_report", assetId, statusPayload);
  await json("PATCH", `/entities/${assetId}/status`, runtime.credential(), schemas.statusReport, {
    ...statusPayload,
    report_context: statusFacts.reportContext,
  });
  assert.equal((await json("GET", `/entities/${assetId}/status`, administrator, schemas.status)).data.value, "ready");
  const current = await json("GET", `/entities/${assetId}`, administrator, schemas.asset);
  const edit = {
    expected_edit_revision: current.data.edit_revision,
    alias: "Direct Renamed",
  } satisfies S["DescriptiveEditRequest"];
  const edited = await json("PATCH", `/entities/${assetId}`, administrator, schemas.assetMutation, edit);
  assert.equal(edited.data.id, assetId);
  assert.equal(edited.data.alias, "Direct Renamed");
  assert.notEqual(edited.commit_cursor, current.read_context.commit_cursor);
  const afterEdit = await json("GET", "/health", administrator, schemas.health);
  assert.deepEqual(afterEdit.read_context, { source: "http", commit_cursor: edited.commit_cursor });
  assert.equal((await json("GET", "/entities/alias/direct%20renamed", administrator, schemas.asset)).data.id, assetId);
  assert.equal((await json("GET", "/entities", administrator, schemas.assets)).data.items.length, 1);
  assert.equal((await json("GET", "/tasks", administrator, schemas.tasks)).data.items.length, 2);
  assert.equal(
    (await json("GET", `/tasks/${first.data.id}`, administrator, schemas.taskRead)).data.status,
    "completed",
  );
  assert.equal((await json("GET", "/readiness", administrator, schemas.ready)).data.ready, true);
  assert.match(await (await request("GET", "/docs", administrator)).text(), /Atlas/);
  const schemaResponse = await request("GET", "/openapi.json", administrator);
  assert.equal(schemaResponse.status, 200);
  const removed = await request("DELETE", `/entities/${assetId}`, administrator);
  assert.equal(removed.status, 204);
  const revoked = await request("GET", `/entities/${assetId}`, runtime.credential());
  assert.equal(revoked.status, 401);
  const after = await json(
    "GET",
    `/entities/${assetId}/movement-history${historyQuery}`,
    administrator,
    schemas.history,
  );
  assert.equal(after.data.entity_deleted, true);
  return {
    progressStatus: "in_progress",
    outcome: "completed",
    cancellation: "cancelled",
    sourceTime: observedAt,
    executionCount: 1,
    historyAfterDeletion: true,
    taskCount: 2,
  };
}
