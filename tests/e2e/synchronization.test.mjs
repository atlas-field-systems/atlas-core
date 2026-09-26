import assert from "node:assert/strict";

import { AtlasError, PictureError } from "../../sdk/dist/index.js";
import { enrollAsset } from "./harness/assets.mjs";
import { Gate, HeldFeed, eventually, gatedFetch } from "./harness/barriers.mjs";
import { scenario } from "./harness/scenario.mjs";

const pictureError = (code) => (error) => error instanceof PictureError && error.code === code;
const isSnapshot = (request) => new URL(request.url).pathname === "/queries/full";

/** Check-in reports for one Asset, numbered from `from`. */
function checkIns(s, identity, from, count) {
  return Array.from({ length: count }, (_, index) => {
    const reportId = crypto.randomUUID();
    s.transcript.name(reportId, `check-in ${from + index}`);
    return { datasetId: identity.datasetId, reportId, sequence: from + index };
  });
}

function observeStatus(s, client) {
  const { state, sequence, generation } = client.synchronization;
  s.transcript.observe("synchronization", { state, sequence, generation });
}

scenario("A Task receipt waits while the initial picture loads", async (s) => {
  const core = await s.startCore();
  const asset = await s.step("Enroll an Asset", () => enrollAsset(s, core));
  const operator = s.client(core, core.installation.operatorKey);
  const task = await s.step("Create a Task before the picture starts", async () => {
    const submission = await operator.prepareMoveTo(asset.identity.assetId, { latitude: 40, longitude: -70 });
    s.transcript.name(submission.submission_id, "Move To submission");
    const created = await operator.submitTask(submission);
    s.transcript.name(created.id, "Move To task");
    return created;
  });
  const snapshotHeld = new Gate();
  const picture = s.pictureClient(core, core.installation.operatorKey, { fetch: gatedFetch(isSnapshot, snapshotHeld) });
  s.context.after(() => picture.stopSynchronization());

  await s.step("The wait remains pending until the picture has a Dataset", async () => {
    const started = picture.startSynchronization();
    await snapshotHeld.arrived;
    const wait = picture.waitForSynchronization(task);
    const before = await Promise.race([
      wait.then(() => "resolved", () => "rejected"),
      new Promise((resolve) => setImmediate(() => resolve("pending"))),
    ]);
    assert.equal(before, "pending");
    snapshotHeld.open();
    await Promise.all([started, wait]);
    assert.deepEqual(await picture.task(task.id), task);
    s.transcript.observe("Task receipt after initial load", { before, state: picture.synchronization.state });
  });
});

scenario("Snapshot pages share one baseline while writes continue", async (s) => {
  const core = await s.startCore();
  const operator = s.client(core, core.installation.operatorKey);
  await s.step("Enroll Alpha and Bravo", async () => {
    await enrollAsset(s, core, { alias: "Alpha" }, "alpha");
    await enrollAsset(s, core, { alias: "Bravo" }, "bravo");
  });

  await s.step("Page through a snapshot while Charlie enrolls between pages", async () => {
    const { first, second, charlie, replay } = await s.transcript.unrecorded(async () => {
      const first = await operator.queryFull(undefined, 1);
      const charlie = await enrollAsset(s, core, { alias: "Charlie" }, "charlie");
      const second = await operator.queryFull(first.next_cursor, 1);
      const replay = await operator.changedSince(first.baseline);
      return { first, second, charlie, replay };
    });
    const aliases = [...first.entities, ...second.entities].map((entity) => entity.alias).sort();
    s.transcript.observe("snapshot aliases, sorted", aliases);
    s.transcript.observe("pages share a baseline", second.baseline === first.baseline);
    s.transcript.observe("replay from the baseline", replay.changes.map((change) => ({ sequence: change.sequence, kind: change.kind, alias: change.entity.alias })));
    assert.deepEqual(aliases, ["Alpha", "Bravo"]);
    assert.equal(second.baseline, first.baseline);
    assert.deepEqual(replay.changes.map((change) => change.resource_id), [charlie.identity.assetId]);
    assert.equal(replay.changes[0].resource_type, "entity");
    assert.equal("task" in replay.changes[0], false);
  });
});

scenario("A full picture loads during writes and then follows committed changes", async (s) => {
  const core = await s.startCore();
  const operatorKey = core.installation.operatorKey;
  const alpha = await s.step("Enroll Alpha, Bravo and Charlie", async () => {
    const enrolled = await enrollAsset(s, core, { alias: "Alpha" }, "alpha");
    await enrollAsset(s, core, { alias: "Bravo" }, "bravo");
    await enrollAsset(s, core, { alias: "Charlie" }, "charlie");
    return enrolled;
  });
  const snapshotHeld = new Gate();
  const picture = s.pictureClient(core, operatorKey, { snapshotPageSize: 1, fetch: gatedFetch(isSnapshot, snapshotHeld) });

  await s.step("Local reads are refused before synchronization", async () => {
    await assert.rejects(picture.entity(alpha.identity.assetId), pictureError("not_ready"));
  });

  await s.step("Delta enrolls while the first snapshot page is in flight", async () => {
    const started = picture.startSynchronization();
    await snapshotHeld.arrived;
    await enrollAsset(s, core, { alias: "Delta" }, "delta");
    snapshotHeld.open();
    await started;
    observeStatus(s, picture);
    const aliases = (await picture.queryFull(undefined, 100)).entities.map((entity) => entity.alias).sort();
    s.transcript.observe("local aliases, sorted", aliases);
    assert.deepEqual(aliases, ["Alpha", "Bravo", "Charlie", "Delta"]);
  });

  const localBaseline = (await picture.queryFull()).baseline;
  const committed = await s.step("An Asset check-in is applied locally", async () => {
    const [report] = checkIns(s, alpha.identity, 1, 1);
    const entity = await alpha.client.checkInAsset(alpha.identity.assetId, { ...report, components: { telemetry: { speed_mps: 4 } } });
    await picture.waitForSynchronization(entity);
    assert.deepEqual(await picture.entity(alpha.identity.assetId), entity);
    return entity;
  });

  await s.step("Local history and status reads match Core", async () => {
    const local = await picture.changedSince(localBaseline);
    s.transcript.observe("local changes since the baseline", local.changes.map((change) => change.sequence));
    assert.deepEqual(local.changes.map((change) => change.sequence), [committed.change_sequence]);
    assert.deepEqual(await picture.assetStatus(alpha.identity.assetId), await s.client(core, operatorKey).assetStatus(alpha.identity.assetId));
  });

  await s.step("Core rejects a local cursor", async () => {
    await assert.rejects(s.client(core, operatorKey).changedSince(localBaseline), (error) => error instanceof AtlasError && error.status === 400);
  });

  await s.step("Waiting on a write from another Dataset fails", async () => {
    await assert.rejects(picture.waitForSynchronization({ ...committed, dataset_id: crypto.randomUUID() }), pictureError("dataset_changed"));
  });
});

scenario("The picture applies changes in commit order when the feed reorders them", async (s) => {
  const core = await s.startCore();
  const alpha = await s.step("Enroll Alpha", () => enrollAsset(s, core, { alias: "Alpha" }, "alpha"));
  const feeds = [];
  const picture = s.pictureClient(core, core.installation.operatorKey, { webSocketFactory: HeldFeed.into(feeds) });
  const seen = [];
  await s.step("Synchronize and listen for local changes", async () => {
    await picture.startSynchronization();
    await picture.subscribeFeed((change) => seen.push(change.sequence));
  });

  const [first, second] = await s.step("Alpha checks in twice; the feed holds both changes", async () => {
    const results = [];
    for (const report of checkIns(s, alpha.identity, 1, 2)) results.push(await alpha.client.checkInAsset(alpha.identity.assetId, report));
    await eventually(() => feeds[0].held.length === 2, "both changes held");
    await assert.rejects(picture.waitForSynchronization(results[0], 100), pictureError("sync_timeout"));
    return results;
  });

  await s.step("Delivering the second change first still applies both in order", async () => {
    feeds[0].release(1);
    await picture.waitForSynchronization(second);
    feeds[0].release(0);
    s.transcript.observe("local listener sequences", seen);
    assert.deepEqual(seen, [first.change_sequence, second.change_sequence]);
    assert.deepEqual(await picture.entity(alpha.identity.assetId), second);
  });
});

scenario("The picture recovers after its feed disconnects", async (s) => {
  const core = await s.startCore();
  const alpha = await s.step("Enroll Alpha", () => enrollAsset(s, core, { alias: "Alpha" }, "alpha"));
  const sockets = [];
  const picture = s.pictureClient(core, core.installation.operatorKey, {
    webSocketFactory: (url) => { const socket = new WebSocket(url); sockets.push(socket); return socket; },
  });
  await s.step("Synchronize", () => picture.startSynchronization());

  await s.step("The feed connection drops and the picture turns stale", async () => {
    sockets[0].close();
    await eventually(() => picture.synchronization.state === "stale", "a stale picture");
    await assert.rejects(picture.entity(alpha.identity.assetId), pictureError("stale"));
  });

  await s.step("A write during the outage is applied after reconnecting", async () => {
    const [report] = checkIns(s, alpha.identity, 1, 1);
    const written = await alpha.client.checkInAsset(alpha.identity.assetId, report);
    await picture.waitForSynchronization(written);
    assert.deepEqual(await picture.entity(alpha.identity.assetId), written);
    s.transcript.observe("feed connections opened", sockets.length >= 2);
  });
});

scenario("A malformed feed message is not applied and the picture recovers", async (s) => {
  const core = await s.startCore();
  const alpha = await s.step("Enroll Alpha", () => enrollAsset(s, core, { alias: "Alpha" }, "alpha"));
  const feeds = [];
  const picture = s.pictureClient(core, core.installation.operatorKey, { webSocketFactory: HeldFeed.into(feeds) });
  const before = await s.step("Synchronize", async () => {
    await picture.startSynchronization();
    return picture.entity(alpha.identity.assetId);
  });

  await s.step("A change without a sequence arrives", async () => {
    const malformed = { type: "change", cursor: "invalid", change: { resource_id: alpha.identity.assetId, entity: { ...before, alias: "Forged" } } };
    feeds[0].dispatchEvent(new MessageEvent("message", { data: JSON.stringify(malformed) }));
    await eventually(() => feeds.length === 2 && picture.synchronization.state === "ready", "a reconnected picture");
    assert.deepEqual(await picture.entity(alpha.identity.assetId), before);
  });
});

scenario("An expired replay cursor makes the picture rebuild", async (s) => {
  const core = await s.startCore(undefined, { ATLAS_CHANGE_RETENTION: "5" });
  const operator = s.client(core, core.installation.operatorKey);
  const alpha = await s.step("Enroll Alpha with a change log that retains five changes", () => enrollAsset(s, core, { alias: "Alpha" }, "alpha"));
  const feeds = [];
  const picture = s.pictureClient(core, core.installation.operatorKey, { webSocketFactory: HeldFeed.into(feeds) });
  const { oldBaseline, oldLocalCursor } = await s.step("Synchronize and note the current cursors", async () => {
    await picture.startSynchronization();
    observeStatus(s, picture);
    const oldBaseline = (await s.transcript.unrecorded(() => operator.queryFull())).baseline;
    return { oldBaseline, oldLocalCursor: (await picture.queryFull()).baseline };
  });

  const last = await s.step("Eight check-ins commit while the feed holds them", async () => {
    let written;
    for (const report of checkIns(s, alpha.identity, 1, 8)) written = await alpha.client.checkInAsset(alpha.identity.assetId, report);
    await eventually(() => feeds[0].held.length === 8, "eight held changes");
    return written;
  });

  await s.step("Delivering the newest change leaves a gap replay cannot fill, so the picture rebuilds", async () => {
    feeds[0].release(7);
    await eventually(() => picture.synchronization.generation === 2 && picture.synchronization.state === "ready", "a rebuilt picture");
    await picture.waitForSynchronization(last);
    observeStatus(s, picture);
    assert.deepEqual(await picture.entity(alpha.identity.assetId), last);
  });

  await s.step("Old cursors are expired in Core and in the picture", async () => {
    await assert.rejects(operator.changedSince(oldBaseline), (error) => error instanceof AtlasError && error.status === 410 && error.code === "cursor_expired");
    await assert.rejects(picture.changedSince(oldLocalCursor), pictureError("cursor_expired"));
  });
});

scenario("Initial loading rebuilds when replay expires before it finishes", async (s) => {
  const core = await s.startCore(undefined, { ATLAS_CHANGE_RETENTION: "5" });
  const alpha = await s.step("Enroll Alpha with a change log that retains five changes", () => enrollAsset(s, core, { alias: "Alpha" }, "alpha"));
  const snapshotHeld = new Gate();
  const picture = s.pictureClient(core, core.installation.operatorKey, { fetch: gatedFetch(isSnapshot, snapshotHeld) });

  await s.step("Eight check-ins commit while the first snapshot is in flight", async () => {
    const started = picture.startSynchronization();
    await snapshotHeld.arrived;
    let last;
    for (const report of checkIns(s, alpha.identity, 1, 8)) last = await alpha.client.checkInAsset(alpha.identity.assetId, report);
    snapshotHeld.open();
    await started;
    observeStatus(s, picture);
    assert.equal(picture.synchronization.generation, 2);
    assert.deepEqual(await picture.entity(alpha.identity.assetId), last);
  });
});

scenario("Stopping during initial loading rejects the pending start", async (s) => {
  const core = await s.startCore();
  const alpha = await s.step("Enroll Alpha", () => enrollAsset(s, core, { alias: "Alpha" }, "alpha"));
  const snapshotHeld = new Gate();
  const picture = s.pictureClient(core, core.installation.operatorKey, { fetch: gatedFetch(isSnapshot, snapshotHeld) });

  await s.step("Stop while the first snapshot is in flight, then start again", async () => {
    const abandoned = picture.startSynchronization();
    abandoned.catch(() => {});
    await snapshotHeld.arrived;
    picture.stopSynchronization();
    assert.equal(picture.synchronization.state, "stopped");
    await picture.startSynchronization();
    snapshotHeld.open();
    await assert.rejects(abandoned, pictureError("stopped"));
    observeStatus(s, picture);
    assert.equal(picture.synchronization.state, "ready");
    assert.equal((await picture.entity(alpha.identity.assetId)).alias, "Alpha");
  });
});

scenario("A picture beyond its Entity limit fails explicitly", async (s) => {
  const core = await s.startCore();
  await s.step("Enroll Alpha and Bravo", async () => {
    await enrollAsset(s, core, { alias: "Alpha" }, "alpha");
    await enrollAsset(s, core, { alias: "Bravo" }, "bravo");
  });

  await s.step("A picture limited to one Entity fails to start", async () => {
    const picture = s.pictureClient(core, core.installation.operatorKey, { maxEntities: 1 });
    await assert.rejects(picture.startSynchronization(), pictureError("resource_limit"));
    observeStatus(s, picture);
    assert.equal(picture.synchronization.state, "failed");
  });
});

scenario("An HTTP-mode client can follow the feed", async (s) => {
  const core = await s.startCore();
  const alpha = await s.step("Enroll Alpha", () => enrollAsset(s, core, { alias: "Alpha" }, "alpha"));
  const received = [];
  const unsubscribe = await s.step("Subscribe without synchronizing", () =>
    s.client(core, core.installation.operatorKey).subscribeFeed((change) => received.push(change)));

  await s.step("A check-in arrives as a change", async () => {
    const [report] = checkIns(s, alpha.identity, 1, 1);
    const written = await alpha.client.checkInAsset(alpha.identity.assetId, report);
    await eventually(() => received.length === 1, "the change");
    unsubscribe();
    s.transcript.observe("received change", { sequence: received[0].sequence, kind: received[0].kind, resource_id: received[0].resource_id });
    assert.deepEqual(received[0].entity, written);
  });
});

scenario("The enrollment authority cannot follow the feed", async (s) => {
  const core = await s.startCore();
  const open = (apiKey) => new Promise((resolve) => {
    const socket = new WebSocket(new URL("/feed", core.baseUrl.replace("http", "ws")));
    socket.addEventListener("open", () => socket.send(JSON.stringify({ api_key: apiKey })));
    socket.addEventListener("message", (event) => { resolve({ first: JSON.parse(event.data).type }); socket.close(); });
    socket.addEventListener("close", (event) => resolve({ closed: event.code }));
  });

  await s.step("The enrollment authority is closed with a policy violation", async () => {
    const outcome = await open(core.installation.enrollmentKey);
    s.transcript.observe("enrollment authority outcome", outcome);
    assert.deepEqual(outcome, { closed: 1008 });
  });

  await s.step("An operator receives the hello", async () => {
    const outcome = await open(core.installation.operatorKey);
    s.transcript.observe("operator outcome", outcome);
    assert.deepEqual(outcome, { first: "hello" });
  });
});

scenario("Reports and the change log survive Restart", async (s) => {
  const installation = await s.installation();
  let core = await s.startCore(installation);
  const alpha = await s.step("Enroll Alpha", () => enrollAsset(s, core, { alias: "Alpha" }, "alpha"));
  const baseline = (await s.step("Take a snapshot", () => s.client(core, installation.operatorKey).queryFull())).baseline;
  const written = await s.step("Alpha checks in twice", async () => {
    let last;
    for (const report of checkIns(s, alpha.identity, 1, 2)) last = await alpha.client.checkInAsset(alpha.identity.assetId, report);
    return last;
  });

  await s.step("Restart Core", async () => {
    await core.stop();
    core = await s.startCore(installation);
  });

  await s.step("State, report order and replay are retained", async () => {
    assert.deepEqual(await s.client(core, alpha.identity.credential).entity(alpha.identity.assetId), written);
    const [stale] = checkIns(s, alpha.identity, 2, 1);
    await assert.rejects(s.client(core, alpha.identity.credential).checkInAsset(alpha.identity.assetId, stale), (error) => error instanceof AtlasError && error.code === "report_out_of_order");
    const replay = await s.client(core, installation.operatorKey).changedSince(baseline);
    assert.deepEqual(replay.changes.map((change) => change.sequence), [2, 3]);
  });
});
