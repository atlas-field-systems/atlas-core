import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { fixture } from "../harness/fixtures.mjs";
import { scenario } from "../harness/scenario.mjs";

scenario("Local Start and Stop keep the Dataset in Docker", async (s) => {
  const installation = await s.composeInstallation();
  let core = await s.step("Start the installed image through atlasctl", async () => {
    const started = await installation.start();
    s.transcript.note("atlasctl start waited for the container health probe.");
    return started;
  });

  const dataset = await s.step("The SDK authenticates and discovers the Dataset", async () => {
    const client = s.client(core, installation.operatorKey);
    assert.deepEqual(await client.health(), await fixture("health"));
    assert.deepEqual(await client.readiness(), await fixture("readiness"));
    return client.dataset();
  });

  await s.step("Stop and Start through atlasctl", async () => {
    await installation.atlasctl("stop");
    core = await installation.start();
    s.transcript.note("Core container stopped and started on the same mounted storage.");
  });

  await s.step("The Dataset is retained", async () => {
    assert.deepEqual(await s.client(core, installation.operatorKey).dataset(), dataset);
  });
});

scenario("Local Start refuses unusable Object storage", async (s) => {
  const installation = await s.composeInstallation();
  await s.step("Start once, then Stop", async () => {
    await installation.start();
    await installation.atlasctl("stop");
    s.transcript.note("A Dataset and private Object directory now exist.");
  });

  await s.step("Replace the Object directory with a file", async () => {
    const objects = path.join(installation.operationalDir, "objects");
    await rm(objects, { recursive: true });
    await writeFile(objects, "blocked");
  });

  await s.step("Start reports failure", async () => {
    await assert.rejects(installation.atlasctl("start"));
    s.transcript.note("atlasctl start exited with an error because the health probe failed.");
  });
});
