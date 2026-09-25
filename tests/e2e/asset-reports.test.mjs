import assert from "node:assert/strict";

import { AtlasError } from "../../sdk/dist/index.js";
import { enrollAsset } from "./harness/assets.mjs";
import { scenario } from "./harness/scenario.mjs";

const rejectsWith = (status, code) => (error) => error instanceof AtlasError && error.status === status && (code === undefined || error.code === code);

function report(s, identity, sequence, fields = {}) {
  const reportId = crypto.randomUUID();
  s.transcript.name(reportId, `report ${sequence}`);
  return { datasetId: identity.datasetId, reportId, sequence, ...fields };
}

scenario("Asset reports merge components and record contact", async (s) => {
  const core = await s.startCore();
  const { identity, client } = await s.step("Enroll an Asset", () => enrollAsset(s, core, { alias: "Alpha" }));
  const id = identity.assetId;

  const checkedIn = await s.step("A check-in with telemetry and health records contact but not status time", async () => {
    const asset = await client.checkInAsset(id, report(s, identity, 1, { components: { telemetry: { latitude: 42, longitude: -71, altitude_m: 20 }, health: { battery_percent: 90 } } }));
    assert.deepEqual(asset.components.telemetry, { latitude: 42, longitude: -71, altitude_m: 20 });
    assert.deepEqual(asset.components.health, { battery_percent: 90 });
    assert.equal(asset.components.status.reported_at, null);
    assert.ok(asset.components.heartbeat.last_seen);
    return asset;
  });

  await s.step("A patch replaces present fields, clears null ones and replaces the manifest", async () => {
    const asset = await client.patchEntity(id, report(s, identity, 2, { components: { telemetry: { altitude_m: null, speed_mps: 3 }, health: null }, commandManifest: [] }));
    assert.deepEqual(asset.components.telemetry, { latitude: 42, longitude: -71, speed_mps: 3 });
    assert.equal(asset.components.health, undefined);
    assert.deepEqual(asset.command_manifest, []);
    assert.equal(asset.change_sequence, checkedIn.change_sequence + 1);
  });

  const statusReported = await s.step("A status component sets status and its report time", async () => {
    const asset = await client.patchEntity(id, report(s, identity, 3, { components: { status: { value: "ready" } } }));
    assert.equal(asset.components.status.value, "ready");
    assert.ok(asset.components.status.reported_at);
    return asset;
  });

  await s.step("An empty check-in only records contact", async () => {
    const asset = await client.checkInAsset(id, report(s, identity, 4));
    assert.equal(asset.components.status.reported_at, statusReported.components.status.reported_at);
    assert.deepEqual(asset.components.telemetry, statusReported.components.telemetry);
  });

  await s.step("The status view matches the Entity", async () => {
    const entity = await client.entity(id);
    assert.deepEqual(await s.client(core, core.installation.operatorKey).assetStatus(id), {
      status: entity.components.status, communications: entity.components.communications, heartbeat: entity.components.heartbeat,
    });
  });

  await s.step("A null status is rejected by the Protocol", async () => {
    await assert.rejects(client.patchEntity(id, report(s, identity, 5, { components: { status: null } })), rejectsWith(400, "invalid_request"));
  });

  await s.step("Clearing longitude alone would leave a partial position", async () => {
    await assert.rejects(client.patchEntity(id, report(s, identity, 5, { components: { telemetry: { longitude: null } } })), rejectsWith(400, "invalid_request"));
  });
});

scenario("Only the Asset itself may check in or patch it", async (s) => {
  const core = await s.startCore();
  const alpha = await s.step("Enroll two Assets", async () => ({
    self: await enrollAsset(s, core, { alias: "Alpha" }, "alpha"),
    other: await enrollAsset(s, core, { alias: "Bravo" }, "bravo"),
  }));
  const { identity } = alpha.self;

  await s.step("Another Asset cannot patch it", async () => {
    await assert.rejects(alpha.other.client.patchEntity(identity.assetId, report(s, identity, 1, { components: { telemetry: { speed_mps: 5 } } })), rejectsWith(403, "forbidden"));
  });

  await s.step("An operator cannot check it in", async () => {
    await assert.rejects(s.client(core, core.installation.operatorKey).checkInAsset(identity.assetId, report(s, identity, 1)), rejectsWith(403, "forbidden"));
  });

  await s.step("A stale sequence is rejected", async () => {
    await alpha.self.client.checkInAsset(identity.assetId, report(s, identity, 2));
    await assert.rejects(alpha.self.client.checkInAsset(identity.assetId, report(s, identity, 2)), rejectsWith(409, "report_out_of_order"));
  });
});
