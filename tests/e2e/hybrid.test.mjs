import assert from "node:assert/strict";

import { AtlasClient, PictureError } from "../../sdk/dist/index.js";
import { enrollAsset } from "./harness/assets.mjs";
import { Gate, eventually, gatedFetch } from "./harness/barriers.mjs";
import { scenario } from "./harness/scenario.mjs";

scenario("An Asset hybrid picture transmits only its Entity and assigned Tasks", async (s) => {
  const core = await s.startCore(undefined, { ATLAS_CHANGE_RETENTION: "5" });
  const alpha = await s.step("Enroll Alpha", () => enrollAsset(s, core, { alias: "Alpha", command_manifest: [{ command_id: "move_to", scheduling: ["queued"], cancellation: true, progress: true }] }, "alpha"));
  const beta = await s.step("Enroll Beta", () => enrollAsset(s, core, { alias: "Beta", command_manifest: [{ command_id: "move_to", scheduling: ["queued"], cancellation: true, progress: true }] }, "beta"));
  const operator = s.client(core, core.installation.operatorKey);
  const scopedPayloads = [];
  const feedPayloads = [];
  const hybrid = new AtlasClient({
    baseUrl: core.baseUrl,
    apiKey: alpha.identity.credential,
    mode: "hybrid",
    assetId: alpha.identity.assetId,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const scoped = url.searchParams.get("scope") === "asset";
      const response = scoped ? await fetch(request) : await s.transcript.fetch(request);
      if (scoped) scopedPayloads.push({ path: url.pathname, body: await response.clone().text() });
      return response;
    },
    webSocketFactory: (url) => {
      const socket = new WebSocket(url);
      socket.addEventListener("message", (event) => feedPayloads.push(String(event.data)));
      return socket;
    },
  });
  s.context.after(() => hybrid.stopSynchronization());

  await s.step("Reject an empty hybrid Asset ID", () => {
    assert.throws(() => new AtlasClient({ baseUrl: core.baseUrl, apiKey: alpha.identity.credential, mode: "hybrid", assetId: "" }),
      (error) => error instanceof PictureError && error.code === "invalid_asset_id");
  });

  await s.step("Load the Asset subset and disclose coverage", async () => {
    await assert.rejects(hybrid.entity(alpha.identity.assetId), (error) => error instanceof PictureError && error.code === "not_ready");
    await hybrid.startSynchronization();
    const local = await hybrid.queryFull();
    assert.equal(local.coverage.scope, "asset");
    assert.equal(local.coverage.asset_id, alpha.identity.assetId);
    assert.deepEqual(local.entities.map((entity) => entity.id), [alpha.identity.assetId]);
    assert.deepEqual(local.tasks, []);
    s.transcript.observe("local coverage and Entity count", { coverage: local.coverage.scope, entities: local.entities.length });
  });

  await s.step("One-off unrelated reads do not enter the local feed", async () => {
    const events = [];
    await hybrid.subscribeFeed((change) => events.push(change.resource_id));
    assert.equal((await hybrid.entity(beta.identity.assetId)).id, beta.identity.assetId);
    assert.equal((await hybrid.assignedTasks(beta.identity.assetId)).tasks.length, 0);
    assert.deepEqual(events, []);
    s.transcript.observe("unrelated Asset read and local events", { id: beta.identity.assetId, events: events.length });
  });

  const [ownTask, unrelatedTask] = await s.step("Create one Task for each Asset", async () => {
    const ownSubmission = await operator.prepareMoveTo(alpha.identity.assetId, { latitude: 40, longitude: -70 });
    const unrelatedSubmission = await operator.prepareMoveTo(beta.identity.assetId, { latitude: 41, longitude: -71 });
    s.transcript.name(ownSubmission.submission_id, "own submission");
    s.transcript.name(unrelatedSubmission.submission_id, "unrelated submission");
    const ownTask = await operator.submitTask(ownSubmission);
    const unrelatedTask = await operator.submitTask(unrelatedSubmission);
    s.transcript.name(ownTask.id, "own Task");
    s.transcript.name(unrelatedTask.id, "unrelated Task");
    return [ownTask, unrelatedTask];
  });

  await s.step("The Task arrives locally; an unrelated Task is a one-off read", async () => {
    await hybrid.waitForSynchronization(ownTask);
    assert.deepEqual(await hybrid.task(ownTask.id), ownTask);
    await assert.rejects(hybrid.waitForSynchronization(unrelatedTask), (error) => error instanceof PictureError && error.code === "out_of_scope");
    assert.deepEqual(await hybrid.task(unrelatedTask.id, { scope: "full" }), unrelatedTask);
    assert.deepEqual((await hybrid.tasks()).tasks.map((task) => task.id), [ownTask.id]);
    assert.equal((await hybrid.tasks()).coverage.asset_id, alpha.identity.assetId);
    assert.equal((await hybrid.assignedTasks(beta.identity.assetId)).coverage.asset_id, beta.identity.assetId);
    const fullTasks = await hybrid.tasks({ scope: "full" });
    assert.equal(fullTasks.coverage.scope, "full");
    assert.equal(fullTasks.tasks.length, 2);
    s.transcript.observe("local and full Task counts", { local: (await hybrid.tasks()).tasks.length, full: fullTasks.tasks.length });
  });

  await s.step("Cancellation intent and the later outcome remain in scope", async () => {
    const cancellationId = crypto.randomUUID();
    s.transcript.name(cancellationId, "cancellation request");
    const cancelled = await operator.cancelTask(ownTask.id, alpha.identity.datasetId, cancellationId);
    await hybrid.waitForSynchronization(cancelled);
    assert.equal((await hybrid.task(ownTask.id)).status, "cancellation_requested");
    const reportId = crypto.randomUUID();
    s.transcript.name(reportId, "completion report");
    const direct = await s.request(core, `/tasks/${ownTask.id}/status`, { method: "PATCH", credential: alpha.identity.credential, body: { dataset_id: alpha.identity.datasetId, report_id: reportId, sequence: 1, status: "completed" } });
    assert.equal(direct.status, 200);
    await hybrid.waitForSynchronization(direct.body);
    assert.equal((await hybrid.task(ownTask.id)).status, "completed");
    assert.equal((await hybrid.task(ownTask.id)).cancellation_request_id, cancellationId);
    s.transcript.observe("scoped Task outcome", (await hybrid.task(ownTask.id)).status);
  });

  const scoped = await s.step("Take an Asset-scoped continuation cursor", async () => {
    const first = await s.request(core, "/queries/full?scope=asset", { credential: alpha.identity.credential });
    assert.equal(first.status, 200);
    assert.equal(first.body.coverage.asset_id, alpha.identity.assetId);
    assert.deepEqual(first.body.entities.map((entity) => entity.id), [alpha.identity.assetId]);
    return first.body.baseline;
  });

  await s.step("Scope credentials and cursors cannot cross identities", async () => {
    const operatorScope = await s.request(core, "/queries/full?scope=asset", { credential: core.installation.operatorKey });
    assert.equal(operatorScope.status, 403);
    const otherScope = await s.request(core, `/queries/changed-since?scope=asset&cursor=${encodeURIComponent(scoped)}`, { credential: beta.identity.credential });
    assert.equal(otherScope.status, 400);
    const fullScope = await s.request(core, `/queries/changed-since?cursor=${encodeURIComponent(scoped)}`, { credential: alpha.identity.credential });
    assert.equal(fullScope.status, 400);
  });

  await s.step("Unrelated traffic does not cause a false scoped gap", async () => {
    const replayRequests = scopedPayloads.filter(({ path }) => path === "/queries/changed-since").length;
    for (let sequence = 1; sequence <= 8; sequence++) {
      await beta.client.checkInAsset(beta.identity.assetId, { datasetId: beta.identity.datasetId, reportId: crypto.randomUUID(), sequence });
    }
    const replay = await s.request(core, `/queries/changed-since?scope=asset&cursor=${encodeURIComponent(scoped)}`, { credential: alpha.identity.credential });
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body.changes, []);
    assert.equal(replay.body.coverage.asset_id, alpha.identity.assetId);
    await eventually(() => hybrid.synchronization.sequence >= replay.body.through_sequence, "scoped continuation");
    assert.equal(scopedPayloads.filter(({ path }) => path === "/queries/changed-since").length, replayRequests);
    assert.equal(hybrid.synchronization.generation, 1);
    assert.equal((await hybrid.queryFull()).entities.length, 1);
    s.transcript.observe("excluded changes and scoped continuation", { changes: replay.body.changes.length, through: replay.body.through_sequence, generation: hybrid.synchronization.generation });
  });

  await s.step("Scoped payloads contain no unrelated resource and record wire bytes", async () => {
    assert.ok(scopedPayloads.length > 0 && feedPayloads.length > 0);
    assert.ok(scopedPayloads.every(({ body }) => !body.includes(beta.identity.assetId) && !body.includes(unrelatedTask.id)));
    assert.ok(feedPayloads.every((body) => !body.includes(beta.identity.assetId) && !body.includes(unrelatedTask.id)));
    const taskFrame = feedPayloads.find((raw) => {
      const message = JSON.parse(raw);
      return message.type === "change" && message.change.resource_id === ownTask.id && message.change.kind === "create";
    });
    assert.ok(taskFrame);
    const bytes = {
      scopedSnapshot: scopedPayloads.filter(({ path }) => path === "/queries/full").reduce((sum, { body }) => sum + Buffer.byteLength(body), 0),
      ownTaskFeedFrame: Buffer.byteLength(taskFrame),
    };
    assert.ok(bytes.scopedSnapshot > 0 && bytes.ownTaskFeedFrame > 0);
    s.transcript.observe("Asset-scoped response bytes", bytes);
  });

  await s.step("An unavailable own picture does not fall back to HTTP", async () => {
    hybrid.stopSynchronization();
    await assert.rejects(hybrid.entity(alpha.identity.assetId), (error) => error instanceof PictureError && error.code === "not_ready");
    assert.equal((await hybrid.entity(beta.identity.assetId)).id, beta.identity.assetId);
    s.transcript.observe("own picture after stop", hybrid.synchronization.state);
  });
});

/** Holds post-hello feed messages so the test controls application order. */
class PausedFeed extends EventTarget {
  constructor(url) {
    super();
    this.held = [];
    this.socket = new WebSocket(url);
    for (const type of ["open", "close", "error"]) this.socket.addEventListener(type, () => this.dispatchEvent(new Event(type)));
    this.socket.addEventListener("message", (event) => {
      if (JSON.parse(event.data).type === "hello") this.dispatchEvent(new MessageEvent("message", { data: event.data }));
      else this.held.push(String(event.data));
    });
  }

  send(data) { this.socket.send(data); }
  close() { this.socket.close(); }
  release(predicate) {
    const index = this.held.findIndex((raw) => predicate(JSON.parse(raw)));
    assert.notEqual(index, -1);
    this.dispatchEvent(new MessageEvent("message", { data: this.held.splice(index, 1)[0] }));
  }
}

/** Delays authentication on a reconnect until the missed changes have committed. */
class DelayedAuthenticationFeed extends EventTarget {
  constructor(url, gate) {
    super();
    this.socket = new WebSocket(url);
    this.gate = gate;
    for (const type of ["open", "close", "error"]) this.socket.addEventListener(type, () => this.dispatchEvent(new Event(type)));
    this.socket.addEventListener("message", (event) => this.dispatchEvent(new MessageEvent("message", { data: event.data })));
  }

  send(data) { this.gate.arrive(); void this.gate.opened.then(() => this.socket.send(data)); }
  close() { this.socket.close(); }
}

scenario("Hybrid submissions return on commit while local application stays ordered", async (s) => {
  const core = await s.startCore();
  const alpha = await s.step("Enroll the assigned Asset", () => enrollAsset(s, core, undefined, "alpha"));
  const beta = await s.step("Enroll an unrelated Asset", () => enrollAsset(s, core, { alias: "Beta" }, "beta"));
  const gate = new Gate();
  const feeds = [];
  const hybrid = new AtlasClient({
    baseUrl: core.baseUrl,
    apiKey: alpha.identity.credential,
    mode: "hybrid",
    assetId: alpha.identity.assetId,
    fetch: gatedFetch((request) => request.method === "POST" && new URL(request.url).pathname === `/entities/${alpha.identity.assetId}/checkin`, gate),
    webSocketFactory: (url) => { const feed = new PausedFeed(url); feeds.push(feed); return feed; },
  });
  s.context.after(() => hybrid.stopSynchronization());
  await s.step("Start a scoped picture and local feed", () => hybrid.startSynchronization());
  const baseline = (await hybrid.queryFull()).baseline;
  const seen = [];
  await hybrid.subscribeFeed((change) => seen.push(change.sequence));
  const reports = [1, 2].map((sequence) => ({ datasetId: alpha.identity.datasetId, reportId: crypto.randomUUID(), sequence }));
  reports.forEach((report, index) => s.transcript.name(report.reportId, `own check-in ${index + 1}`));

  const [first, second] = await s.step("A later response returns while the first response and feed are held", async () => {
    const firstPending = hybrid.checkInAsset(alpha.identity.assetId, reports[0]);
    await gate.arrived;
    const unrelated = await beta.client.checkInAsset(beta.identity.assetId, { datasetId: beta.identity.datasetId, reportId: crypto.randomUUID(), sequence: 1 });
    const second = await hybrid.checkInAsset(alpha.identity.assetId, reports[1]);
    assert.ok(second.change_sequence > unrelated.change_sequence);
    await assert.rejects(hybrid.waitForSynchronization(second, 50), (error) => error instanceof PictureError && error.code === "sync_timeout");
    assert.equal((await hybrid.entity(alpha.identity.assetId)).version, 1);
    gate.open();
    const first = await firstPending;
    assert.ok(first.change_sequence < second.change_sequence);
    s.transcript.observe("committed before local application", { first: first.change_sequence, unrelated: unrelated.change_sequence, second: second.change_sequence });
    return [first, second];
  });

  await s.step("Deliver the later event first; replay fills the own-Asset gap", async () => {
    await eventually(() => feeds[0].held.some((raw) => JSON.parse(raw).type === "change" && JSON.parse(raw).change.sequence === second.change_sequence), "later Entity feed event");
    feeds[0].release((message) => message.type === "change" && message.change.sequence === second.change_sequence);
    await hybrid.waitForSynchronization(second);
    assert.deepEqual(await hybrid.entity(alpha.identity.assetId), second);
    assert.deepEqual((await hybrid.changedSince(baseline)).changes.map((change) => change.sequence), [first.change_sequence, second.change_sequence]);
    assert.deepEqual(seen, [first.change_sequence, second.change_sequence]);
    s.transcript.observe("applied scoped Entity sequences", seen);
  });
});

scenario("Hybrid recovery replays only own changes after unrelated history is pruned", async (s) => {
  const core = await s.startCore(undefined, { ATLAS_CHANGE_RETENTION: "5" });
  const alpha = await s.step("Enroll Alpha", () => enrollAsset(s, core, undefined, "alpha"));
  const beta = await s.step("Enroll Beta", () => enrollAsset(s, core, { alias: "Beta" }, "beta"));
  const operator = s.client(core, core.installation.operatorKey);
  const gate = new Gate();
  const sockets = [];
  const scopedPayloads = [];
  const hybrid = new AtlasClient({
    baseUrl: core.baseUrl,
    apiKey: alpha.identity.credential,
    mode: "hybrid",
    assetId: alpha.identity.assetId,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const response = await fetch(request);
      if (new URL(request.url).searchParams.get("scope") === "asset") scopedPayloads.push(await response.clone().text());
      return response;
    },
    webSocketFactory: (url) => {
      const socket = sockets.length === 0 ? new WebSocket(url) : new DelayedAuthenticationFeed(url, gate);
      sockets.push(socket);
      return socket;
    },
  });
  s.context.after(() => hybrid.stopSynchronization());
  await s.step("Start the Asset subset", () => hybrid.startSynchronization());

  await s.step("Disconnect and hold feed reauthentication", async () => {
    sockets[0].close();
    await eventually(() => hybrid.synchronization.state === "stale", "stale hybrid picture");
    await gate.arrived;
    assert.equal(hybrid.synchronization.state, "stale");
  });

  const task = await s.step("Commit unrelated traffic and one own Task while disconnected", async () => {
    await s.transcript.unrecorded(async () => {
      for (let sequence = 1; sequence <= 8; sequence++) {
        await beta.client.checkInAsset(beta.identity.assetId, { datasetId: beta.identity.datasetId, reportId: crypto.randomUUID(), sequence });
      }
    });
    const submission = await operator.prepareMoveTo(alpha.identity.assetId, { latitude: 40, longitude: -70 });
    s.transcript.name(submission.submission_id, "recovery submission");
    const task = await operator.submitTask(submission);
    s.transcript.name(task.id, "recovery Task");
    assert.equal(task.change_sequence, 11);
    return task;
  });

  await s.step("Scoped replay catches up without unrelated resources or rebuild", async () => {
    gate.open();
    await hybrid.waitForSynchronization(task);
    assert.equal(hybrid.synchronization.state, "ready");
    assert.equal(hybrid.synchronization.generation, 1);
    assert.deepEqual((await hybrid.tasks()).tasks.map((item) => item.id), [task.id]);
    assert.ok(scopedPayloads.every((body) => !body.includes(beta.identity.assetId)));
    s.transcript.observe("recovered Task and picture generation", { tasks: (await hybrid.tasks()).tasks.length, generation: hybrid.synchronization.generation });
  });
});

scenario("An expired Asset replay rebuilds before satisfying a scoped wait", async (s) => {
  const core = await s.startCore(undefined, { ATLAS_CHANGE_RETENTION: "5" });
  const alpha = await s.step("Enroll the scoped Asset", () => enrollAsset(s, core, undefined, "alpha"));
  const beta = await s.step("Enroll another Asset", () => enrollAsset(s, core, { alias: "Beta" }, "beta"));
  const feeds = [];
  const hybrid = new AtlasClient({ baseUrl: core.baseUrl, apiKey: alpha.identity.credential, mode: "hybrid", assetId: alpha.identity.assetId, webSocketFactory: (url) => { const feed = new PausedFeed(url); feeds.push(feed); return feed; } });
  s.context.after(() => hybrid.stopSynchronization());
  await s.step("Start the scoped picture", () => hybrid.startSynchronization());
  const oldCursor = (await hybrid.queryFull()).baseline;

  const last = await s.step("Own changes expire while feed delivery is held", async () => {
    let written;
    for (let sequence = 1; sequence <= 8; sequence++) {
      written = await alpha.client.checkInAsset(alpha.identity.assetId, { datasetId: alpha.identity.datasetId, reportId: crypto.randomUUID(), sequence });
    }
    await beta.client.checkInAsset(beta.identity.assetId, { datasetId: beta.identity.datasetId, reportId: crypto.randomUUID(), sequence: 1 });
    await eventually(() => feeds[0].held.some((raw) => {
      const message = JSON.parse(raw);
      return message.type === "change" && message.change.sequence === written.change_sequence;
    }), "held final own change");
    await assert.rejects(hybrid.waitForSynchronization(written, 50), (error) => error instanceof PictureError && error.code === "sync_timeout");
    return written;
  });

  await s.step("A current snapshot satisfies the committed write without inventing history", async () => {
    feeds[0].release((message) => message.type === "change" && message.change.sequence === last.change_sequence);
    await eventually(() => hybrid.synchronization.generation === 2 && hybrid.synchronization.state === "ready", "rebuilt scoped picture");
    await hybrid.waitForSynchronization(last);
    assert.deepEqual(await hybrid.entity(alpha.identity.assetId), last);
    await assert.rejects(hybrid.changedSince(oldCursor), (error) => error instanceof PictureError && error.code === "cursor_expired");
    s.transcript.observe("scoped rebuild generation and Asset version", { generation: hybrid.synchronization.generation, version: last.version });
  });
});

scenario("Hybrid initial pages include assigned Tasks and exclude unrelated Tasks", async (s) => {
  const core = await s.startCore();
  const alpha = await s.step("Enroll Alpha", () => enrollAsset(s, core, undefined, "alpha"));
  const beta = await s.step("Enroll Beta", () => enrollAsset(s, core, { alias: "Beta", command_manifest: [{ command_id: "move_to", scheduling: ["queued"] }] }, "beta"));
  const operator = s.client(core, core.installation.operatorKey);
  const tasks = await s.step("Commit two own Tasks around an unrelated Task", async () => {
    const create = async (assetId, latitude) => operator.submitTask(await operator.prepareMoveTo(assetId, { latitude, longitude: -70 }));
    const one = await create(alpha.identity.assetId, 40);
    const unrelated = await create(beta.identity.assetId, 41);
    const two = await create(alpha.identity.assetId, 42);
    s.transcript.name(one.id, "first own Task");
    s.transcript.name(unrelated.id, "unrelated Task");
    s.transcript.name(two.id, "second own Task");
    return { one, unrelated, two };
  });
  const hybrid = new AtlasClient({ baseUrl: core.baseUrl, apiKey: alpha.identity.credential, mode: "hybrid", assetId: alpha.identity.assetId, snapshotPageSize: 1 });
  s.context.after(() => hybrid.stopSynchronization());
  await s.step("Paginated initial load has only the declared coverage", async () => {
    await hybrid.startSynchronization();
    const picture = await hybrid.queryFull();
    assert.equal(picture.coverage.asset_id, alpha.identity.assetId);
    assert.deepEqual(picture.entities.map((entity) => entity.id), [alpha.identity.assetId]);
    assert.deepEqual(picture.tasks.map((task) => task.id), [tasks.one.id, tasks.two.id].sort());
    assert.ok(!JSON.stringify(picture).includes(tasks.unrelated.id));
    s.transcript.observe("initial Asset and Task counts", { entities: picture.entities.length, tasks: picture.tasks.length, generation: hybrid.synchronization.generation });
  });

  await s.step("Core's scoped pages carry one baseline and one identity", async () => {
    const pages = await s.transcript.unrecorded(async () => {
      const pages = [];
      let cursor;
      do {
        const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
        const response = await s.request(core, `/queries/full?scope=asset&limit=1${suffix}`, { credential: alpha.identity.credential });
        assert.equal(response.status, 200);
        pages.push(response.body);
        cursor = response.body.next_cursor;
      } while (cursor);
      return pages;
    });
    assert.equal(pages.length, 3);
    assert.ok(pages.every((page) => page.baseline === pages[0].baseline && page.coverage.asset_id === alpha.identity.assetId));
    assert.deepEqual(pages.flatMap((page) => page.tasks.map((task) => task.id)), [tasks.one.id, tasks.two.id].sort());
    s.transcript.observe("scoped page count and Task count", { pages: pages.length, tasks: pages.flatMap((page) => page.tasks).length });
  });
});
