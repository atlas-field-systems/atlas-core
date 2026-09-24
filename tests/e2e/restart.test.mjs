import assert from "node:assert/strict";

import { fixture } from "./harness/fixtures.mjs";
import { scenario } from "./harness/scenario.mjs";

scenario("Dataset identity survives Restart", async (s) => {
  const installation = await s.installation();
  let core = await s.startCore(installation);
  const client = () => s.client(core, installation.operatorKey);

  const before = await s.step("Discover the Dataset", () => client().dataset());

  await s.step("Restart Core", async () => {
    await core.stop();
    core = await s.startCore(installation);
    s.transcript.note("Core stopped with SIGTERM and started again on the same storage.");
  });

  await s.step("The Dataset keeps its identity and writing release", async () => {
    assert.deepEqual(await client().dataset(), before);
  });
});

scenario("Local recovery issues another working credential", async (s) => {
  const core = await s.startCore();

  const recovered = await s.step("Recover through atlasctl", async () => {
    const output = await core.installation.atlasctl("recover");
    const key = output.match(/atlas_[A-Za-z0-9_-]+/)?.[0];
    assert.ok(key, "recover prints the new credential");
    assert.notEqual(key, core.installation.operatorKey);
    s.transcript.note("atlasctl printed a new administrative credential.");
    return key;
  });

  await s.step("The recovered credential authenticates", async () => {
    assert.deepEqual(await s.client(core, recovered, "recovered key").health(), await fixture("health"));
  });

  await s.step("The first credential still authenticates", async () => {
    assert.deepEqual(await s.client(core, core.installation.operatorKey).health(), await fixture("health"));
  });
});
