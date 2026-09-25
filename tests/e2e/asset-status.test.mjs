import assert from "node:assert/strict";

import { AtlasError } from "../../sdk/dist/index.js";
import { enrollAsset, statusReport } from "./harness/assets.mjs";
import { scenario } from "./harness/scenario.mjs";

const rejectsWith = (status, code) => (error) => error instanceof AtlasError && error.status === status && error.code === code;

scenario("An Asset reports only its own status, in sequence", async (s) => {
  const core = await s.startCore();
  const scout = await s.step("Enroll two Assets", async () => ({
    first: await enrollAsset(s, core, { alias: "First" }, "first asset"),
    second: await enrollAsset(s, core, { alias: "Second" }, "second asset"),
  }));
  const { identity, client } = scout.first;
  const ready = statusReport(s, identity, 1, "ready");

  const updated = await s.step("A fresh report updates status and contact", async () => {
    const asset = await client.reportAssetStatus(identity.assetId, ready);
    assert.equal(asset.components.status.value, "ready");
    assert.ok(asset.components.status.reported_at);
    assert.ok(asset.components.heartbeat.last_seen);
    assert.equal(asset.components.communications.link_state, "healthy");
    assert.equal(asset.version, 2);
    return asset;
  });

  await s.step("Resending the same report returns the Asset unchanged", async () => {
    assert.deepEqual(await client.reportAssetStatus(identity.assetId, ready), updated);
  });

  await s.step("Reusing a report ID with different facts conflicts", async () => {
    await assert.rejects(client.reportAssetStatus(identity.assetId, { ...ready, status: "busy" }), rejectsWith(409, "report_conflict"));
  });

  await s.step("A report that is not newer is rejected", async () => {
    await assert.rejects(client.reportAssetStatus(identity.assetId, statusReport(s, identity, 1, "stopped", "stale report")), rejectsWith(409, "report_out_of_order"));
  });

  await s.step("Another Asset cannot report for this Asset", async () => {
    const report = statusReport(s, identity, 2, "stopped", "foreign report");
    await assert.rejects(scout.second.client.reportAssetStatus(identity.assetId, report), rejectsWith(403, "forbidden"));
  });

  await s.step("An operator cannot report Asset status", async () => {
    const report = statusReport(s, identity, 2, "stopped", "operator report");
    await assert.rejects(s.client(core, core.installation.operatorKey).reportAssetStatus(identity.assetId, report), rejectsWith(403, "forbidden"));
  });

  await s.step("A matching enrollment retry returns current state, not enrollment facts", async () => {
    const retried = await s.client(core, core.installation.enrollmentKey).enrollAsset(identity, { alias: "First" });
    assert.deepEqual(retried.asset, updated);
  });
});

scenario("Accepted Asset reports are recognized after Restart", async (s) => {
  const installation = await s.installation();
  let core = await s.startCore(installation);
  const { identity } = await s.step("Enroll an Asset", () => enrollAsset(s, core, { alias: "Restarted" }));
  const ready = statusReport(s, identity, 1, "ready");
  const updated = await s.step("Report status", () => s.client(core, identity.credential).reportAssetStatus(identity.assetId, ready));

  await s.step("Restart Core", async () => {
    await core.stop();
    core = await s.startCore(installation);
  });

  await s.step("Resending the report returns the Asset unchanged", async () => {
    assert.deepEqual(await s.client(core, identity.credential).reportAssetStatus(identity.assetId, ready), updated);
  });

  await s.step("An older sequence is still rejected", async () => {
    await assert.rejects(
      s.client(core, identity.credential).reportAssetStatus(identity.assetId, statusReport(s, identity, 1, "busy", "stale report")),
      rejectsWith(409, "report_out_of_order"));
  });
});
