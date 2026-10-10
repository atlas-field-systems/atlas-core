import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createAtlasClient,
  createAssetClient,
  contractValidator,
  type Outcome,
  type PreparedMutation,
  type AssetProcessSnapshot,
  type components,
} from "../../Atlas SDK/src/index.js";
import protocol from "../../Atlas SDK/generated/protocol.json" with { type: "json" };
import { createHTTPSFetch } from "../../Atlas SDK/src/node.js";
import { openExecutionStore, readRetainedFile, retainJSON } from "./execution-store.js";
import { openReportingRuntime } from "./reporting-runtime.js";

const configFields = [
  "baseUrl",
  "caPath",
  "adminKeyPath",
  "installationId",
  "managerSocket",
  "atlasCli",
  "stateDirectory",
] as const;
export type S1Config = Record<(typeof configFields)[number], string>;
type S = components["schemas"];
const execute = promisify(execFile);

export async function readS1Config(path: string): Promise<S1Config> {
  const bytes = await readRetainedFile(path, 65536, true);
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  const properties = Object.fromEntries(configFields.map((name) => [name, { type: "string", minLength: 1 }]));
  const valid = contractValidator({ components: { schemas: {} }, paths: {} }).compile<S1Config>({
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  });
  if (!valid(value)) throw new Error("S1 configuration is invalid");
  return value;
}

export function accepted<T>(result: Outcome<T>): T {
  assert(
    result.outcome === "accepted",
    `Expected accepted result, received ${result.outcome}${result.outcome === "rejected" ? `: ${JSON.stringify(result.error)}` : ""}`,
  );
  return result.value;
}

export async function localAction(config: S1Config, action: "restart" | "reset" | "status" | "stop" | "start") {
  const result = await execute(config.atlasCli, [action, "--socket", config.managerSocket], {
    timeout: 120000,
    maxBuffer: 65536,
  });
  const last = result.stdout.trim().split(/\r?\n/u).at(-1);
  if (!last) throw new Error(`Local ${action} returned no result`);
  const value: unknown = JSON.parse(last);
  const valid = contractValidator({ components: { schemas: {} }, paths: {} }).compile<{
    status: string;
    dataset_id?: string;
  }>({
    type: "object",
    required: ["status"],
    properties: { status: { type: "string" }, dataset_id: { type: "string" } },
    additionalProperties: true,
  });
  if (!valid(value) || value.status !== "completed") throw new Error(`Local ${action} did not complete`);
  return value;
}

export async function grant(
  config: S1Config,
  runtime: Awaited<ReturnType<typeof openReportingRuntime>>,
  directory: string,
): Promise<S["EnrollmentGrant"]> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const input = join(directory, "enrollment-input.json");
  const output = join(directory, "enrollment-grant.json");
  await retainJSON(directory, input, runtime.enrollment(config.installationId));
  await execute(config.atlasCli, ["enroll", "--socket", config.managerSocket, "--input", input, "--output", output], {
    timeout: 10000,
    maxBuffer: 65536,
  });
  const value: unknown = JSON.parse(await readFile(output, "utf8"));
  const valid = contractValidator(protocol).compile<S["EnrollmentGrant"]>({
    $ref: "atlas#/components/schemas/EnrollmentGrant",
  });
  if (!valid(value)) throw new Error("Local enrollment grant is invalid");
  return value;
}

async function submitRetained<T>(
  runtime: Awaited<ReturnType<typeof openReportingRuntime>>,
  descriptor: PreparedMutation,
  send: () => Promise<Outcome<T>>,
  state?: AssetProcessSnapshot,
): Promise<T> {
  const pendingId = await runtime.retain(descriptor, state);
  const result = await send();
  if (result.outcome === "accepted") await runtime.acknowledge(pendingId, state);
  return accepted(result);
}

export async function createSDKAsset(config: S1Config, fetch?: typeof globalThis.fetch) {
  const assetId = randomUUID();
  const directory = join(config.stateDirectory, `sdk-${assetId}`);
  const runtime = await openReportingRuntime(directory, assetId);
  const ca = await readFile(config.caPath);
  const transport = fetch ?? createHTTPSFetch({ ca, maxJSONBytes: 1048576, timeoutMs: 5000 });
  const adminSecret = await readFile(config.adminKeyPath, "utf8");
  const operator = createAtlasClient({ baseUrl: config.baseUrl, credential: () => adminSecret, fetch: transport });
  const operatorHealth = accepted(await operator.discover());
  const context = operator.context();
  assert(context);
  const client = createAtlasClient({
    baseUrl: config.baseUrl,
    credential: runtime.credential,
    fetch: transport,
    bootstrapContext: context,
  });
  const enrollment = await grant(config, runtime, join(directory, "grant"));
  const registration = client.prepareRegistration({
    id: assetId,
    type: "asset",
    registration_id: randomUUID(),
    alias: "S1 Demonstrator",
    command_manifest: [{ command: "move_to", scheduling: ["queued"], cancellation: true, progress: true }],
    enrollment,
  });
  const pendingId = await runtime.retain(registration);
  const registered = await client.submit(registration);
  if (registered.outcome === "accepted") {
    await runtime.acknowledge(pendingId);
    assert.equal(registered.value.dataset_id, operatorHealth.dataset_id);
  }
  return { assetId, directory, runtime, operator, client, registered };
}

export async function runSDKWorkflow(config: S1Config) {
  const {
    assetId,
    directory,
    runtime,
    operator,
    client,
    registered: registrationOutcome,
  } = await createSDKAsset(config);
  const registered = accepted(registrationOutcome);
  assert.equal(registered.data.entity.components.status.value, "unknown");
  assert.equal(registered.data.entity.components.communications.state, "offline");
  assert.equal(registered.data.entity.components.heartbeat.last_seen, null);
  assert.equal(registered.data.entity.components.telemetry, undefined);
  assert.equal(registered.data.entity.process_authority, null);
  accepted(await client.discover());
  const taskDescriptor = operator.prepareTask({
    asset_id: assetId,
    idempotency_key: randomUUID(),
    command: "move_to",
    input: { target: { kind: "position", position: { latitude: 10, longitude: 20 } } },
  });
  const first = await submitRetained(runtime, taskDescriptor, () => operator.submit(taskDescriptor));
  const nextDescriptor = operator.prepareTask({ ...taskDescriptor.body, idempotency_key: randomUUID() });
  const second = await submitRetained(runtime, nextDescriptor, () => operator.submit(nextDescriptor));
  const entitySelection = accepted(
    await operator.listEntities({
      ids: [assetId],
      type: ["asset"],
      alias: "s1 demonstrator",
      alias_is_set: true,
    }),
  );
  assert.deepEqual(
    entitySelection.data.items.map((entity) => entity.id),
    [assetId],
  );
  assert.equal(accepted(await operator.listEntities({ ids: [] })).data.items.length, 0);
  const taskSelection = accepted(
    await operator.listTasks({
      ids: [first.data.id, second.data.id],
      asset_id: [assetId],
      status: ["pending"],
      scheduling: ["queued"],
    }),
  );
  assert.deepEqual(
    taskSelection.data.items.map((task) => task.id),
    [first.data.id, second.data.id].sort(),
  );
  assert.deepEqual(taskSelection.read_context, { source: "http", commit_cursor: second.commit_cursor });
  const acceptedIDs = [first.data.id, second.data.id, ...Array.from({ length: 998 }, () => randomUUID())];
  const filteredFirst = accepted(await operator.listTasks({ ids: acceptedIDs, limit: 1 }));
  assert.equal(filteredFirst.data.items.length, 1);
  assert(filteredFirst.data.next_cursor && filteredFirst.data.next_cursor.length <= 4096);
  const filteredNext = accepted(
    await operator.listTasks({ ids: acceptedIDs, limit: 1, cursor: filteredFirst.data.next_cursor }),
  );
  assert.equal(filteredNext.data.items.length, 1);
  assert.notEqual(filteredNext.data.items[0]?.id, filteredFirst.data.items[0]?.id);
  assert.equal(filteredNext.data.next_cursor, null);
  assert.equal(accepted(await operator.listTasks({ ids: [] })).data.items.length, 0);
  assert.equal(accepted(await operator.listTasks({ asset_id: assetId, status: "pending" })).data.items.length, 2);
  const assigned = accepted(await client.getAssignedTasks(assetId));
  assert.deepEqual(
    assigned.data.items.map((task) => task.id),
    [first.data.id, second.data.id],
  );
  assert.equal(assigned.data.task_queue.confirmed_revision, null);
  const assignedSelection = accepted(
    await client.getAssignedTasks(assetId, {
      ids: [second.data.id],
      status: ["pending"],
      scheduling: ["queued"],
    }),
  );
  assert.deepEqual(
    assignedSelection.data.items.map((task) => task.id),
    [second.data.id],
  );
  const reporter = createAssetClient({ client, assetId, signer: runtime.signer(), authorizer: runtime.authorizer() });
  const health = accepted(await client.discover({ asset_id: assetId, process_generation: "1" }));
  const authority = await reporter.prepareAuthority({
    expectedGeneration: "0",
    transferId: randomUUID(),
    generatedAt: new Date().toISOString(),
    contactChallenge: health.data.contact_challenge?.token ?? null,
    components: { status: { value: "ready" } },
  });
  const pendingAuthorityId = await runtime.retain(authority, reporter.snapshot());
  const authorityResult = accepted(await client.submit(authority));
  reporter.observeAuthority(authorityResult);
  await runtime.acknowledge(pendingAuthorityId, reporter.snapshot());
  assert.equal(authorityResult.data.acceptance.contact_refreshed, true);
  const executions = await openExecutionStore(join(directory, "os"));
  await executions.loadTasks([first.data.id, second.data.id]);
  const startedAt = new Date().toISOString();
  await executions.start(first.data.id, startedAt, null);
  await executions.distance(first.data.id, 5.1, startedAt);
  const executing = executions.snapshot(first.data.id);
  assert(executing.executionId);
  const progress = await reporter.prepareTaskReport(
    first.data.id,
    {
      status: "in_progress",
      execution_id: executing.executionId,
      started_at: startedAt,
      progress: { distance_remaining_m: 5.1 },
    },
    { generatedAt: startedAt },
  );
  const progressResult = await submitRetained(runtime, progress, () => client.submit(progress), reporter.snapshot());
  assert("task" in progressResult.data);
  assert.equal(progressResult.data.task.status, "in_progress");
  await executions.distance(first.data.id, 4.9, startedAt);
  const completion = await reporter.prepareTaskReport(
    first.data.id,
    {
      status: "completed",
      execution_id: executing.executionId,
      finished_at: startedAt,
      progress: { distance_remaining_m: 4.9 },
    },
    { generatedAt: startedAt },
  );
  const finished = await submitRetained(runtime, completion, () => client.submit(completion), reporter.snapshot());
  assert("task" in finished.data);
  assert.equal(finished.data.task.status, "completed");
  const replayed = accepted(await client.submit(completion));
  assert("task" in replayed.data);
  assert.equal(replayed.data.acceptance.disposition, "duplicate");
  const cancelId = randomUUID();
  const cancellation = operator.prepareCancellation(second.data.id, {
    kind: "cancellation_request",
    request_id: cancelId,
    reason: "Independent cancellation evidence",
  });
  const cancelledIntent = await submitRetained(runtime, cancellation, () => operator.submit(cancellation));
  assert(!("task" in cancelledIntent.data));
  assert.equal(cancelledIntent.data.status, "cancellation_requested");
  const confirmation = await reporter.prepareTaskReport(
    second.data.id,
    { status: "cancelled", cancellation_response: { request_id: cancelId, outcome: "confirmed" } },
    { generatedAt: new Date().toISOString() },
  );
  const cancelled = await submitRetained(runtime, confirmation, () => client.submit(confirmation), reporter.snapshot());
  assert("task" in cancelled.data);
  assert.equal(cancelled.data.task.status, "cancelled");
  const observedAt = "2026-10-10T00:00:00.500+00:00";
  const position = await reporter.prepareReport({
    generatedAt: new Date().toISOString(),
    components: { telemetry: { position: { latitude: 10, longitude: 20 }, speed_mps: 2 } },
    observationTimes: { position: { observed_at: observedAt }, speed_mps: { observed_at: null } },
  });
  await submitRetained(runtime, position, () => client.submit(position), reporter.snapshot());
  const heading = await reporter.prepareReport({
    generatedAt: new Date().toISOString(),
    components: { telemetry: { heading_deg: 90 } },
    observationTimes: { heading_deg: { observed_at: "2026-10-10T00:10:00Z" } },
  });
  await submitRetained(runtime, heading, () => client.submit(heading), reporter.snapshot());
  const history = accepted(
    await client.getMovementHistory(assetId, {
      from: "2020-01-01T00:00:00Z",
      to: "2030-01-01T00:00:00Z",
      time_basis: "observed_at",
      limit: 1,
    }),
  );
  assert.equal(history.data.items.length, 1);
  assert.equal(history.data.items[0]?.quantities.position?.observed_at, observedAt);
  const status = await reporter.prepareStatus({ value: "ready" }, { generatedAt: new Date().toISOString() });
  await submitRetained(runtime, status, () => client.submit(status), reporter.snapshot());
  assert.equal(accepted(await client.getStatus(assetId)).data.value, "ready");
  const current = accepted(await operator.getEntity(assetId));
  const edit = operator.prepareEdit(assetId, {
    expected_edit_revision: current.data.edit_revision,
    alias: "S1 Renamed",
  });
  const edited = await submitRetained(runtime, edit, () => operator.submit(edit));
  assert(!("entity" in edited.data));
  assert.equal(edited.data.alias, "S1 Renamed");
  assert.equal(accepted(await operator.getEntityByAlias("s1 renamed")).data.id, assetId);
  assert.equal(accepted(await operator.listEntities()).data.items.length, 1);
  assert.equal(accepted(await operator.listTasks()).data.items.length, 2);
  assert.equal(accepted(await operator.getTask(first.data.id)).data.status, "completed");
  assert.equal(accepted(await operator.readiness()).data.ready, true);
  assert.match(accepted(await operator.documentation()), /Atlas/);
  const openapi = accepted(await operator.openapi());
  assert(typeof openapi.info === "object" && openapi.info !== null && "version" in openapi.info);
  assert.equal(openapi.info.version, protocol.info.version);
  const retained = await openExecutionStore(join(directory, "os"));
  assert.equal(retained.snapshot(first.data.id).executionCount, 1);
  await assert.rejects(retained.start(first.data.id, new Date().toISOString(), null));
  const deletion = operator.prepareDeletion(assetId);
  await submitRetained(runtime, deletion, () => operator.submit(deletion));
  const revoked = await client.getEntity(assetId);
  assert.equal(revoked.outcome, "rejected");
  const deletedHistory = accepted(
    await operator.getMovementHistory(assetId, {
      from: "2020-01-01T00:00:00Z",
      to: "2030-01-01T00:00:00Z",
      time_basis: "received_at",
    }),
  );
  assert.equal(deletedHistory.data.entity_deleted, true);
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
