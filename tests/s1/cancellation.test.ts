// Cancellation intent and Asset decisions: offline and online requests,
// absent cancellation support, confirmation, decline with order restoration,
// completion before confirmation, terminal immutability, retries and
// out-of-order evidence.
import assert from "node:assert/strict";
import { accepted, type Task } from "../../Atlas SDK/src/index.js";
import {
  acceptedOutcome,
  establishedAsset,
  FaultProxy,
  newInstallation,
  moveTo,
  rejectionCode,
  requestTimeoutMs,
  step,
} from "./support.js";

const installation = await newInstallation();
await installation.start();
const operator = await installation.operator();
const proxy = await FaultProxy.start(installation);
const link = { baseUrl: proxy.baseUrl, fetch: await installation.fetch(), requestTimeoutMs };
const { os, process } = await establishedAsset(installation, { link });

const issue = async (assetId = os.assetId, latitude = 10) =>
  accepted(await operator.createTask(await operator.prepareTaskCreation({ assetId, input: moveTo(latitude, 20) })));
const cancel = async (task: Task, reason: string | null = null) => {
  const descriptor = await operator.prepareCancellation({ taskId: task.id, reason });
  return { descriptor, outcome: await operator.requestCancellation(descriptor) };
};

// Offline: Core records intent while the Asset cannot be reached. Only the
// Asset's later confirmation cancels the Task.
proxy.set("refuse");
const offline = await issue();
const requested = await cancel(offline, "operator changed plan");
const intent = acceptedOutcome(requested.outcome, "offline cancellation request").value;
assert.equal(intent.status, "cancellation_requested");
assert.equal(intent.cancellations[0]?.state, "requested");
assert.equal(intent.cancellations[0]?.reason, "operator changed plan");
assert.equal(intent.cancellations[0]?.requested_by.kind, "operator");
const retried = acceptedOutcome(await operator.requestCancellation(requested.descriptor), "identical retry");
assert.equal(retried.commitCursor, acceptedOutcome(requested.outcome, "first").commitCursor);
assert.equal(retried.value.cancellations.length, 1, "a retry records no second request");
const second = await cancel(offline);
assert.equal(rejectionCode(second.outcome, "second open request"), "cancellation_already_requested");
assert.deepEqual(
  (await operator.getEntity(os.assetId)).task_queue?.requested_task_ids,
  [],
  "unstarted work leaves eligible order",
);
assert(
  (await installation.activity()).some(
    (entry) => entry.action === "task.request_cancellation" && entry.target_id === offline.id,
  ),
  "the request is attributed activity",
);

proxy.set("pass");
const reconnected = await process.receiveWork();
const delivered = reconnected.tasks.find((task) => task.id === offline.id);
assert.equal(delivered?.status, "cancellation_requested", "reconnect delivers the pending request");
const cancellationId = delivered.cancellations[0]?.cancellation_id ?? assert.fail();
await process.capture(await os.decideCancellation(offline.id, cancellationId, true));
await process.flush();
const cancelled = await operator.getTask(offline.id);
assert.equal(cancelled.status, "cancelled");
assert.equal(cancelled.cancellations[0]?.state, "confirmed");
assert.notEqual(cancelled.cancellations[0]?.resolution, null);
assert.equal(os.execution(offline.id).executionCount, 0, "cancelled unstarted work never executed");
step("offline request records intent and an identical retry replays; the reconnected Asset confirms cancellation");

// Online, while running: the request is intent only. Execution continues and
// completion before confirmation closes the request.
const running = await issue();
await process.receiveWork();
await process.capture(await os.startNext());
await process.flush();
acceptedOutcome((await cancel(running)).outcome, "running cancellation request");
const stillRunning = await operator.getTask(running.id);
assert.equal(stillRunning.status, "cancellation_requested");
assert.notEqual(stillRunning.lifecycle.started, null);
assert.equal(stillRunning.lifecycle.finished, null, "a request does not claim execution stopped");
assert.equal(os.execution(running.id).state, "running");
await process.capture(await os.progress(running.id, 2));
await process.capture(await os.complete(running.id));
await process.flush();
const finished = await operator.getTask(running.id);
assert.equal(finished.status, "completed", "valid completion while cancellation is unconfirmed");
assert.equal(finished.cancellations[0]?.state, "closed");
assert.equal(rejectionCode((await cancel(finished)).outcome, "request after outcome"), "task_terminal");
const late = await process.client.prepareTaskReport(running.id, {
  event: "cancellation_confirmed",
  cancellationId: finished.cancellations[0]?.cancellation_id ?? assert.fail(),
});
assert.equal(rejectionCode(await process.client.submitTaskReport(late), "late confirmation"), "terminal_conflict");
const conflicting = await process.client.prepareTaskReport(running.id, {
  event: "failed",
  failure: { code: "execution_failed", message: "late failure" },
});
assert.equal(
  rejectionCode(await process.client.submitTaskReport(conflicting), "conflicting outcome"),
  "terminal_conflict",
);
assert.equal((await operator.getTask(running.id)).status, "completed", "terminal outcomes are immutable");
step("running cancellation stays intent; completion closes it; terminal outcomes cannot be reopened");

// Decline restores unstarted work to its retained requested slot, after newer
// work was created.
const [a, b] = [await issue(), await issue()];
await process.receiveWork();
acceptedOutcome((await cancel(a)).outcome, "unstarted cancellation request");
const c = await issue();
assert.deepEqual((await operator.getEntity(os.assetId)).task_queue?.requested_task_ids, [b.id, c.id]);
const pending = (await operator.getTask(a.id)).cancellations[0]?.cancellation_id ?? assert.fail();
await process.capture(await os.decideCancellation(a.id, pending, false));
await process.flush();
const declined = await operator.getTask(a.id);
assert.equal(declined.status, "acknowledged");
assert.equal(declined.cancellations[0]?.state, "declined");
assert.deepEqual((await operator.getEntity(os.assetId)).task_queue?.requested_task_ids, [a.id, b.id, c.id]);
const repeatDecline = await process.client.prepareTaskReport(a.id, {
  event: "cancellation_declined",
  cancellationId: pending,
});
acceptedOutcome(await process.client.submitTaskReport(repeatDecline), "repeated decision has no further effect");
assert.equal((await operator.getTask(a.id)).version, declined.version);
step("declined cancellation restores the unstarted Task at its requested slot");

// Out-of-order and duplicate evidence: progress follows report ordering, and
// an identical report retry is a duplicate without effects.
await process.receiveWork();
await process.capture(await os.startNext());
await process.flush();
const nearer = await process.client.prepareTaskReport(a.id, {
  event: "progress",
  progress: { details: { command: "move_to", distance_remaining_m: 9 } },
});
const newest = await process.client.prepareTaskReport(a.id, {
  event: "progress",
  progress: { details: { command: "move_to", distance_remaining_m: 6 } },
});
acceptedOutcome(await process.client.submitTaskReport(newest), "newer progress first");
const older = acceptedOutcome(await process.client.submitTaskReport(nearer), "older progress later");
assert.equal(older.value.report?.disposition, "accepted");
assert.equal((await operator.getTask(a.id)).progress?.details?.distance_remaining_m, 6, "older progress does not win");
const beforeRetry = await operator.getTask(a.id);
const duplicate = acceptedOutcome(await process.client.submitTaskReport(newest), "identical report retry");
assert.equal(duplicate.value.report?.disposition, "duplicate", "the retry returns the original receipt");
assert.deepEqual(duplicate.value.report?.report_id, {
  dataset_id: newest.datasetId,
  asset_id: os.assetId,
  process_generation: newest.processGeneration,
  sequence: newest.sequence,
});
assert.equal((await operator.getTask(a.id)).version, beforeRetry.version, "a duplicate has no new effect");
step("reordered progress keeps the newest; an identical report retry is a duplicate");

// An Asset that declares no cancellation support still has intent recorded.
const noCancel = await establishedAsset(installation, {
  commandManifest: [
    { command: "move_to", scheduling: ["queued"], cancellation: false, progress: true, description: null },
  ],
});
const unsupportedTask = await issue(noCancel.os.assetId);
const recorded = acceptedOutcome((await cancel(unsupportedTask)).outcome, "request without support").value;
assert.equal(recorded.status, "cancellation_requested");
step("cancellation intent is recorded for an Asset that declares no cancellation support");

await proxy.close();
await installation.stop();
