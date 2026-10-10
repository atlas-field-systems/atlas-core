// Reconnect and reporting-process replacement from independently retained
// execution evidence: same-process offline execution, retained descriptors
// and times, completed work never rerun, unknown work and its continuation
// held until explicit recovery, and suspended work surviving replacement.
import assert from "node:assert/strict";
import { accepted, type Task } from "../../Atlas SDK/src/index.js";
import { AssetOS, ReportingProcess } from "../simulator/index.js";
import {
  acceptedOutcome,
  establishedAsset,
  FaultProxy,
  Installation,
  moveTo,
  requestTimeoutMs,
  sameInstant,
  step,
} from "./support.js";

const installation = await Installation.create();
await installation.start();
const operator = await installation.operator();
const proxy = await FaultProxy.start(installation);
const link = { baseUrl: proxy.baseUrl, fetch: await installation.fetch(), requestTimeoutMs };
const issue = async (assetId: string, latitude = 10): Promise<Task> =>
  accepted(await operator.createTask(await operator.prepareTaskCreation({ assetId, input: moveTo(latitude, 20) })));

// Same process: execution continues offline; reconnect reports the retained
// evidence as historical, without fresh Contact or rerun.
{
  const { os, process } = await establishedAsset(installation, { link });
  const first = await issue(os.assetId);
  const second = await issue(os.assetId, 11);
  await process.receiveWork();
  await process.capture(await os.startNext());
  await process.flush();
  proxy.set("refuse");
  // A cached challenge still prepares current evidence for half its 10 s
  // window. Let that pass, so offline evidence cannot claim a challenge.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_500));
  const offlineObservation = new Date().toISOString();
  for (const evidence of [
    await os.progress(first.id, 1),
    await os.complete(first.id),
    await os.startNext(),
    await os.observe({ position: { latitude: 10, longitude: 20 } }, { position: offlineObservation }),
  ]) {
    await process.capture(evidence);
  }
  assert(
    os.pending().every((evidence) => evidence.descriptor === null),
    "nothing could be prepared while disconnected",
  );
  assert.equal((await operator.getTask(first.id)).status, "in_progress", "Core infers nothing from silence");
  const seen = (await operator.getEntity(os.assetId)).components.heartbeat.last_seen;

  proxy.set("pass");
  const submissions = await process.flush();
  assert.deepEqual(
    submissions.map((submission) => submission.outcome),
    ["accepted", "accepted", "accepted", "accepted"],
  );
  assert.equal((await operator.getTask(first.id)).status, "completed");
  assert.equal((await operator.getTask(second.id)).status, "in_progress");
  assert.equal(
    (await operator.getEntity(os.assetId)).components.heartbeat.last_seen,
    seen,
    "historical evidence is not Contact",
  );
  const sample = (await operator.movementHistory(os.assetId)).items.at(-1);
  sameInstant(sample?.position?.observed_at, offlineObservation, "original observation time");
  assert.equal(sample?.retained_evidence_id, os.evidence().at(-1)?.id, "stable retained evidence identity");
  assert.deepEqual(await process.flush(), [], "nothing is delivered twice");
  assert.equal(os.execution(first.id).executionCount, 1);
  assert.equal(os.execution(second.id).executionCount, 1);
  step("same-process offline execution reconnects with historical evidence, original times and no rerun");
}

// Replacement: completed work stays done; a descriptor prepared before the
// old process lost its link keeps its identity and time; unknown work holds
// its queued continuation until explicit recovery.
{
  const { os, process } = await establishedAsset(installation, { link });
  const done = await issue(os.assetId);
  const uncertain = await issue(os.assetId, 11);
  const queued = await issue(os.assetId, 12);
  await process.receiveWork();
  await process.capture(await os.startNext());
  await process.capture(await os.progress(done.id, 2));
  await process.capture(await os.complete(done.id));
  await process.capture(await os.startNext());
  await process.flush();
  const unsent = await os.progress(uncertain.id, 30);
  await process.capture(unsent);
  const original = os.evidence().find((evidence) => evidence.id === unsent.id)?.descriptor ?? assert.fail();
  proxy.set("refuse");
  assert.equal((await process.flush())[0]?.outcome, "unknown_outcome", "the old process loses its link");
  await os.loseCertainty(uncertain.id);
  proxy.set("pass");

  const restored = await AssetOS.load(os.file);
  await restored.replaceProcess();
  const replacement = new ReportingProcess(restored, link);
  acceptedOutcome(await replacement.establish(), "replacement claim");
  const recovered = await replacement.flush();
  assert.deepEqual(
    recovered.map((submission) => submission.outcome),
    ["accepted"],
  );
  const progress = (await operator.getTask(uncertain.id)).progress;
  assert.equal(progress?.details?.distance_remaining_m, 30);
  sameInstant(progress?.reported_at, original.body.report_context?.generated_at, "the original event time is retained");
  const work = await replacement.receiveWork();
  assert.deepEqual(
    work.tasks.map((task) => task.id),
    [uncertain.id, queued.id],
    "completed work is no longer outstanding",
  );
  assert.equal(await restored.startNext(), undefined, "unknown work holds its continuation");
  assert.equal(restored.execution(queued.id).executionCount, 0);
  assert.equal(restored.execution(done.id).executionCount, 1, "completed work is not dispatched again");
  assert.equal((await operator.getTask(uncertain.id)).status, "in_progress", "no outcome is inferred");

  await replacement.capture(await restored.recover(uncertain.id, "completed"));
  await replacement.capture(await restored.startNext());
  await replacement.flush();
  assert.equal((await operator.getTask(uncertain.id)).status, "completed");
  assert.equal(
    (await operator.getTask(queued.id)).status,
    "in_progress",
    "explicit recovery releases the continuation",
  );
  assert.equal(restored.execution(queued.id).executionCount, 1);
  step(
    "replacement keeps completed work done, retains the unsent descriptor's identity and time, and holds unknown work",
  );
}

// Suspended work survives replacement and keeps the queue held.
{
  const { os, process } = await establishedAsset(installation, { link });
  const suspended = await issue(os.assetId);
  const behind = await issue(os.assetId, 11);
  await process.receiveWork();
  await process.capture(await os.startNext());
  await process.flush();
  await os.suspend(suspended.id);
  const restored = await AssetOS.load(os.file);
  await restored.replaceProcess();
  const replacement = new ReportingProcess(restored, link);
  acceptedOutcome(await replacement.establish(), "replacement claim");
  await replacement.receiveWork();
  assert.equal(restored.execution(suspended.id).state, "suspended");
  assert.equal(await restored.startNext(), undefined, "suspended work holds the queue");
  assert.equal((await operator.getTask(suspended.id)).status, "in_progress");
  assert.equal((await operator.getTask(behind.id)).status, "acknowledged");
  step("suspended work survives replacement without another dispatch");
}

await proxy.close();
await installation.stop();
