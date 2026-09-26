import assert from "node:assert/strict";

import { enrollAsset, scoutFacts } from "./harness/assets.mjs";
import { eventually } from "./harness/barriers.mjs";
import { scenario } from "./harness/scenario.mjs";

scenario("Core filters an Asset snapshot replay and feed before transmission", async (s) => {
  const core = await s.startCore(undefined, { ATLAS_CHANGE_RETENTION: "5" });
  const alpha = await s.step("Enroll Alpha", () => enrollAsset(s, core, { ...scoutFacts, alias: "Alpha" }, "alpha"));
  const beta = await s.step("Enroll Beta", () => enrollAsset(s, core, { ...scoutFacts, alias: "Beta" }, "beta"));
  const operator = s.client(core, core.installation.operatorKey);

  const before = await s.step("Take an Asset-scoped baseline", async () => {
    const response = await s.request(core, "/queries/full?scope=asset", { credential: alpha.identity.credential });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.entities.map((entity) => entity.id), [alpha.identity.assetId]);
    assert.equal(response.body.coverage.asset_id, alpha.identity.assetId);
    return response.body.baseline;
  });

  const feed = new WebSocket(new URL("/feed", core.baseUrl.replace(/^http/, "ws")));
  const frames = [];
  feed.addEventListener("message", (event) => frames.push({ raw: String(event.data), body: JSON.parse(String(event.data)) }));
  s.context.after(() => feed.close());
  await new Promise((resolve, reject) => {
    feed.addEventListener("open", resolve, { once: true });
    feed.addEventListener("error", reject, { once: true });
  });
  feed.send(JSON.stringify({ api_key: alpha.identity.credential, scope: "asset" }));
  await eventually(() => frames.some(({ body }) => body.type === "hello"), "scoped feed hello");
  assert.equal(frames[0].body.coverage.asset_id, alpha.identity.assetId);

  const { own, unrelated } = await s.step("Commit assigned and unrelated Tasks", async () => {
    const own = await operator.submitTask(await operator.prepareMoveTo(alpha.identity.assetId, { latitude: 40, longitude: -70 }));
    const unrelated = await operator.submitTask(await operator.prepareMoveTo(beta.identity.assetId, { latitude: 41, longitude: -71 }));
    s.transcript.name(own.id, "own Task");
    s.transcript.name(unrelated.id, "unrelated Task");
    return { own, unrelated };
  });

  await s.step("The scoped feed sends the assigned Task and excluded-sequence proof", async () => {
    await eventually(() => frames.some(({ body }) => body.type === "progress" && body.through_sequence >= unrelated.change_sequence), "scoped feed progress");
    assert.deepEqual(frames.filter(({ body }) => body.type === "change").map(({ body }) => body.change.resource_id), [own.id]);
    assert.ok(frames.every(({ raw }) => !raw.includes(beta.identity.assetId) && !raw.includes(unrelated.id)));
    s.transcript.observe("scoped feed coverage and change count", { scope: frames[0].body.coverage.scope, changes: 1 });
  });

  await s.step("Snapshot pages contain only the Asset and its assigned Task", async () => {
    const pages = [];
    let cursor;
    do {
      const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const response = await s.request(core, `/queries/full?scope=asset&limit=1${suffix}`, { credential: alpha.identity.credential });
      assert.equal(response.status, 200);
      pages.push(response.body);
      cursor = response.body.next_cursor;
    } while (cursor);
    assert.deepEqual(pages.flatMap((page) => page.entities.map((entity) => entity.id)), [alpha.identity.assetId]);
    assert.deepEqual(pages.flatMap((page) => page.tasks.map((task) => task.id)), [own.id]);
    assert.ok(pages.every((page) => page.coverage.asset_id === alpha.identity.assetId && page.baseline === pages[0].baseline));
    assert.ok(pages.every((page) => !JSON.stringify(page).includes(unrelated.id)));
  });

  const replayCursor = await s.step("Replay proves the excluded Task sequence", async () => {
    const response = await s.request(core, `/queries/changed-since?scope=asset&cursor=${encodeURIComponent(before)}`, { credential: alpha.identity.credential });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.changes.map((change) => change.resource_id), [own.id]);
    assert.ok(response.body.through_sequence >= unrelated.change_sequence);
    return response.body.cursor;
  });

  await s.step("Cursors and scope stay bound to the authenticated Asset", async () => {
    const wrongAsset = await s.request(core, `/queries/changed-since?scope=asset&cursor=${encodeURIComponent(replayCursor)}`, { credential: beta.identity.credential });
    const wrongScope = await s.request(core, `/queries/changed-since?cursor=${encodeURIComponent(replayCursor)}`, { credential: alpha.identity.credential });
    const wrongKind = await s.request(core, "/queries/full?scope=asset", { credential: core.installation.operatorKey });
    assert.equal(wrongAsset.status, 400);
    assert.equal(wrongScope.status, 400);
    assert.equal(wrongKind.status, 403);
  });

  await s.step("Pruning unrelated traffic does not expire the scoped cursor", async () => {
    await s.transcript.unrecorded(async () => {
      for (let sequence = 1; sequence <= 8; sequence++) {
        await beta.client.checkInAsset(beta.identity.assetId, { datasetId: beta.identity.datasetId, reportId: crypto.randomUUID(), sequence });
      }
    });
    const response = await s.request(core, `/queries/changed-since?scope=asset&cursor=${encodeURIComponent(replayCursor)}`, { credential: alpha.identity.credential });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.changes, []);
    assert.ok(response.body.through_sequence > unrelated.change_sequence);
    assert.equal(response.body.coverage.asset_id, alpha.identity.assetId);
    s.transcript.observe("excluded changes after pruning", response.body.changes.length);
  });
});
