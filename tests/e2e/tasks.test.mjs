import assert from "node:assert/strict";

import { AtlasClient, AtlasError, PictureError, commandCatalog } from "../../sdk/dist/index.js";
import { enrollAsset } from "./harness/assets.mjs";
import { Gate, HeldFeed, eventually, gatedFetch } from "./harness/barriers.mjs";
import { scenario } from "./harness/scenario.mjs";

function report(s, identity, sequence, status, extra = {}) {
  const reportId = crypto.randomUUID();
  s.transcript.name(reportId, `task report ${sequence}`);
  return { dataset_id: identity.datasetId, report_id: reportId, sequence, status, ...extra };
}

scenario("Move To is accepted once and the assigned Asset reports its outcome", async (s) => {
  const core = await s.startCore();
  const asset = await s.step("Enroll a Move To capable Asset", () => enrollAsset(s, core));
  const operator = s.client(core, core.installation.operatorKey);
  const picture = s.pictureClient(core, core.installation.operatorKey);
  await s.step("Load the operational picture", () => picture.startSynchronization());

  const submission = await s.step("Prepare a destination from the local catalog", async () => {
    assert.deepEqual(commandCatalog.move_to.scheduling, ["queued"]);
    const prepared = await operator.prepareMoveTo(asset.identity.assetId, { latitude: 42.2743, longitude: -71.8081 });
    s.transcript.name(prepared.submission_id, "Move To submission");
    return prepared;
  });
  const task = await s.step("Issue Move To while the Asset has no contact", async () => {
    const created = await operator.submitTask(submission);
    s.transcript.name(created.id, "Move To task");
    assert.equal(created.status, "pending");
    assert.equal(created.acceptance_sequence, 1);
    assert.equal((await operator.assignedTasks(asset.identity.assetId)).tasks[0].status, "pending");
    const direct = await s.request(core, `/tasks/${created.id}`, { credential: core.installation.operatorKey });
    assert.equal(direct.status, 200);
    assert.deepEqual(direct.body, created);
    await picture.waitForSynchronization(created);
    assert.deepEqual(await picture.task(created.id), created);
    const missingEntity = crypto.randomUUID();
    s.transcript.name(missingEntity, "missing Entity");
    await assert.rejects(operator.assignedTasks(missingEntity), (error) => error instanceof AtlasError && error.code === "not_found");
    await assert.rejects(picture.assignedTasks(missingEntity), (error) => error instanceof PictureError && error.code === "not_found");
    return created;
  });

  await s.step("A matching retry returns the same Task and a changed retry conflicts", async () => {
    const retry = await operator.submitTask(submission);
    assert.deepEqual(retry, task);
    await assert.rejects(operator.submitTask({ ...submission, input: { latitude: 1, longitude: 2 } }), (error) => error instanceof AtlasError && error.code === "submission_conflict");
    assert.equal((await operator.tasks()).tasks.length, 1);
  });

  await s.step("Only the assigned Asset reports acknowledgement, progress and completion", async () => {
    const other = await enrollAsset(s, core, { alias: "Other" }, "other");
    const acknowledged = report(s, asset.identity, 1, "acknowledged");
    await assert.rejects(other.client.reportTask(task.id, acknowledged), (error) => error instanceof AtlasError && error.status === 403);
    await assert.rejects(asset.client.reportTask(task.id, report(s, asset.identity, 1, "acknowledged", { progress_percent: 20 })), (error) => error instanceof AtlasError && error.code === "invalid_task_status");
    const first = await asset.client.reportTask(task.id, acknowledged);
    assert.equal(first.status, "acknowledged");
    const running = await asset.client.reportTask(task.id, report(s, asset.identity, 2, "in_progress", { progress_percent: 40 }));
    assert.equal(running.progress_percent, 40);
    const progressOnly = report(s, asset.identity, 3, undefined, { progress_percent: 60 });
    delete progressOnly.status;
    const progressed = await asset.client.reportTask(task.id, progressOnly);
    assert.equal(progressed.status, "in_progress");
    assert.equal(progressed.progress_percent, 60);
    const done = await asset.client.reportTask(task.id, report(s, asset.identity, 4, "completed", { progress_percent: 100 }));
    assert.deepEqual(await asset.client.reportTask(task.id, progressOnly), done);
    const contactBefore = await operator.entity(asset.identity.assetId);
    const confirmedAgain = await asset.client.reportTask(task.id, report(s, asset.identity, 5, "completed", { progress_percent: 100 }));
    assert.equal(confirmedAgain.change_sequence, done.change_sequence);
    assert.equal((await operator.entity(asset.identity.assetId)).version, contactBefore.version + 1);
    await picture.waitForSynchronization(done);
    assert.deepEqual(await picture.task(task.id), done);
    assert.equal((await operator.entity(asset.identity.assetId)).components.heartbeat.last_seen !== null, true);
    assert.equal((await operator.assignedTasks(asset.identity.assetId)).tasks[0].status, "completed");
    const full = await s.transcript.unrecorded(async () => {
      const first = await operator.queryFull();
      assert.equal(first.tasks.length, 0);
      return operator.queryFull(first.next_cursor);
    });
    assert.equal(full.tasks[0].status, "completed");
    s.transcript.observe("snapshot Task status", full.tasks[0].status);
  });
});

scenario("Move To honors the Asset's declared cancellation and progress support", async (s) => {
  const core = await s.startCore();
  const asset = await s.step("Enroll an Asset without cancellation or progress support", () => enrollAsset(s, core, {
    alias: "Limited",
    command_manifest: [{ command_id: "move_to", scheduling: ["queued"], cancellation: false, progress: false }],
  }));
  const operator = s.client(core, core.installation.operatorKey);
  const submission = await s.step("Prepare Move To", () => operator.prepareMoveTo(asset.identity.assetId, { latitude: 40, longitude: -70 }));
  s.transcript.name(submission.submission_id, "limited submission");
  const task = await s.step("The supported Command still creates a Task", async () => {
    const created = await operator.submitTask(submission);
    s.transcript.name(created.id, "limited task");
    return created;
  });
  await s.step("The catalog rejects unsupported manifest scheduling", async () => {
    const reportId = crypto.randomUUID();
    s.transcript.name(reportId, "unsupported manifest report");
    const before = await operator.entity(asset.identity.assetId);
    await assert.rejects(asset.client.patchEntity(asset.identity.assetId, {
      datasetId: asset.identity.datasetId,
      reportId,
      sequence: 1,
      commandManifest: [{ command_id: "move_to", scheduling: ["immediate"] }],
    }), (error) => error instanceof AtlasError && error.code === "invalid_command_manifest");
    assert.deepEqual(await operator.entity(asset.identity.assetId), before);
  });
  await s.step("Unsupported cancellation and progress fail without changing the Task", async () => {
    const cancellationId = crypto.randomUUID();
    s.transcript.name(cancellationId, "unsupported cancellation");
    await assert.rejects(operator.cancelTask(task.id, asset.identity.datasetId, cancellationId), (error) => error instanceof AtlasError && error.code === "unsupported_cancellation");
    await assert.rejects(asset.client.reportTask(task.id, report(s, asset.identity, 1, "in_progress", { progress_percent: 10 })), (error) => error instanceof AtlasError && error.code === "unsupported_progress");
    assert.equal((await operator.task(task.id)).status, "pending");
  });
  await s.step("The assigned Asset can still complete the Task", async () => {
    const completed = await asset.client.reportTask(task.id, report(s, asset.identity, 1, "completed"));
    assert.equal(completed.status, "completed");
  });
});

scenario("A cancellation request remains intent until the Asset confirms it", async (s) => {
  const core = await s.startCore();
  const asset = await s.step("Enroll a Move To capable Asset", () => enrollAsset(s, core));
  const operator = s.client(core, core.installation.operatorKey);
  const submission = await s.step("Prepare Move To", () => operator.prepareMoveTo(asset.identity.assetId, { latitude: 40, longitude: -70 }));
  s.transcript.name(submission.submission_id, "Move To submission");
  const task = await s.step("Issue a Task", async () => {
    const created = await operator.submitTask(submission);
    s.transcript.name(created.id, "Move To task");
    return created;
  });
  const cancellationId = crypto.randomUUID();
  s.transcript.name(cancellationId, "cancellation request");
  await s.step("Request cancellation while the Asset is disconnected", async () => {
    const requested = await operator.cancelTask(task.id, asset.identity.datasetId, cancellationId);
    assert.equal(requested.status, "cancellation_requested");
    assert.equal((await operator.cancelTask(task.id, asset.identity.datasetId, cancellationId)).change_sequence, requested.change_sequence);
    assert.equal((await asset.client.assignedTasks(asset.identity.assetId)).tasks[0].status, "cancellation_requested");
  });
  await s.step("Late progress cannot clear cancellation intent", async () => {
    const reported = await asset.client.reportTask(task.id, report(s, asset.identity, 1, "in_progress", { progress_percent: 25 }));
    assert.equal(reported.status, "cancellation_requested");
    assert.equal(reported.progress_percent, 25);
  });
  await s.step("The assigned Asset confirms the identified cancellation", async () => {
    const canceled = await asset.client.reportTask(task.id, report(s, asset.identity, 2, "cancelled", { cancellation_request_id: cancellationId }));
    assert.equal(canceled.status, "cancelled");
    assert.equal((await operator.task(task.id)).status, "cancelled");
    await assert.rejects(asset.client.reportTask(task.id, report(s, asset.identity, 3, "completed")), (error) => error instanceof AtlasError && error.code === "task_transition_conflict");
  });
});

scenario("Concurrent and lost-response Move To retries retain Task identity through Restart", async (s) => {
  const installation = await s.installation();
  let core = await s.startCore(installation);
  const asset = await s.step("Enroll a Move To capable Asset", () => enrollAsset(s, core));
  let operator = s.client(core, installation.operatorKey);
  const submission = await s.step("Prepare a durable submission", () => operator.prepareMoveTo(asset.identity.assetId, { latitude: 40, longitude: -70 }));
  s.transcript.name(submission.submission_id, "Move To submission");

  const accepted = await s.step("Lose the acceptance response and race matching retries", async () => {
    const losing = s.clientLosingFirstResponse(core, installation.operatorKey, "POST");
    await assert.rejects(losing.submitTask(submission), /response lost/);
    const [first, second] = await Promise.all([operator.submitTask(submission), operator.submitTask(submission)]);
    s.transcript.name(first.id, "Move To task");
    assert.deepEqual(first, second);
    assert.equal(first.acceptance_sequence, 1);
    assert.equal((await operator.tasks()).tasks.length, 1);
    return first;
  });

  await s.step("Restart Core without inventing an outcome", async () => {
    await core.stop();
    core = await s.startCore(installation);
    operator = s.client(core, installation.operatorKey);
    assert.deepEqual(await operator.submitTask(submission), accepted);
    assert.equal((await operator.task(accepted.id)).status, "pending");
    const picture = s.pictureClient(core, installation.operatorKey);
    await picture.startSynchronization();
    assert.deepEqual(await picture.task(accepted.id), accepted);
    picture.stopSynchronization();
  });

  await s.step("A deliberate new Task gets the next permanent Asset sequence", async () => {
    const next = await operator.prepareMoveTo(asset.identity.assetId, { latitude: 41, longitude: -71 });
    s.transcript.name(next.submission_id, "next submission");
    const created = await operator.submitTask(next);
    s.transcript.name(created.id, "next task");
    assert.equal(created.acceptance_sequence, 2);
    assert.deepEqual((await operator.assignedTasks(asset.identity.assetId)).tasks.map((task) => task.id), [accepted.id, created.id]);
  });
});

scenario("Direct Protocol Task writes agree with SDK reads", async (s) => {
  const core = await s.startCore();
  const asset = await s.step("Enroll a Move To capable Asset", () => enrollAsset(s, core));
  const operator = s.client(core, core.installation.operatorKey);
  const submissionId = crypto.randomUUID();
  s.transcript.name(submissionId, "direct submission");
  const submission = { dataset_id: asset.identity.datasetId, submission_id: submissionId, asset_id: asset.identity.assetId, command_id: "move_to", scheduling: "queued", input: { latitude: 43, longitude: -72 } };
  const task = await s.step("Create through direct Protocol and read through the SDK", async () => {
    const response = await s.request(core, "/tasks", { method: "POST", credential: core.installation.operatorKey, body: submission });
    assert.equal(response.status, 201);
    s.transcript.name(response.body.id, "direct task");
    assert.deepEqual(await operator.task(response.body.id), response.body);
    return response.body;
  });
  await s.step("Report through direct Protocol and read the same authoritative outcome", async () => {
    const body = report(s, asset.identity, 1, "completed", { progress_percent: 100 });
    const response = await s.request(core, `/tasks/${task.id}/status`, { method: "PATCH", credential: asset.identity.credential, body });
    assert.equal(response.status, 200);
    assert.deepEqual(await operator.task(task.id), response.body);
    assert.equal(response.body.status, "completed");
    assert.equal((await operator.entity(asset.identity.assetId)).change_sequence, response.body.change_sequence - 1);
  });
  await s.step("Protocol rejects an empty failure reason before contact changes", async () => {
    const before = await operator.entity(asset.identity.assetId);
    const body = report(s, asset.identity, 2, "failed", { failure_reason: "" });
    const response = await s.request(core, `/tasks/${task.id}/status`, { method: "PATCH", credential: asset.identity.credential, body });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, "invalid_request");
    assert.deepEqual(await operator.entity(asset.identity.assetId), before);
  });
});

scenario("A matching progress report retry survives a later Task failure", async (s) => {
  const core = await s.startCore();
  const asset = await s.step("Enroll the assigned Asset", () => enrollAsset(s, core));
  const operator = s.client(core, core.installation.operatorKey);
  const submission = await s.step("Prepare Move To", () => operator.prepareMoveTo(asset.identity.assetId, { latitude: 40, longitude: -70 }));
  s.transcript.name(submission.submission_id, "Move To submission");
  const task = await s.step("Create Move To", () => operator.submitTask(submission));
  s.transcript.name(task.id, "Move To task");

  await s.step("Asset reports progress and then failure", async () => {
    await asset.client.reportTask(task.id, report(s, asset.identity, 1, "in_progress", { progress_percent: 20 }));
    const progress = report(s, asset.identity, 2, undefined, { progress_percent: 30 });
    delete progress.status;
    await asset.client.reportTask(task.id, progress);
    const failed = await asset.client.reportTask(task.id, report(s, asset.identity, 3, "failed", { failure_reason: "route blocked" }));
    const contact = await operator.entity(asset.identity.assetId);
    const retried = await asset.client.reportTask(task.id, progress);
    assert.deepEqual(retried, failed);
    assert.deepEqual(await operator.entity(asset.identity.assetId), contact);
    assert.deepEqual(await operator.task(task.id), failed);
  });
});

scenario("A Task receipt waits for every earlier change before local application", async (s) => {
  const core = await s.startCore();
  const asset = await s.step("Enroll a Move To capable Asset", () => enrollAsset(s, core));
  const operator = s.client(core, core.installation.operatorKey);
  const feeds = [];
  const picture = s.pictureClient(core, core.installation.operatorKey, { webSocketFactory: HeldFeed.into(feeds) });
  await s.step("Synchronize before tasking", () => picture.startSynchronization());
  const baseline = (await picture.queryFull()).baseline;
  const observed = [];
  await picture.subscribeFeed((change) => observed.push(change.sequence));
  const [first, second] = await s.step("Prepare two Move To submissions", async () => [
    await operator.prepareMoveTo(asset.identity.assetId, { latitude: 40, longitude: -70 }),
    await operator.prepareMoveTo(asset.identity.assetId, { latitude: 41, longitude: -71 }),
  ]);
  s.transcript.name(first.submission_id, "first submission");
  s.transcript.name(second.submission_id, "second submission");
  const [one, two] = await s.step("Core commits two Tasks while the feed holds both changes", async () => {
    const one = await operator.submitTask(first);
    const two = await operator.submitTask(second);
    s.transcript.name(one.id, "first Task");
    s.transcript.name(two.id, "second Task");
    await eventually(() => feeds[0].held.length === 2, "two held Task changes");
    assert.equal(two.acceptance_sequence, one.acceptance_sequence + 1);
    await assert.rejects(picture.waitForSynchronization(two, 50), (error) => error instanceof PictureError && error.code === "sync_timeout");
    return [one, two];
  });
  await s.step("Deliver the second change first, then replay the missing first change", async () => {
    feeds[0].release(1);
    await picture.waitForSynchronization(two);
    assert.deepEqual((await picture.tasks()).tasks.map((task) => task.id), [one.id, two.id]);
    assert.deepEqual((await picture.changedSince(baseline)).changes.map((change) => change.sequence), [one.change_sequence, two.change_sequence]);
    assert.deepEqual(observed, [one.change_sequence, two.change_sequence]);
  });
});

scenario("A fresh terminal report waits for its Asset contact", async (s) => {
  const core = await s.startCore();
  const asset = await s.step("Enroll the assigned Asset", () => enrollAsset(s, core));
  const operator = s.client(core, core.installation.operatorKey);
  const submission = await s.step("Prepare Move To", () => operator.prepareMoveTo(asset.identity.assetId, { latitude: 40, longitude: -70 }));
  s.transcript.name(submission.submission_id, "Move To submission");
  const task = await s.step("Create Move To", () => operator.submitTask(submission));
  s.transcript.name(task.id, "Move To task");
  const completed = await s.step("Asset completes Move To", () => asset.client.reportTask(task.id, report(s, asset.identity, 1, "completed")));
  const feeds = [];
  const picture = s.pictureClient(core, core.installation.operatorKey, { webSocketFactory: HeldFeed.into(feeds) });
  await s.step("Load the completed Task and its Asset contact", () => picture.startSynchronization());
  const before = await s.transcript.unrecorded(() => operator.entity(asset.identity.assetId));

  await s.step("A new terminal report commits contact without changing the Task", async () => {
    const newReport = report(s, asset.identity, 2, "completed");
    const confirmed = await asset.client.reportTask(task.id, newReport);
    const contact = await operator.entity(asset.identity.assetId);
    const retried = await asset.client.reportTask(task.id, newReport);
    assert.equal(confirmed.change_sequence, completed.change_sequence);
    assert.equal(confirmed.receipt_sequence, contact.change_sequence);
    assert.ok(retried.receipt_sequence >= confirmed.receipt_sequence);
    assert.ok(confirmed.receipt_sequence > confirmed.change_sequence);
    assert.equal(contact.version, before.version + 1);
    await eventually(() => feeds[0].held.length === 1, "held contact change");
    await assert.rejects(picture.waitForSynchronization(confirmed, 50), (error) => error instanceof PictureError && error.code === "sync_timeout");
    await assert.rejects(picture.waitForSynchronization(retried, 50), (error) => error instanceof PictureError && error.code === "sync_timeout");
    feeds[0].release();
    await picture.waitForSynchronization(confirmed);
    await picture.waitForSynchronization(retried);
    assert.deepEqual(await picture.task(task.id), completed);
    assert.deepEqual(await picture.entity(asset.identity.assetId), contact);
    s.transcript.observe("terminal receipt and Task sequence", [confirmed.receipt_sequence, confirmed.change_sequence]);
  });
});

scenario("A Task change delivered before its response is applied once", async (s) => {
  const core = await s.startCore();
  const asset = await s.step("Enroll the assigned Asset", () => enrollAsset(s, core));
  const operator = s.client(core, core.installation.operatorKey);
  const picture = s.pictureClient(core, core.installation.operatorKey);
  await picture.startSynchronization();
  const observed = [];
  await picture.subscribeFeed((change) => observed.push(change.sequence));
  const submission = await s.step("Prepare Move To", () => operator.prepareMoveTo(asset.identity.assetId, { latitude: 40, longitude: -70 }));
  s.transcript.name(submission.submission_id, "Move To submission");
  const held = new Gate();
  const gatedOperator = new AtlasClient({ baseUrl: core.baseUrl, apiKey: core.installation.operatorKey,
    fetch: gatedFetch((request) => request.method === "POST" && new URL(request.url).pathname === "/tasks", held, s.transcript.fetch),
  });

  await s.step("Core commits a Task while its acceptance response is held", async () => {
    const pending = gatedOperator.submitTask(submission);
    await held.arrived;
    await eventually(async () => (await picture.tasks()).tasks.length === 1, "Task feed application");
    const local = (await picture.tasks()).tasks[0];
    assert.deepEqual(observed, [local.change_sequence]);
    held.open();
    const accepted = await pending;
    s.transcript.name(accepted.id, "Move To task");
    assert.deepEqual(accepted, local);
    await picture.waitForSynchronization(accepted);
    assert.deepEqual(observed, [accepted.change_sequence]);
    s.transcript.observe("Task listener sequences", observed);
  });
});

scenario("Expired Task replay rebuilds the picture without resubmitting Tasks", async (s) => {
  const core = await s.startCore(undefined, { ATLAS_CHANGE_RETENTION: "5" });
  const asset = await s.step("Enroll the assigned Asset", () => enrollAsset(s, core));
  const operator = s.client(core, core.installation.operatorKey);
  const feeds = [];
  const picture = s.pictureClient(core, core.installation.operatorKey, { webSocketFactory: HeldFeed.into(feeds) });
  await picture.startSynchronization();
  const oldCursor = (await picture.queryFull()).baseline;
  const observed = [];
  await picture.subscribeFeed((change) => observed.push(change.resource_id));

  const created = await s.step("Eight Tasks commit while the feed holds them", async () => {
    const tasks = await s.transcript.unrecorded(async () => {
      const tasks = [];
      for (let index = 0; index < 8; index++) {
        const submission = await operator.prepareMoveTo(asset.identity.assetId, { latitude: 40 + index, longitude: -70 });
        tasks.push(await operator.submitTask(submission));
      }
      return tasks;
    });
    await eventually(() => feeds[0].held.length === 8, "eight held Task changes");
    return tasks;
  });

  await s.step("An expired gap rebuilds from authoritative Tasks", async () => {
    feeds[0].release(7);
    await eventually(() => picture.synchronization.generation === 2 && picture.synchronization.state === "ready", "rebuilt Task picture");
    await picture.waitForSynchronization(created.at(-1));
    const local = (await picture.tasks()).tasks;
    assert.deepEqual(local.map((task) => task.id), created.map((task) => task.id));
    assert.deepEqual(local.map((task) => task.acceptance_sequence), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(observed, []);
    await assert.rejects(picture.changedSince(oldCursor), (error) => error instanceof PictureError && error.code === "cursor_expired");
    assert.equal((await operator.tasks()).tasks.length, 8);
    s.transcript.observe("rebuilt Task count and generation", [local.length, picture.synchronization.generation]);
  });
});

scenario("Snapshot Task state is not replayed as a fresh local change", async (s) => {
  const core = await s.startCore();
  const asset = await s.step("Enroll the assigned Asset", () => enrollAsset(s, core));
  const operator = s.client(core, core.installation.operatorKey);
  const submission = await s.step("Prepare Move To", () => operator.prepareMoveTo(asset.identity.assetId, { latitude: 40, longitude: -70 }));
  s.transcript.name(submission.submission_id, "Move To submission");
  const task = await s.step("Create Move To", () => operator.submitTask(submission));
  s.transcript.name(task.id, "Move To task");
  const snapshotHeld = new Gate();
  const picture = s.pictureClient(core, core.installation.operatorKey, {
    snapshotPageSize: 1,
    fetch: gatedFetch((request) => new URL(request.url).pathname === "/queries/full", snapshotHeld),
  });
  const observed = [];
  await picture.subscribeFeed((change) => observed.push(change.resource_type));

  await s.step("A Task completes between snapshot pages", async () => {
    const started = picture.startSynchronization();
    await snapshotHeld.arrived;
    const completed = await asset.client.reportTask(task.id, report(s, asset.identity, 1, "completed"));
    snapshotHeld.open();
    await started;
    assert.deepEqual(await picture.task(task.id), completed);
    assert.deepEqual(observed, ["entity"]);
    const page = await picture.changedSince((await picture.queryFull()).baseline);
    assert.deepEqual(page.changes, []);
    assert.equal(picture.synchronization.sequence, completed.change_sequence);
    s.transcript.observe("replayed local resource types", observed);
  });
});
