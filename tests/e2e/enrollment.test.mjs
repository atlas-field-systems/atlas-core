import assert from "node:assert/strict";

import { AtlasError } from "../../sdk/dist/index.js";
import { enrollAsset, enrollmentBody, prepareAsset, scoutFacts } from "./harness/assets.mjs";
import { scenario } from "./harness/scenario.mjs";

const rejectsWith = (status, code) => (error) =>
  error instanceof AtlasError && error.status === status && (code === undefined || error.code === code);

scenario("An authorized Asset enrolls with required defaults", async (s) => {
  const core = await s.startCore();
  const { identity, result, client } = await s.step("Enroll an Asset through the SDK", () => enrollAsset(s, core));

  await s.step("Enrollment keeps the facts and invents no contact", async () => {
    const asset = result.asset;
    assert.equal(asset.id, identity.assetId);
    assert.deepEqual(asset.components.status, { value: "unknown", reported_at: null });
    assert.equal(asset.components.communications.link_state, "offline");
    assert.equal(asset.components.heartbeat.last_seen, null);
    assert.deepEqual(asset.components.telemetry, scoutFacts.components.telemetry);
    assert.deepEqual(asset.components.health, scoutFacts.components.health);
    assert.deepEqual(asset.command_manifest, scoutFacts.command_manifest);
    assert.equal(asset.alias, scoutFacts.alias);
    assert.equal(asset.subtype, scoutFacts.subtype);
  });

  await s.step("The Asset and an operator read the same Asset", async () => {
    assert.deepEqual(await client.entity(identity.assetId), result.asset);
    assert.deepEqual(await s.client(core, core.installation.operatorKey).entity(identity.assetId), result.asset);
  });

  await s.step("An unknown Entity is not found", async () => {
    await assert.rejects(client.entity("00000000-0000-4000-8000-000000000000"), rejectsWith(404, "not_found"));
  });
});

scenario("An enrollment retry after a lost response returns the same Asset", async (s) => {
  const installation = await s.installation();
  let core = await s.startCore(installation);
  const facts = { alias: "Lost reply", components: { status: { value: "initializing" } } };
  const identity = await s.step("Prepare and retain an Asset identity", () => prepareAsset(s, core));

  await s.step("The first enrollment commits but its response is lost", async () => {
    const dropping = s.clientLosingFirstResponse(core, installation.enrollmentKey, "POST");
    await assert.rejects(dropping.enrollAsset(identity, facts), /response lost/);
  });

  const retried = await s.step("Retrying with the retained identity returns the Asset", async () => {
    const result = await s.client(core, installation.enrollmentKey).enrollAsset(identity, facts);
    assert.equal(result.asset.id, identity.assetId);
    assert.equal(result.asset.components.status.value, "initializing");
    return result;
  });

  await s.step("Restart Core", async () => {
    await core.stop();
    core = await s.startCore(installation);
  });

  await s.step("A retry after Restart returns the same principal and credential", async () => {
    assert.deepEqual(await s.client(core, installation.enrollmentKey).enrollAsset(identity, facts), retried);
  });

  await s.step("The enrolled credential authenticates", async () => {
    assert.deepEqual(await s.client(core, identity.credential).entity(identity.assetId), retried.asset);
  });
});

scenario("Concurrent identical enrollments create one Asset", async (s) => {
  const core = await s.startCore();
  const identity = await s.step("Prepare an Asset identity", () => prepareAsset(s, core));

  await s.step("Send the same enrollment eight times at once", async () => {
    const body = enrollmentBody(identity, { alias: "Concurrent" });
    const responses = await s.transcript.unrecorded(() => Promise.all(Array.from({ length: 8 }, () =>
      s.request(core, "/entities", { method: "POST", credential: core.installation.enrollmentKey, body }))));
    const statuses = responses.map((response) => response.status).sort();
    s.transcript.observe("response statuses, sorted", statuses);
    s.transcript.observe("distinct response bodies", new Set(responses.map((response) => JSON.stringify(response.body))).size);
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 200, 201]);
    assert.ok(responses.every((response) => JSON.stringify(response.body) === JSON.stringify(responses[0].body)));
  });
});

scenario("Changed enrollment facts conflict with the original enrollment", async (s) => {
  const core = await s.startCore();
  const enroller = s.client(core, core.installation.enrollmentKey);
  const { identity } = await s.step("Enroll an Asset", () => enrollAsset(s, core));

  const changes = {
    "a different alias": { ...scoutFacts, alias: "Other" },
    "a different battery level": { ...scoutFacts, components: { ...scoutFacts.components, health: { battery_percent: 75.000001 } } },
    "a different command manifest": { ...scoutFacts, command_manifest: [] },
  };
  for (const [change, facts] of Object.entries(changes)) {
    await s.step(`Retrying with ${change} conflicts`, async () => {
      await assert.rejects(enroller.enrollAsset(identity, facts), rejectsWith(409, "registration_conflict"));
    });
  }

  await s.step("A new request for the enrolled Asset ID conflicts", async () => {
    const requestId = crypto.randomUUID();
    s.transcript.name(requestId, "second request");
    await assert.rejects(enroller.enrollAsset({ ...identity, requestId }, scoutFacts), rejectsWith(409, "registration_conflict"));
  });

  await s.step("Another credential cannot claim the Asset ID", async () => {
    const other = await prepareAsset(s, core, "impostor");
    await assert.rejects(enroller.enrollAsset({ ...other, assetId: identity.assetId }, { alias: "Impostor" }), rejectsWith(409, "registration_conflict"));
  });
});

scenario("Only the enrollment authority may enroll Assets", async (s) => {
  const core = await s.startCore();
  const { identity, result, client } = await s.step("Enroll an Asset", () => enrollAsset(s, core));

  await s.step("Operator and Asset credentials cannot enroll", async () => {
    const other = await prepareAsset(s, core, "second asset");
    await assert.rejects(s.client(core, core.installation.operatorKey).enrollAsset(other), rejectsWith(403, "forbidden"));
    await assert.rejects(client.enrollAsset(other), rejectsWith(403, "forbidden"));
  });

  await s.step("The enrollment authority cannot read operational data", async () => {
    await assert.rejects(s.client(core, core.installation.enrollmentKey).entity(identity.assetId), rejectsWith(403, "forbidden"));
  });

  await s.step("Revoke the enrollment authority through atlasctl", async () => {
    await core.installation.atlasctl("revoke-enrollment");
    s.transcript.note("atlasctl revoked the enrollment authority.");
  });

  await s.step("A revoked authority cannot retry, but the enrolled Asset keeps access", async () => {
    await assert.rejects(s.client(core, core.installation.enrollmentKey).enrollAsset(identity, scoutFacts), rejectsWith(401, "unauthorized"));
    assert.deepEqual(await client.entity(identity.assetId), result.asset);
  });
});

scenario("Enrollment requests must match the Protocol and current Dataset", async (s) => {
  const core = await s.startCore();
  const credential = core.installation.enrollmentKey;
  await s.step("Enroll an Asset", () => enrollAsset(s, core));
  const identity = await s.step("Prepare a second Asset identity", () => prepareAsset(s, core, "second asset"));
  const post = (body) => s.request(core, "/entities", { method: "POST", credential, body });

  await s.step("An unknown field is rejected", async () => {
    assert.equal((await post({ ...enrollmentBody(identity), unexpected: "ignored data" })).status, 400);
  });

  await s.step("A malformed credential is rejected without echoing it", async () => {
    const response = await post(enrollmentBody({ ...identity, credential: "atlas_asset_short" }));
    assert.equal(response.status, 400);
    assert.ok(!JSON.stringify(response.body).includes("atlas_asset_short"));
  });

  await s.step("Latitude without longitude is rejected", async () => {
    const response = await post(enrollmentBody(identity, { components: { telemetry: { latitude: 42 } } }));
    assert.equal(response.status, 400);
  });

  await s.step("An enrollment for another Dataset conflicts", async () => {
    const datasetId = crypto.randomUUID();
    s.transcript.name(datasetId, "old dataset");
    const response = await post(enrollmentBody({ ...identity, datasetId }));
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "dataset_changed");
  });

  await s.step("An alias differing only in case conflicts", async () => {
    const response = await post(enrollmentBody(identity, { alias: "scout one" }));
    assert.equal(response.status, 409);
  });
});
