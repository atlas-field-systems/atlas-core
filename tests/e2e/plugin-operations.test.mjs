import assert from "node:assert/strict";

import { AtlasClient, AtlasError } from "../../sdk/dist/index.js";
import { eventually } from "./harness/barriers.mjs";
import { prepare, startWithPlugin } from "./harness/operations.mjs";
import { elevationPlugin, fixturePlugin } from "./harness/plugins.mjs";
import { scenario } from "./harness/scenario.mjs";

const rejectsWith = (status, code) => (error) => error instanceof AtlasError && error.status === status && error.code === code;
const lookup = "elevation.lookup";

scenario("Plugin discovery shows installed capabilities and availability", async (s) => {
  const { core, operator } = await startWithPlugin(s, elevationPlugin);

  await s.step("List installed Plugins", async () => {
    const page = await operator.plugins();
    assert.deepEqual(page.items, [{ id: "elevation", release: "1.0.0", availability: "available", capabilities: [lookup] }]);
  });

  await s.step("Read the Plugin directly", async () => {
    const response = await s.request(core, "/plugins/elevation", { credential: core.installation.operatorKey });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, (await operator.plugins()).items[0]);
  });

  await s.step("An unknown Plugin is not found", async () => {
    await assert.rejects(operator.plugin("missing"), rejectsWith(404, "not_found"));
  });
});

scenario("An Elevation Lookup completes and its outcome is retained", async (s) => {
  const { core, operator } = await startWithPlugin(s, elevationPlugin);
  const submission = await s.step("Prepare a lookup", () => prepare(s, operator, lookup, { latitude: 42, longitude: -71 }));

  const accepted = await s.step("Submit it directly; Core retains it and names its location", async () => {
    const response = await s.request(core, "/plugins/elevation/operations", { method: "POST", credential: core.installation.operatorKey, body: submission });
    assert.equal(response.status, 202);
    assert.equal(response.headers.get("location"), `/plugins/elevation/operations/${response.body.id}`);
    return response.body;
  });

  await s.step("The outcome carries the documented units and reference", async () => {
    const outcome = await s.transcript.unrecorded(() => operator.waitForOperation("elevation", accepted.id));
    s.transcript.observe("outcome", { status: outcome.status, output: outcome.output, error: outcome.error });
    assert.equal(outcome.status, "completed");
    assert.deepEqual(outcome.output, { latitude: 42, longitude: -71, elevation: 100, units: "m", reference: "synthetic demonstration datum (zero is arbitrary, not surveyed terrain)" });
  });

  await s.step("The attempt is retained in the Plugin's list", async () => {
    const page = await operator.operations("elevation");
    assert.deepEqual(page.items.map((operation) => operation.id), [accepted.id]);
  });
});

scenario("A lookup without a sample fails and keeps its input", async (s) => {
  const { operator } = await startWithPlugin(s, elevationPlugin);
  await s.step("Look up a coordinate with no sample", async () => {
    const accepted = await operator.submitOperation("elevation", await prepare(s, operator, lookup, { latitude: 41, longitude: -71 }));
    const outcome = await s.transcript.unrecorded(() => operator.waitForOperation("elevation", accepted.id));
    s.transcript.observe("outcome", { status: outcome.status, output: outcome.output, error: outcome.error });
    assert.equal(outcome.status, "failed");
    assert.deepEqual(outcome.output, { latitude: 41, longitude: -71 });
    assert.match(outcome.error, /No elevation sample/);
  });
});

scenario("A submission retry after a lost acceptance returns the original attempt", async (s) => {
  const { core, operator } = await startWithPlugin(s, elevationPlugin);
  const submission = await s.step("Prepare a lookup", () => prepare(s, operator, lookup, { latitude: 42, longitude: -71 }));

  await s.step("The acceptance response is lost", async () => {
    const dropping = s.clientLosingFirstResponse(core, core.installation.operatorKey, "POST");
    await assert.rejects(dropping.submitOperation("elevation", submission), /response lost/);
  });

  await s.step("Retrying the same submission returns the same attempt, run once", async () => {
    const retried = await operator.submitOperation("elevation", submission);
    const outcome = await s.transcript.unrecorded(() => operator.waitForOperation("elevation", retried.id));
    assert.equal(outcome.status, "completed");
    const retained = await operator.operations("elevation");
    assert.deepEqual(retained.items.map((operation) => operation.id), [retried.id]);
  });
});

scenario("A caller that disconnects after acceptance does not stop the attempt", async (s) => {
  const { core, operator } = await startWithPlugin(s, elevationPlugin);
  const accepted = await s.step("Submit, then drop the caller's connections", async () => {
    const departure = new AbortController();
    const departing = new AtlasClient({ baseUrl: core.baseUrl, apiKey: core.installation.operatorKey, fetch: (input, init) => s.transcript.fetch(input, { ...init, signal: departure.signal }) });
    const operation = await departing.submitOperation("elevation", await prepare(s, operator, lookup, { latitude: 42.001, longitude: -71 }));
    departure.abort();
    return operation;
  });

  await s.step("Another caller reads the completed outcome", async () => {
    const outcome = await s.transcript.unrecorded(() => operator.waitForOperation("elevation", accepted.id));
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.output.elevation, 120);
  });
});

scenario("Submissions are checked against the capability, Dataset and original facts", async (s) => {
  const { operator } = await startWithPlugin(s, elevationPlugin);
  const submission = await s.step("Submit a lookup", async () => {
    const prepared = await prepare(s, operator, lookup, { latitude: 42, longitude: -71 });
    await operator.submitOperation("elevation", prepared);
    return prepared;
  });

  await s.step("The same submission ID with different input conflicts", async () => {
    await assert.rejects(operator.submitOperation("elevation", { ...submission, input: { latitude: 42.001, longitude: -71 } }), rejectsWith(409, "submission_conflict"));
  });

  await s.step("A submission for another Dataset conflicts", async () => {
    const datasetId = crypto.randomUUID();
    s.transcript.name(datasetId, "old dataset");
    await assert.rejects(operator.submitOperation("elevation", { ...submission, dataset_id: datasetId }), rejectsWith(409, "dataset_changed"));
  });

  await s.step("Input outside the capability's schema is rejected", async () => {
    await assert.rejects(operator.submitOperation("elevation", await prepare(s, operator, lookup, { latitude: 91, longitude: 0 }, "out of range")), rejectsWith(400, "invalid_input"));
  });

  await s.step("An unknown capability is rejected", async () => {
    await assert.rejects(operator.submitOperation("elevation", await prepare(s, operator, "elevation.profile", {}, "unknown capability")), rejectsWith(400, "invalid_capability"));
  });

  await s.step("An unknown Plugin is not found", async () => {
    await assert.rejects(operator.submitOperation("missing", await prepare(s, operator, lookup, { latitude: 42, longitude: -71 }, "missing plugin")), rejectsWith(404, "not_found"));
  });
});

scenario("Operation lists page newest first", async (s) => {
  const { operator } = await startWithPlugin(s, elevationPlugin);
  const ids = await s.step("Submit three lookups", async () => {
    const accepted = [];
    for (const [index, latitude] of [42, 42.001, 42].entries()) {
      accepted.push((await operator.submitOperation("elevation", await prepare(s, operator, lookup, { latitude, longitude: -71 }, `submission ${index + 1}`))).id);
    }
    return accepted;
  });

  await s.step("Two pages list all three, newest first", async () => {
    const first = await operator.operations("elevation", { limit: 2 });
    const second = await operator.operations("elevation", { limit: 2, cursor: first.next_cursor });
    assert.deepEqual([...first.items, ...second.items].map((operation) => operation.id), [...ids].reverse());
    assert.equal(second.next_cursor, undefined);
  });
});

scenario("Only the owning Plugin reports, and a confirmed outcome cannot change", async (s) => {
  const { core, operator, plugin } = await startWithPlugin(s, fixturePlugin);
  const asPlugin = s.client(core, plugin.env.ATLAS_PLUGIN_KEY, "fixture plugin key");
  const held = await s.step("Submit work the fixture holds in progress", async () => {
    const accepted = await operator.submitOperation("fixture", await prepare(s, operator, "fixture.work", { label: "held", hold: true }));
    await s.transcript.unrecorded(() => eventually(async () => (await operator.operation("fixture", accepted.id)).status === "in_progress", "in progress"));
    return accepted;
  });

  await s.step("An operator cannot report", async () => {
    await assert.rejects(operator.reportOperation("fixture", held.id, { status: "completed" }), rejectsWith(403, "forbidden"));
  });

  await s.step("A failed outcome needs an error", async () => {
    await assert.rejects(asPlugin.reportOperation("fixture", held.id, { status: "failed" }), rejectsWith(400, "invalid_report"));
  });

  await s.step("The Plugin confirms completion, and may repeat it", async () => {
    const completed = await asPlugin.reportOperation("fixture", held.id, { status: "completed", output: { label: "held", stage: "reported" } });
    assert.equal(completed.status, "completed");
    assert.deepEqual(await asPlugin.reportOperation("fixture", held.id, { status: "completed", output: { label: "held", stage: "reported" } }), completed);
  });

  await s.step("A different outcome afterwards conflicts", async () => {
    await assert.rejects(asPlugin.reportOperation("fixture", held.id, { status: "failed", error: "late" }), rejectsWith(409, "terminal_operation"));
  });
});

scenario("A lost Plugin faults and its unfinished attempts are interrupted", async (s) => {
  const { operator, process } = await startWithPlugin(s, fixturePlugin);
  const submission = await s.step("Submit work the fixture holds in progress", () => prepare(s, operator, "fixture.work", { label: "held", hold: true }));
  const held = await s.transcript.unrecorded(async () => {
    const accepted = await operator.submitOperation("fixture", submission);
    await eventually(async () => (await operator.operation("fixture", accepted.id)).status === "in_progress", "in progress");
    return accepted;
  });

  await s.step("The Plugin process dies; Core records the loss", async () => {
    await process.kill();
    await s.transcript.unrecorded(() => eventually(async () => (await operator.plugin("fixture")).availability === "faulted", "a faulted Plugin"));
    const plugin = await operator.plugin("fixture");
    assert.match(plugin.fault, /lost contact/);
  });

  await s.step("The held attempt is interrupted, not completed", async () => {
    const operation = await operator.operation("fixture", held.id);
    assert.equal(operation.status, "interrupted");
    assert.deepEqual(operation.output, { label: "held", stage: "held" });
  });

  await s.step("New work is refused, and retrying the old submission returns the interrupted attempt", async () => {
    await assert.rejects(operator.submitOperation("fixture", await prepare(s, operator, "fixture.work", { label: "new" }, "new submission")), rejectsWith(409, "plugin_unavailable"));
    const retried = await operator.submitOperation("fixture", submission);
    assert.equal(retried.id, held.id);
    assert.equal(retried.status, "interrupted");
  });
});
