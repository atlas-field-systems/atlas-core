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
    await assert.rejects(asset.client.reportTask(task.id, report(s, asset.identity, 1, "acknowledged", { progress_percent: 20 })), (error) => error instanceof AtlasError && error.code === "invalid_request");
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
  await s.step("Protocol rejects incomplete and mixed Task update variants", async () => {
    const requestId = crypto.randomUUID();
    const reportId = crypto.randomUUID();
    s.transcript.name(requestId, "mixed cancellation request");
    s.transcript.name(reportId, "mixed report");
    const before = await operator.entity(asset.identity.assetId);
    for (const [body, credential] of [
      [{ dataset_id: asset.identity.datasetId }, asset.identity.credential],
      [{ dataset_id: asset.identity.datasetId, status: "completed", sequence: 1 }, asset.identity.credential],
      [{ dataset_id: asset.identity.datasetId, report_id: reportId, sequence: 1 }, asset.identity.credential],
      [{ dataset_id: asset.identity.datasetId, status: "cancellation_requested", request_id: requestId, report_id: reportId }, core.installation.operatorKey],
    ]) {
      const response = await s.request(core, `/tasks/${task.id}/status`, { method: "PATCH", credential, body });
      assert.equal(response.status, 400);
      assert.equal(response.body.code, "invalid_request");
    }
    await s.transcript.unrecorded(async () => {
      for (const body of [
        { dataset_id: asset.identity.datasetId, status: "failed", report_id: reportId, sequence: 1 },
        { dataset_id: asset.identity.datasetId, status: "cancelled", report_id: reportId, sequence: 1 },
        { dataset_id: asset.identity.datasetId, status: "completed", report_id: reportId, sequence: 1, failure_reason: "contradictory" },
        { dataset_id: asset.identity.datasetId, status: "acknowledged", report_id: reportId, sequence: 1, progress_percent: 20 },
      ]) {
        const response = await s.request(core, `/tasks/${task.id}/status`, { method: "PATCH", credential: asset.identity.credential, body });
        assert.equal(response.status, 400);
        assert.equal(response.body.code, "invalid_request");
      }
    });
    assert.deepEqual(await operator.task(task.id), task);
    assert.deepEqual(await operator.entity(asset.identity.assetId), before);
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
    const changes = (await picture.changedSince(baseline)).changes;
    assert.deepEqual(changes.map((change) => change.sequence), [one.change_sequence, two.change_sequence]);
    assert.ok(changes.every((change) => change.resource_type === "task" && !("entity" in change)));
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

scenario("Offline Asset work and current Task intent reconcile without a second execution", async (s) => {
  const installation = await s.installation();
  let core = await s.startCore(installation);
  const first = await s.step("Enroll the first Asset", () => enrollAsset(s, core));
  const second = await s.step("Enroll another Asset", () => enrollAsset(s, core, { alias: "Other", command_manifest: [{ command_id: "move_to", scheduling: ["queued"], cancellation: true, progress: true }] }, "other"));
  let operator = s.client(core, installation.operatorKey);
  let connected = true;
  const assetLink = new AtlasClient({
    baseUrl: core.baseUrl,
    apiKey: first.identity.credential,
    fetch: (input, init) => connected ? s.transcript.fetch(input, init) : Promise.reject(new Error("Asset link disconnected")),
  });
  const issued = [];
  for (const [index, destination] of [{ latitude: 40, longitude: -70 }, { latitude: 41, longitude: -71 }].entries()) {
    const submission = await s.step(`Prepare queued Task ${index + 1}`, async () => {
      const prepared = await operator.prepareMoveTo(first.identity.assetId, destination);
      s.transcript.name(prepared.submission_id, `submission ${index + 1}`);
      return prepared;
    });
    const task = await s.step(`Issue queued Task ${index + 1}`, () => operator.submitTask(submission));
    s.transcript.name(task.id, `Task ${index + 1}`);
    issued.push(task);
  }
  const otherSubmission = await s.step("Prepare independent work", async () => {
    const prepared = await operator.prepareMoveTo(second.identity.assetId, { latitude: 30, longitude: -60 });
    s.transcript.name(prepared.submission_id, "other submission");
    return prepared;
  });
  const otherTask = await s.step("Assign independent work to the other Asset", () => operator.submitTask(otherSubmission));
  s.transcript.name(otherTask.id, "other Task");

  await s.step("The first Asset reports busy before losing contact", async () => {
    const reportId = crypto.randomUUID();
    s.transcript.name(reportId, "busy report");
    const busy = await assetLink.reportAssetStatus(first.identity.assetId, {
      datasetId: first.identity.datasetId,
      reportId,
      sequence: 1,
      status: "busy",
    });
    assert.equal(busy.components.status.value, "busy");
  });

  const onboard = await s.step("The first Asset reads work without acknowledging it", async () => {
    const page = await assetLink.assignedTasks(first.identity.assetId, { limit: 1 });
    assert.deepEqual(page.tasks.map((task) => task.id), [issued[0].id]);
    assert.ok(page.next_cursor);
    assert.equal((await operator.task(issued[0].id)).status, "pending");
    return [page.tasks[0].id];
  });
  const physicalExecutions = [];
  await s.step("The link drops Asset requests while onboard work finishes", async () => {
    connected = false;
    await assert.rejects(assetLink.assignedTasks(first.identity.assetId), /Asset link disconnected/);
    physicalExecutions.push(onboard[0]);
  });
  const cancellationId = crypto.randomUUID();
  s.transcript.name(cancellationId, "offline cancellation");
  await s.step("The operator cancels unseen work and issues more while the Asset is offline", async () => {
    const requested = await operator.cancelTask(issued[1].id, first.identity.datasetId, cancellationId);
    assert.equal(requested.status, "cancellation_requested");
    assert.equal(requested.cancellation_request_id, cancellationId);
    const submission = await operator.prepareMoveTo(first.identity.assetId, { latitude: 42, longitude: -72 });
    s.transcript.name(submission.submission_id, "submission 3");
    const task = await operator.submitTask(submission);
    s.transcript.name(task.id, "Task 3");
    issued.push(task);
    assert.deepEqual(issued.map((item) => item.acceptance_sequence), [1, 2, 3]);
    await assert.rejects(assetLink.assignedTasks(first.identity.assetId), /Asset link disconnected/);
  });

  await s.step("Core Restart retains intent without inventing an Asset outcome", async () => {
    await core.stop();
    core = await s.startCore(installation);
    operator = s.client(core, installation.operatorKey);
    assert.deepEqual((await operator.tasks()).tasks.map((task) => task.status), ["pending", "cancellation_requested", "pending", "pending"]);
    assert.equal((await operator.task(issued[1].id)).cancellation_request_id, cancellationId);
  });

  const assigned = await s.step("Reconnection reads every assigned page in immutable order", async () => {
    const assetClient = s.client(core, first.identity.credential);
    const tasks = [];
    let cursor;
    do {
      const page = await assetClient.assignedTasks(first.identity.assetId, { limit: 1, cursor });
      tasks.push(...page.tasks);
      cursor = page.next_cursor;
    } while (cursor);
    assert.deepEqual(tasks.map((task) => task.id), issued.map((task) => task.id));
    assert.deepEqual(tasks.map((task) => task.status), ["pending", "cancellation_requested", "pending"]);
    assert.deepEqual((await assetClient.assignedTasks(second.identity.assetId)).tasks.map((task) => task.id), [otherTask.id]);
    return tasks;
  });

  await s.step("The Asset reports actual work, confirms cancellation and executes only new work", async () => {
    const assetClient = s.client(core, first.identity.credential);
    await assert.rejects(s.client(core, second.identity.credential).reportTask(issued[0].id, report(s, second.identity, 1, "completed")), (error) => error instanceof AtlasError && error.status === 403);
    const completed = await assetClient.reportTask(assigned[0].id, report(s, first.identity, 2, "completed"));
    assert.equal(completed.status, "completed");
    const cancelled = await assetClient.reportTask(assigned[1].id, report(s, first.identity, 3, "cancelled", { cancellation_request_id: cancellationId }));
    assert.equal(cancelled.status, "cancelled");
    physicalExecutions.push(assigned[2].id);
    const last = await assetClient.reportTask(assigned[2].id, report(s, first.identity, 4, "completed"));
    assert.equal(last.status, "completed");
    assert.deepEqual(physicalExecutions, [issued[0].id, issued[2].id]);
    assert.deepEqual((await assetClient.assignedTasks(first.identity.assetId)).tasks.map((task) => task.status), ["completed", "cancelled", "completed"]);
    assert.equal((await operator.task(otherTask.id)).status, "pending");
    const picture = s.pictureClient(core, installation.operatorKey);
    await picture.startSynchronization();
    assert.deepEqual((await picture.assignedTasks(first.identity.assetId)).tasks.map((task) => task.status), ["completed", "cancelled", "completed"]);
    await picture.waitForSynchronization(last);
  });
});

scenario("Cancellation and terminal races retain the Asset's actual outcome", async (s) => {
  const core = await s.startCore();
  const asset = await s.step("Enroll the assigned Asset", () => enrollAsset(s, core));
  const other = await s.step("Enroll another authenticated Asset", () => enrollAsset(s, core, { alias: "Other", command_manifest: [{ command_id: "move_to", scheduling: ["queued"], cancellation: true, progress: true }] }, "other"));
  const operator = s.client(core, core.installation.operatorKey);
  const picture = s.pictureClient(core, core.installation.operatorKey);
  await s.step("Synchronize before offline requests", () => picture.startSynchronization());
  const tasks = [];
  for (const [index, latitude] of [40, 41, 42].entries()) {
    const task = await s.step(`Create Task ${index + 1} without Asset acknowledgement`, async () => {
      const submission = await operator.prepareMoveTo(asset.identity.assetId, { latitude, longitude: -70 });
      s.transcript.name(submission.submission_id, `submission ${index + 1}`);
      const created = await operator.submitTask(submission);
      s.transcript.name(created.id, `Task ${index + 1}`);
      return created;
    });
    tasks.push(task);
  }
  const cancellationIds = Array.from({ length: 3 }, () => crypto.randomUUID());
  cancellationIds.forEach((id, index) => s.transcript.name(id, `cancellation ${index + 1}`));

  await s.step("Cancellation commits before acknowledgement and late execution facts cannot clear it", async () => {
    const losing = s.clientLosingFirstResponse(core, core.installation.operatorKey, "PATCH");
    await assert.rejects(losing.cancelTask(tasks[0].id, asset.identity.datasetId, cancellationIds[0]), /response lost/);
    const cancelled = await operator.cancelTask(tasks[0].id, asset.identity.datasetId, cancellationIds[0]);
    assert.equal(cancelled.status, "cancellation_requested");
    assert.equal(cancelled.cancellation_request_id, cancellationIds[0]);
    assert.equal((await operator.cancelTask(tasks[0].id, asset.identity.datasetId, cancellationIds[0])).change_sequence, cancelled.change_sequence);
    const acknowledged = await asset.client.reportTask(tasks[0].id, report(s, asset.identity, 1, "acknowledged"));
    assert.equal(acknowledged.status, "cancellation_requested");
    assert.equal(acknowledged.execution_status, "acknowledged");
    const progressed = report(s, asset.identity, 2, undefined, { progress_percent: 35 });
    delete progressed.status;
    const updated = await asset.client.reportTask(tasks[0].id, progressed);
    assert.equal(updated.status, "cancellation_requested");
    assert.equal(updated.progress_percent, 35);
    const started = await asset.client.reportTask(tasks[0].id, report(s, asset.identity, 3, "in_progress"));
    assert.equal(started.status, "cancellation_requested");
    assert.equal(started.execution_status, "in_progress");
    await assert.rejects(asset.client.reportTask(tasks[0].id, report(s, asset.identity, 4, "acknowledged")), (error) => error instanceof AtlasError && error.code === "task_transition_conflict");
    await picture.waitForSynchronization(started);
    assert.deepEqual(await picture.task(tasks[0].id), started);
  });

  await s.step("Direct Protocol completion wins and matching reports have no Task effect", async () => {
    const completedReport = report(s, asset.identity, 4, "completed", { progress_percent: 100 });
    const response = await s.request(core, `/tasks/${tasks[0].id}/status`, { method: "PATCH", credential: asset.identity.credential, body: completedReport });
    assert.equal(response.status, 200);
    assert.equal(response.body.status, "completed");
    assert.equal(response.body.cancellation_request_id, cancellationIds[0]);
    assert.equal(response.body.execution_status, "in_progress");
    const matching = await asset.client.reportTask(tasks[0].id, report(s, asset.identity, 5, "completed", { progress_percent: 100 }));
    assert.equal(matching.change_sequence, response.body.change_sequence);
    assert.deepEqual(await operator.task(tasks[0].id), response.body);
    await picture.waitForSynchronization(response.body);
    assert.equal((await picture.task(tasks[0].id)).execution_status, "in_progress");
    await assert.rejects(asset.client.reportTask(tasks[0].id, report(s, asset.identity, 6, "cancelled", { cancellation_request_id: cancellationIds[0] })), (error) => error instanceof AtlasError && error.code === "task_transition_conflict");
  });

  await s.step("Direct Protocol cancellation is visible through SDK reads and failure wins", async () => {
    const request = { dataset_id: asset.identity.datasetId, status: "cancellation_requested", request_id: cancellationIds[1] };
    const response = await s.request(core, `/tasks/${tasks[1].id}/status`, { method: "PATCH", credential: core.installation.operatorKey, body: request });
    assert.equal(response.status, 200);
    assert.equal(response.body.status, "cancellation_requested");
    assert.deepEqual(await operator.task(tasks[1].id), response.body);
    const failedReport = report(s, asset.identity, 6, "failed", { failure_reason: "route obstructed" });
    const failed = await asset.client.reportTask(tasks[1].id, failedReport);
    assert.equal(failed.status, "failed");
    assert.equal(failed.failure_reason, "route obstructed");
    assert.equal(failed.cancellation_request_id, cancellationIds[1]);
    assert.equal(failed.execution_status, undefined);
    assert.equal((await asset.client.reportTask(tasks[1].id, failedReport)).change_sequence, failed.change_sequence);
    const matched = await asset.client.reportTask(tasks[1].id, report(s, asset.identity, 7, "failed", { failure_reason: "route obstructed" }));
    assert.equal(matched.change_sequence, failed.change_sequence);
    await assert.rejects(asset.client.reportTask(tasks[1].id, report(s, asset.identity, 8, "completed")), (error) => error instanceof AtlasError && error.code === "task_transition_conflict");
  });

  await s.step("Only the assigned Asset can confirm the exact cancellation request", async () => {
    const requested = await operator.cancelTask(tasks[2].id, asset.identity.datasetId, cancellationIds[2]);
    assert.equal(requested.status, "cancellation_requested");
    const wrong = crypto.randomUUID();
    s.transcript.name(wrong, "wrong cancellation");
    await assert.rejects(asset.client.reportTask(tasks[2].id, report(s, asset.identity, 8, "cancelled", { cancellation_request_id: wrong })), (error) => error instanceof AtlasError && error.code === "task_transition_conflict");
    await assert.rejects(other.client.reportTask(tasks[2].id, report(s, other.identity, 1, "cancelled", { cancellation_request_id: cancellationIds[2] })), (error) => error instanceof AtlasError && error.status === 403);
    const confirmation = report(s, asset.identity, 8, "cancelled", { cancellation_request_id: cancellationIds[2] });
    const confirmed = await asset.client.reportTask(tasks[2].id, confirmation);
    assert.equal(confirmed.status, "cancelled");
    assert.equal((await asset.client.reportTask(tasks[2].id, confirmation)).change_sequence, confirmed.change_sequence);
    await assert.rejects(asset.client.reportTask(tasks[2].id, report(s, asset.identity, 9, "failed", { failure_reason: "conflicting outcome" })), (error) => error instanceof AtlasError && error.code === "task_transition_conflict");
    await picture.waitForSynchronization(confirmed);
    assert.deepEqual((await picture.assignedTasks(asset.identity.assetId)).tasks.map((task) => task.status), ["completed", "failed", "cancelled"]);
    const deletion = await s.request(core, `/tasks/${tasks[2].id}`, { method: "DELETE", credential: core.installation.operatorKey });
    assert.ok([404, 405].includes(deletion.status));
    assert.equal((await operator.task(tasks[2].id)).status, "cancelled");
  });
});
