// Thin end-to-end S1 workflow: CLI setup and Start, Asset enrollment and
// process authority, offline queued Move To issuance, delivery, independent
// 5.1/4.9 m progress, Asset-reported completion and movement history.
import assert from "node:assert/strict";
import { accepted } from "../../Atlas SDK/src/index.js";
import { prepareAsset, ReportingProcess } from "../simulator/index.js";
import { acceptedOutcome, Installation, requestTimeoutMs, runDirectory, step } from "./support.js";

const installation = await Installation.create();
const started = await installation.start();
assert.equal(started.outcome, "serving");
const operator = await installation.operator();
const discovery = await operator.discover();
assert.equal(discovery.protocolVersion, "0.0.0");
assert.equal(discovery.datasetId, started.dataset_id);
assert.deepEqual(discovery.principal?.kind, "operator");
assert.equal((await operator.readiness()).ready, true);
step("CLI setup and Start serve HTTPS with negotiated edition 0.0.0 and authenticated health");

const os = await prepareAsset(runDirectory(), (assetId, key) => installation.authorizeEnrollment(assetId, key), {
  alias: "Rover-1",
});
const link = { baseUrl: installation.baseUrl, fetch: await installation.fetch(), requestTimeoutMs };
const asset = new ReportingProcess(os, link);
const registration = acceptedOutcome(await asset.register(), "registration");
assert.equal(registration.status, 201);
const registered = await operator.getEntity(os.assetId);
assert.equal(registered.alias, "Rover-1");
assert.deepEqual(registered.components.status, {
  value: "unknown",
  reason: null,
  reported_at: null,
  received_at: null,
  changed_at: null,
});
assert.deepEqual(registered.components.communications, { state: "offline" });
assert.deepEqual(registered.components.heartbeat, { last_seen: null });
assert.equal(registered.components.telemetry, undefined, "registration invents no telemetry");
assert.deepEqual(registered.reporting, {});
assert.equal(registered.task_queue?.confirmed_revision, null);
assert.deepEqual(registered.task_queue?.requested_task_ids, []);
assert.deepEqual((await operator.movementHistory(os.assetId)).items, []);
step("registration through deployment enrollment: unknown status, offline, null Contact, no telemetry or samples");

const target = { latitude: 10, longitude: 20 };
const creation = await operator.prepareTaskCreation({
  assetId: os.assetId,
  input: { command: "move_to", target: { kind: "position", position: target } },
});
const created = await operator.createTask(creation);
assert.equal(created.outcome, "accepted");
const task = accepted(created);
assert.equal(created.outcome === "accepted" && created.status, 201);
assert.equal(task.status, "pending");
assert.equal(task.scheduling, "queued");
assert.equal(task.submission_sequence, "1");
assert.equal((await operator.getEntity(os.assetId)).components.communications.state, "offline");
step("queued coordinate Move To issued while the Asset is offline");

const establishment = await asset.establish({
  components: { telemetry: { position: { latitude: 10.0003, longitude: 20 } } },
});
assert.equal(establishment.outcome, "accepted");
const authority = establishment.outcome === "accepted" ? establishment.value.report : undefined;
assert.equal(authority?.authority?.process_generation, "1");
assert.equal(authority?.contact_refreshed, true);
const online = await operator.getEntity(os.assetId);
assert.equal(online.components.communications.state, "high_bandwidth");
assert.notEqual(online.components.heartbeat.last_seen, null);
step("process-authority claim and first check-in establish generation 1 and fresh Contact");

const work = await asset.receiveWork();
assert.deepEqual(
  work.tasks.map((assigned) => assigned.id),
  [task.id],
);
assert.equal((await operator.getTask(task.id)).status, "pending", "reading work acknowledges nothing");
await asset.capture(await os.startNext());
assert.deepEqual(
  (await asset.flush()).map((submission) => submission.outcome),
  ["accepted", "accepted"],
);
assert.equal((await operator.getTask(task.id)).status, "in_progress");
assert.equal(os.execution(task.id).executionCount, 1);

await asset.capture(await os.progress(task.id, 5.1));
await asset.flush();
const far = await operator.getTask(task.id);
assert.equal(far.status, "in_progress", "5.1 m remains in progress");
assert.equal(far.progress?.details?.distance_remaining_m, 5.1);
await assert.rejects(() => os.complete(task.id), /not within 5 m/u);

await asset.capture(await os.progress(task.id, 4.9));
await asset.capture(await os.complete(task.id));
await asset.flush();
const done = await operator.getTask(task.id);
assert.equal(done.status, "completed");
assert.equal(done.progress?.details?.distance_remaining_m, 4.9);
assert.notEqual(done.lifecycle.finished, null);
assert.deepEqual((await operator.getEntity(os.assetId)).task_queue?.requested_task_ids, []);
step("independent progress 5.1 m stays In progress; 4.9 m plus Asset completion records Completed");

const history = await operator.movementHistory(os.assetId);
assert.equal(history.items.length, 1);
assert.deepEqual(history.items[0]?.position?.value, { latitude: 10.0003, longitude: 20 });
assert.equal(history.time_basis, "received_at");
const activity = await installation.activity();
const actions = activity.map((entry) => entry.action);
for (const expected of ["installation.setup", "core.start", "task.issue"]) {
  assert(actions.includes(expected), `activity records ${expected}`);
}
step("movement history retains the check-in sample; activity records setup, Start and issuance");

const stopped = await installation.stop();
assert.equal(stopped.outcome, "stopped");
