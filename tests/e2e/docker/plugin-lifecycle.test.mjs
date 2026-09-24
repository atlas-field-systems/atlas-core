import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { AtlasError } from "../../../sdk/dist/index.js";
import { eventually } from "../harness/barriers.mjs";
import { buildPluginImage } from "../harness/compose.mjs";
import { prepare } from "../harness/operations.mjs";
import { elevationPlugin, fixturePlugin } from "../harness/plugins.mjs";
import { scenario } from "../harness/scenario.mjs";

const work = "fixture.work";

/** Installs the fixture and Elevation Plugins in containers and starts everything. */
async function startLifecycleInstallation(s) {
  const installation = await s.composeInstallation();
  for (const dir of [fixturePlugin, elevationPlugin]) {
    const manifest = JSON.parse(await readFile(path.join(dir, "atlas-plugin.json"), "utf8"));
    await buildPluginImage(dir, manifest.image);
    await installation.atlasctl("plugin-install", dir);
  }
  const core = await installation.start();
  const operator = s.client(core, installation.operatorKey);
  await s.transcript.unrecorded(() => eventually(async () => {
    const { items } = await operator.plugins();
    return items.every((plugin) => plugin.availability === "available");
  }, "both Plugins available"));
  return { installation, core, operator };
}

async function availability(operator) {
  const { items } = await operator.plugins();
  return Object.fromEntries(items.map((plugin) => [plugin.id, plugin.availability]));
}

async function holdWork(s, operator, label) {
  const accepted = await operator.submitOperation("fixture", await prepare(s, operator, work, { label, hold: true }, label));
  await s.transcript.unrecorded(() => eventually(async () => (await operator.operation("fixture", accepted.id)).status === "in_progress", "held work in progress"));
  return accepted;
}

scenario("A planned Plugin stop drains finite work while Core and other Plugins stay available", async (s) => {
  const { installation, operator } = await s.step("Install the fixture and Elevation Plugins and start", () => startLifecycleInstallation(s));
  const held = await s.step("Start work the fixture holds", () => holdWork(s, operator, "held"));

  // Wrapped so awaiting the step does not also await the stop.
  const { stop } = await s.step("Begin a planned stop; the fixture quiesces and pauses ingestion", async () => {
    const stop = installation.atlasctl("plugin-stop", "fixture");
    stop.catch(() => {}); // Awaited after the held work is released.
    // Core closes admission before it quiesces the Plugin; its HTTP view is
    // far quicker to watch than the container's.
    await s.transcript.unrecorded(() => eventually(async () => (await availability(operator)).fixture === "unavailable", "admission closed", 400));
    let state;
    await eventually(async () => !(state = await installation.callInside("plugin-fixture", "GET", "/fixture/state")).admitting, "a quiesced fixture", 10);
    s.transcript.observe("fixture while stopping", { admitting: state.admitting, ingesting: state.ingesting, held: state.held });
    assert.equal(state.ingesting, false);
    return { stop };
  });

  await s.step("While stopping, the fixture refuses new work and everything else is available", async () => {
    s.transcript.observe("availability", await availability(operator));
    await assert.rejects(operator.submitOperation("fixture", await prepare(s, operator, work, { label: "late" }, "late")), (error) => error instanceof AtlasError && error.code === "plugin_unavailable");
    assert.equal((await availability(operator)).elevation, "available");
    assert.equal((await operator.health()).status, "alive");
  });

  await s.step("Releasing the held work lets the stop finish with its outcome kept", async () => {
    await installation.callInside("plugin-fixture", "POST", "/fixture/release");
    await stop;
    assert.equal((await operator.operation("fixture", held.id)).status, "completed");
    s.transcript.observe("running services", await installation.runningServices());
    assert.deepEqual(await installation.runningServices(), ["core", "plugin-elevation"]);
  });

  await s.step("Starting the fixture again makes it available", async () => {
    await installation.atlasctl("plugin-start", "fixture");
    await s.transcript.unrecorded(() => eventually(async () => (await availability(operator)).fixture === "available", "an available fixture", 400));
  });
});

scenario("A Plugin that refuses to stop is faulted until it is force stopped and restarted", async (s) => {
  const { installation, operator } = await s.step("Install the fixture and Elevation Plugins and start", () => startLifecycleInstallation(s));
  const held = await s.step("Start held work and make the fixture refuse to quiesce", async () => {
    const accepted = await holdWork(s, operator, "held");
    await installation.callInside("plugin-fixture", "POST", "/fixture/refuse-quiesce");
    return accepted;
  });

  await s.step("The planned stop fails and faults the Plugin without claiming an outcome", async () => {
    await assert.rejects(installation.atlasctl("plugin-stop", "fixture"), /did not stop cooperatively/);
    const fixture = await operator.plugin("fixture");
    s.transcript.observe("fixture", { availability: fixture.availability, fault: fixture.fault });
    assert.equal(fixture.availability, "faulted");
    assert.equal((await operator.operation("fixture", held.id)).status, "in_progress");
  });

  await s.step("A force stop interrupts the unfinished work", async () => {
    await installation.atlasctl("plugin-force-stop", "fixture");
    const operation = await operator.operation("fixture", held.id);
    s.transcript.observe("held work", { status: operation.status, error: operation.error });
    assert.equal(operation.status, "interrupted");
    assert.equal((await availability(operator)).elevation, "available");
  });

  await s.step("Starting the fixture clears the fault and never reruns the attempt", async () => {
    await installation.atlasctl("plugin-start", "fixture");
    await s.transcript.unrecorded(() => eventually(async () => (await availability(operator)).fixture === "available", "an available fixture", 400));
    assert.equal((await operator.operation("fixture", held.id)).status, "interrupted");
  });
});
