import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { eventually } from "../harness/barriers.mjs";
import { buildPluginImage } from "../harness/compose.mjs";
import { prepare } from "../harness/operations.mjs";
import { elevationPlugin } from "../harness/plugins.mjs";
import { scenario } from "../harness/scenario.mjs";

scenario("The Elevation Plugin runs in its own container under local management", async (s) => {
  const installation = await s.composeInstallation();
  const manifest = JSON.parse(await readFile(path.join(elevationPlugin, "atlas-plugin.json"), "utf8"));
  await s.step("Build the Plugin image and install it through atlasctl", async () => {
    await buildPluginImage(elevationPlugin, manifest.image);
    await installation.atlasctl("plugin-install", elevationPlugin);
    s.transcript.note("atlasctl recorded the Plugin and wrote its container configuration.");
  });

  const core = await s.step("Start Core, which starts the installed Plugin", async () => {
    const started = await installation.start();
    s.transcript.observe("running services", await installation.runningServices());
    return started;
  });
  const operator = s.client(core, installation.operatorKey);

  await s.step("Discovery shows the Plugin available", async () => {
    await s.transcript.unrecorded(() => eventually(async () => (await operator.plugin("elevation")).availability === "available", "an available Plugin"));
    assert.deepEqual(await operator.plugin("elevation"), { id: "elevation", release: "1.0.0", availability: "available", capabilities: ["elevation.lookup"] });
  });

  await s.step("A lookup completes across the container boundary", async () => {
    const accepted = await operator.submitOperation("elevation", await prepare(s, operator, "elevation.lookup", { latitude: 42.001, longitude: -70.999 }));
    const outcome = await s.transcript.unrecorded(() => operator.waitForOperation("elevation", accepted.id));
    s.transcript.observe("outcome", { status: outcome.status, elevation: outcome.output.elevation });
    assert.equal(outcome.output.elevation, 130);
  });

  await s.step("Stopping Core also stops the Plugin", async () => {
    await installation.atlasctl("stop");
    s.transcript.observe("running services", await installation.runningServices());
    assert.deepEqual(await installation.runningServices(), []);
  });
});
