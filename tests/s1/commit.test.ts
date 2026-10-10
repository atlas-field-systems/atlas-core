// Atomic commit and loss: a failure before the SQLite commit leaves no
// acceptance identity, domain effect, movement, Contact or change/activity
// record; a lost successful response replays exactly once after Restart.
import assert from "node:assert/strict";
import {
  accepted,
  AssetClient,
  type Evidence,
  type MutationOutcome,
  type ReportDescriptor,
  type ReportResult,
} from "../../Atlas SDK/src/index.js";
import { prepareAsset, processSigner, ReportingProcess } from "../simulator/index.js";
import {
  acceptedOutcome,
  establishedAsset,
  failsWith,
  FaultProxy,
  newInstallation,
  moveTo,
  rejectionCode,
  runDirectory,
  step,
  waitFor,
} from "./support.js";

const installation = await newInstallation({ testFaults: true });
await installation.start();
const operator = await installation.operator();
const { os, process } = await establishedAsset(installation);
const client = process.client;

// settled waits until the derived communication state stops changing after
// the last fresh Contact, so snapshots compare only request effects.
const settled = () =>
  waitFor("communication state to settle offline", async () =>
    (await operator.getEntity(os.assetId)).components.communications.state === "offline" ? true : undefined,
  );
const retained = (): Evidence => ({
  kind: "historical",
  generatedAt: new Date().toISOString(),
  retainedEvidenceId: crypto.randomUUID(),
});

const submit = (descriptor: ReportDescriptor): Promise<MutationOutcome<ReportResult<unknown>>> =>
  descriptor.operation === "task_status" ? client.submitTaskReport(descriptor) : client.submitEntityReport(descriptor);

// snapshot reads everything a failed commit must leave unchanged.
const snapshot = async (taskId?: string) => ({
  entity: await operator.getEntity(os.assetId),
  movement: (await operator.movementHistory(os.assetId)).items,
  tasks: (await operator.listTasks({ limit: 1000 })).items,
  task: taskId === undefined ? undefined : await operator.getTask(taskId),
  activity: await installation.activity(),
});

const task = accepted(
  await operator.createTask(await operator.prepareTaskCreation({ assetId: os.assetId, input: moveTo(10, 20) })),
);
await process.receiveWork();
await process.flush();

// Reports on every route fail before commit, then the same descriptor is
// accepted as a first submission.
// Retained evidence keeps Contact unchanged until the final fresh check-in.
const statusReport = await client.prepareStatusReport({ value: "ready", reason: "recovered" }, retained());
const patch = await client.prepareComponentReport({ components: { telemetry: { speed_mps: 3 } } }, retained());
const taskReport = await client.prepareTaskReport(task.id, { event: "started" }, retained());
await settled();
const checkIn = await client.prepareCheckIn({
  components: { telemetry: { position: { latitude: 10.5, longitude: 20 } }, status: { value: "busy", reason: null } },
});
for (const [operation, descriptor] of [
  ["report.status_report", statusReport],
  ["report.entity_patch", patch],
  ["report.task_status", taskReport],
  ["report.checkin", checkIn],
] as const) {
  const before = await snapshot(task.id);
  await installation.armFault(operation);
  assert.equal(rejectionCode(await submit(descriptor), operation), "internal_error");
  assert.deepEqual(await snapshot(task.id), before, `${operation} left no effect`);
  const retried = acceptedOutcome(await submit(descriptor), `${operation} retry`);
  assert.equal(retried.value.report?.disposition, "accepted", "the retry is the first acceptance");
}
assert.equal((await operator.getTask(task.id)).status, "in_progress");
assert.equal((await operator.movementHistory(os.assetId)).items.length, 2, "speed and position samples only");
step("pre-commit failure on every report route leaves no identity, effect, sample, Contact or activity");

// Operator mutations and registration fail atomically too.
const creation = await operator.prepareTaskCreation({ assetId: os.assetId, input: moveTo(11, 20) });
await settled();
const beforeCreate = await snapshot();
await installation.armFault("task.create");
assert.equal(rejectionCode(await operator.createTask(creation), "task.create"), "internal_error");
assert.deepEqual(await snapshot(), beforeCreate, "no Task, queue change or issuance activity");
const second = acceptedOutcome(await operator.createTask(creation), "creation retry");
assert.equal(second.status, 201, "the retry is the first commit");

const cancellation = await operator.prepareCancellation({ taskId: second.value.id });
const beforeCancel = await snapshot(second.value.id);
await installation.armFault("task.request_cancellation");
assert.equal(rejectionCode(await operator.requestCancellation(cancellation), "cancellation"), "internal_error");
assert.deepEqual(await snapshot(second.value.id), beforeCancel);
acceptedOutcome(await operator.requestCancellation(cancellation), "cancellation retry");

const newcomer = await prepareAsset(runDirectory(), (assetId, key) => installation.authorizeEnrollment(assetId, key));
const newcomerProcess = new ReportingProcess(newcomer, await installation.link());
await installation.armFault("entity.register");
assert.equal(rejectionCode(await newcomerProcess.register(), "registration"), "internal_error");
await assert.rejects(() => operator.getEntity(newcomer.assetId), failsWith("not_found"));
assert.equal(acceptedOutcome(await newcomerProcess.register(), "registration retry").status, 201);
step("Task creation, cancellation and registration failures before commit leave nothing; retries commit once");

// Lost successful responses replay exactly once after Restart, even after
// newer state changes.
const proxy = await FaultProxy.start(installation);
// The same reporting process continues its sequence through the lossy path.
const continuing = (baseUrl: string, from: AssetClient) =>
  installation.link().then(
    (link) =>
      new AssetClient({
        ...link,
        baseUrl,
        assetId: os.assetId,
        credential: os.credential,
        signer: processSigner(os.reporting.key),
        processGeneration: from.processGeneration ?? assert.fail(),
        nextSequence: from.nextSequence,
      }),
  );
const lossy = await continuing(proxy.baseUrl, client);
const progress = await lossy.prepareTaskReport(task.id, {
  event: "progress",
  progress: { details: { command: "move_to", distance_remaining_m: 4 } },
});
const telemetry = await lossy.prepareComponentReport(
  { components: { telemetry: { position: { latitude: 10.6, longitude: 20 } } } },
  { kind: "current", observationTimes: { position: { observed_at: new Date().toISOString() } } },
);
const lostCreation = await operator.prepareTaskCreation({ assetId: os.assetId, input: moveTo(12, 20) });
const lossyOperator = await installation.operator(proxy.baseUrl);
proxy.set("drop_response");
assert.equal((await lossy.submitTaskReport(progress)).outcome, "unknown_outcome");
assert.equal((await lossy.submitEntityReport(telemetry)).outcome, "unknown_outcome");
assert.equal((await lossyOperator.createTask(lostCreation)).outcome, "unknown_outcome");
assert.equal(proxy.dropped.length, 3, "Core answered all three before the answers were lost");
proxy.set("pass");
const committed = await snapshot(task.id);
assert.equal(committed.task?.progress?.details?.distance_remaining_m, 4, "the lost progress committed");

await installation.restart();
const restartedClient = await continuing(installation.baseUrl, lossy);
acceptedOutcome(
  await restartedClient.submitEntityReport(await restartedClient.prepareStatusReport({ value: "busy", reason: null })),
  "newer state after Restart",
);
const progressReplay = acceptedOutcome(await restartedClient.submitTaskReport(progress), "progress replay");
assert.equal(progressReplay.value.report?.disposition, "duplicate");
const telemetryReplay = acceptedOutcome(await restartedClient.submitEntityReport(telemetry), "telemetry replay");
assert.equal(telemetryReplay.value.report?.disposition, "duplicate");
assert.equal(telemetryReplay.value.report?.movement_sample_ids.length, 1);
const creationReplay = acceptedOutcome(await operator.createTask(lostCreation), "creation replay");
assert.equal(creationReplay.status, 200);
const after = await snapshot(task.id);
assert.equal(after.task?.version, committed.task?.version, "the replay changed nothing");
assert.equal(after.movement.length, committed.movement.length, "no duplicate movement");
assert.equal(after.tasks.length, committed.tasks.length, "no duplicate Task");
assert.equal(
  after.activity.filter((entry) => entry.action === "task.issue").length,
  committed.activity.filter((entry) => entry.action === "task.issue").length,
);
step("lost report and creation responses replay exactly once after Restart and newer state changes");

await proxy.close();
await installation.stop();
