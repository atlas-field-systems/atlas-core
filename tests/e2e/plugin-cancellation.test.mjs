import assert from "node:assert/strict";

import { AtlasError } from "../../sdk/dist/index.js";
import { eventually } from "./harness/barriers.mjs";
import { prepare, startWithPlugin } from "./harness/operations.mjs";
import { elevationPlugin, fixturePlugin } from "./harness/plugins.mjs";
import { scenario } from "./harness/scenario.mjs";

const work = "fixture.work";

async function holdWork(s, operator, input, label) {
  const submission = await prepare(s, operator, work, input, label);
  const accepted = await operator.submitOperation("fixture", submission);
  await s.transcript.unrecorded(() => eventually(async () => (await operator.operation("fixture", accepted.id)).status === "in_progress", "held work in progress"));
  return { submission, accepted };
}

scenario("Canceling running work confirms canceled, and a rerun is a new attempt", async (s) => {
  const { operator } = await startWithPlugin(s, fixturePlugin);
  const { submission, accepted } = await s.step("Start work the fixture holds", () => holdWork(s, operator, { label: "held", hold: true }));

  await s.step("Request cancellation; the Plugin confirms it", async () => {
    const requested = await operator.cancelOperation("fixture", accepted.id);
    assert.ok(["cancellation_requested", "canceled"].includes(requested.status));
    const outcome = await s.transcript.unrecorded(() => operator.waitForOperation("fixture", accepted.id));
    s.transcript.observe("outcome", { status: outcome.status, output: outcome.output });
    assert.equal(outcome.status, "canceled");
  });

  await s.step("Resubmitting the same submission returns the canceled attempt", async () => {
    const retried = await operator.submitOperation("fixture", submission);
    assert.equal(retried.id, accepted.id);
    assert.equal(retried.status, "canceled");
  });

  await s.step("A rerun is an explicit new submission and a new attempt", async () => {
    const rerun = await operator.submitOperation("fixture", await prepare(s, operator, work, { label: "held" }, "rerun"));
    assert.notEqual(rerun.id, accepted.id);
    assert.equal((await s.transcript.unrecorded(() => operator.waitForOperation("fixture", rerun.id))).status, "completed");
  });
});

scenario("A requested cancellation can still end in completion", async (s) => {
  const { core, operator, plugin, process } = await startWithPlugin(s, fixturePlugin);
  const asPlugin = s.client(core, plugin.env.ATLAS_PLUGIN_KEY, "fixture plugin key");
  const { accepted } = await s.step("Start work that ignores cancellation", () => holdWork(s, operator, { label: "stubborn", hold: true, ignore_cancel: true }));

  await s.step("Request cancellation", async () => {
    assert.equal((await operator.cancelOperation("fixture", accepted.id)).status, "cancellation_requested");
  });

  await s.step("Progress keeps the cancellation request visible", async () => {
    const progressed = await asPlugin.reportOperation("fixture", accepted.id, { status: "in_progress", output: { label: "stubborn", stage: "still running" } });
    assert.equal(progressed.status, "cancellation_requested");
    assert.deepEqual(progressed.output, { label: "stubborn", stage: "still running" });
  });

  await s.step("The work finishes anyway and is recorded as completed", async () => {
    await process.control("POST", "/fixture/release");
    const outcome = await s.transcript.unrecorded(() => operator.waitForOperation("fixture", accepted.id));
    assert.equal(outcome.status, "completed");
  });
});

scenario("Canceling a finished attempt changes nothing", async (s) => {
  const { operator } = await startWithPlugin(s, elevationPlugin);
  const finished = await s.step("Complete a lookup", async () => {
    const accepted = await operator.submitOperation("elevation", await prepare(s, operator, "elevation.lookup", { latitude: 42, longitude: -71 }));
    return s.transcript.unrecorded(() => operator.waitForOperation("elevation", accepted.id));
  });

  await s.step("Canceling returns the completed attempt unchanged", async () => {
    assert.deepEqual(await operator.cancelOperation("elevation", finished.id), finished);
  });

  await s.step("Canceling an unknown attempt is not found", async () => {
    const unknown = crypto.randomUUID();
    s.transcript.name(unknown, "unknown operation");
    await assert.rejects(operator.cancelOperation("elevation", unknown), (error) => error instanceof AtlasError && error.status === 404);
  });
});
