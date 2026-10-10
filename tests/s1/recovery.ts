import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAtlasClient, createAssetClient, type AssetProcessSnapshot } from "../../Atlas SDK/src/index.js";
import { createHTTPSFetch } from "../../Atlas SDK/src/node.js";
import { accepted, createSDKAsset, type S1Config } from "../../examples/s1/workflow.js";
import { openExecutionStore } from "../../examples/s1/execution-store.js";
import { openReportingRuntime } from "../../examples/s1/reporting-runtime.js";

export async function runRecoveryWorkflow(config: S1Config) {
  const network = createHTTPSFetch({ ca: await readFile(config.caPath), maxJSONBytes: 1048576, timeoutMs: 5000 });
  let discardPath: string | null = null;
  const faultyFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const response = await network(request);
    if (request.method !== "GET" && new URL(request.url).pathname === discardPath) {
      discardPath = null;
      throw new TypeError("Scheduled loss of a real successful response");
    }
    return response;
  };
  discardPath = "/entities";
  const {
    assetId,
    directory,
    runtime: registeringRuntime,
    operator,
    registered,
  } = await createSDKAsset(config, faultyFetch);
  assert.equal(registered.outcome, "unknown_outcome");
  const runtime = await openReportingRuntime(directory, assetId);
  await runtime.replaceProcess();
  const client = createAtlasClient({ baseUrl: config.baseUrl, credential: runtime.credential, fetch: faultyFetch });
  accepted(await client.discover());
  const pendingRegistration = runtime.pending().find((item) => item.descriptor.operation === "register_asset");
  assert(pendingRegistration && pendingRegistration.descriptor.operation === "register_asset");
  const resumedRegistration = accepted(await client.submit(pendingRegistration.descriptor));
  await runtime.acknowledge(pendingRegistration.id);
  assert.equal(resumedRegistration.data.entity.id, assetId);
  assert.equal(resumedRegistration.data.entity.components.heartbeat.last_seen, null);
  assert.equal(resumedRegistration.data.entity.process_authority, null);
  assert.equal(accepted(await operator.listEntities()).data.items.length, 1);
  assert.equal(registeringRuntime.credential(), runtime.credential());
  let reporter = createAssetClient({ client, assetId, signer: runtime.signer(), authorizer: runtime.authorizer() });
  const health = accepted(await client.discover({ asset_id: assetId, process_generation: "1" }));
  const initial = await reporter.prepareAuthority({
    expectedGeneration: "0",
    transferId: randomUUID(),
    generatedAt: new Date().toISOString(),
    contactChallenge: health.data.contact_challenge?.token ?? null,
  });
  const initialId = await runtime.retain(initial, reporter.snapshot());
  reporter.observeAuthority(accepted(await client.submit(initial)));
  await runtime.acknowledge(initialId, reporter.snapshot());
  const taskIds: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const task = operator.prepareTask({
      asset_id: assetId,
      idempotency_key: randomUUID(),
      command: "move_to",
      input: { target: { kind: "position", position: { latitude: 10, longitude: 20 } } },
    });
    taskIds.push(accepted(await operator.submit(task)).data.id);
  }
  const [completedId, runningId, suspendedId, unknownId, continuationId, untouchedId] = taskIds;
  assert(completedId && runningId && suspendedId && unknownId && continuationId && untouchedId);
  const executions = await openExecutionStore(join(directory, "os"));
  await executions.loadTasks(taskIds);
  const originalTime = "2026-10-10T01:00:00.500+00:00";
  for (const id of [completedId, runningId, suspendedId, unknownId]) await executions.start(id, originalTime, null);
  await executions.distance(completedId, 4.9, originalTime);
  const completeExecution = executions.snapshot(completedId);
  assert(completeExecution.executionId);
  const completion = await reporter.prepareTaskReport(
    completedId,
    {
      status: "completed",
      execution_id: completeExecution.executionId,
      finished_at: originalTime,
      progress: { distance_remaining_m: 4.9 },
    },
    { generatedAt: originalTime },
  );
  await executions.recordReport(completedId, completion);
  const completionId = await runtime.retain(completion, reporter.snapshot());
  discardPath = `/tasks/${completedId}/status`;
  const lost = await client.submit(completion);
  assert.equal(lost.outcome, "unknown_outcome");
  assert.equal(accepted(await operator.getTask(completedId)).data.status, "completed");
  // A new same-process SDK instance restores exactly the pending descriptor.
  const restoredRuntime = await openReportingRuntime(directory, assetId);
  const restoredClient = createAtlasClient({
    baseUrl: config.baseUrl,
    credential: restoredRuntime.credential,
    fetch: network,
  });
  accepted(await restoredClient.discover());
  const pending = restoredRuntime.pending().find((item) => item.id === completionId);
  assert(pending);
  const replay = accepted(await restoredClient.submit(pending.descriptor));
  assert(replay && "data" in replay && "acceptance" in replay.data);
  assert.equal(replay.data.acceptance.disposition, "duplicate");
  await restoredRuntime.acknowledge(completionId);
  assert.equal((await openExecutionStore(join(directory, "os"))).snapshot(completedId).executionCount, 1);
  for (const id of [runningId, suspendedId]) {
    const execution = executions.snapshot(id);
    assert(execution.executionId);
    const report = await reporter.prepareTaskReport(
      id,
      { status: "in_progress", execution_id: execution.executionId, started_at: originalTime },
      { generatedAt: originalTime },
    );
    await executions.recordReport(id, report);
    const reportId = await restoredRuntime.retain(report, reporter.snapshot());
    accepted(await client.submit(report));
    await restoredRuntime.acknowledge(reportId, reporter.snapshot());
  }
  await executions.suspend(suspendedId, originalTime);
  await executions.loseEvidence(unknownId, [continuationId]);
  await restoredRuntime.replaceProcess();
  const replacementClient = createAtlasClient({
    baseUrl: config.baseUrl,
    credential: restoredRuntime.credential,
    fetch: faultyFetch,
  });
  accepted(await replacementClient.discover());
  const replacement = createAssetClient({
    client: replacementClient,
    assetId,
    signer: restoredRuntime.signer(),
    authorizer: restoredRuntime.authorizer(),
  });
  const candidateHealth = accepted(await replacementClient.discover({ asset_id: assetId, process_generation: "2" }));
  const claim = await replacement.prepareAuthority({
    expectedGeneration: "1",
    transferId: randomUUID(),
    generatedAt: new Date().toISOString(),
    contactChallenge: candidateHealth.data.contact_challenge?.token ?? null,
  });
  const claimId = await restoredRuntime.retain(claim, replacement.snapshot());
  discardPath = `/entities/${assetId}/checkin`;
  assert.equal((await replacementClient.submit(claim)).outcome, "unknown_outcome");
  assert.equal(accepted(await operator.getEntity(assetId)).data.process_authority?.process_generation, "2");
  const recoveredRuntime = await openReportingRuntime(directory, assetId);
  const recoveredClient = createAtlasClient({
    baseUrl: config.baseUrl,
    credential: recoveredRuntime.credential,
    fetch: network,
  });
  accepted(await recoveredClient.discover());
  reporter = createAssetClient({
    client: recoveredClient,
    assetId,
    signer: recoveredRuntime.signer(),
    authorizer: recoveredRuntime.authorizer(),
    nextSequence: recoveredRuntime.reportState().nextSequence,
  });
  const retainedClaim = recoveredRuntime.pending().find((item) => item.id === claimId);
  assert(retainedClaim && retainedClaim.descriptor.operation === "checkin");
  const recoveredClaim = accepted(await recoveredClient.submit(retainedClaim.descriptor));
  reporter.observeAuthority(recoveredClaim);
  await recoveredRuntime.acknowledge(claimId, reporter.snapshot());
  assert.equal(recoveredClaim.data.acceptance.disposition, "duplicate");
  const retainedExecutions = await openExecutionStore(join(directory, "os"));
  const snapshot = () => ({
    ...reporter.snapshot(),
    executions: retainedExecutions.evidence(),
    pending: recoveredRuntime.pending().map((item) => item.descriptor),
  });
  const plan = accepted(await reporter.reconcile(snapshot()));
  assert(plan.heldTaskIds.includes(unknownId));
  assert(plan.heldTaskIds.includes(continuationId));
  assert.deepEqual(
    plan.tasks.map((task) => task.id),
    [untouchedId],
  );
  assert(!plan.tasks.some((task) => task.id === completedId || task.id === runningId || task.id === suspendedId));
  for (const report of plan.reports) {
    const id = await recoveredRuntime.retain(report, reporter.snapshot());
    const result = accepted(await recoveredClient.submit(report));
    assert.equal(result.data.acceptance.contact_refreshed, false);
    await recoveredRuntime.acknowledge(id, reporter.snapshot());
  }
  const recoveredSuspension = accepted(await operator.getTask(suspendedId)).data;
  assert.equal(recoveredSuspension.status, "paused");
  assert.equal(recoveredSuspension.started_at, originalTime);
  const recoveredRunning = accepted(await operator.getTask(runningId)).data;
  assert.equal(recoveredRunning.status, "in_progress");
  assert.equal(recoveredRunning.started_at, originalTime);
  // Lost OS records are uncertainty even when Core still knows an execution or
  // has not yet received its start report. Neither permits another execution.
  for (const missingId of [runningId, suspendedId, unknownId]) {
    const incomplete = snapshot();
    incomplete.executions = incomplete.executions.filter((evidence) => evidence.taskId !== missingId);
    const held = accepted(await reporter.reconcile(incomplete));
    assert(held.heldTaskIds.includes(missingId));
    assert(held.heldTaskIds.includes(untouchedId));
    assert.equal(held.tasks.length, 0);
    assert(!held.reports.some((report) => report.targetId === missingId));
  }
  assert.equal(retainedExecutions.snapshot(completedId).executionCount, 1);
  assert.equal(retainedExecutions.snapshot(runningId).executionCount, 1);
  assert.equal(retainedExecutions.snapshot(suspendedId).executionCount, 1);
  await assert.rejects(retainedExecutions.start(continuationId, originalTime, null));
  await retainedExecutions.recover(unknownId, {
    state: "running",
    eventTime: originalTime,
    progress: { distanceRemainingM: 20 },
  });
  const released = accepted(await reporter.reconcile(snapshot()));
  assert(!released.heldTaskIds.includes(unknownId));
  assert(!released.heldTaskIds.includes(continuationId));
  assert(released.tasks.some((task) => task.id === continuationId));
  const confirmedState: AssetProcessSnapshot = reporter.snapshot();
  assert.equal(confirmedState.processGeneration, "2");
  console.log(
    "PASS real container SDK recovery: lost completion/authority replies, exact retained replay, replacement, execution counts, missing evidence and explicit unknown hold/recovery",
  );
}
