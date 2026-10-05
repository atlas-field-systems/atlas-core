import assert from "node:assert/strict";
import { withFixture } from "./runner.js";
import seed from "./patch.fixtures.json" with { type: "json" };
import { dataset, headers, timedFetch, unallocatedRequestId, validateError } from "./support.js";

const fixtureId = "11111111-1111-4111-8111-111111111111";

// The fixture-only mode reaches generated binding/decoding errors that normal
// schema middleware intercepts earlier. Both run over HTTP with real SQLite.
for (const mode of ["normal", "request_hooks"] as const) {
  await withFixture(
    async ({ baseUrl }) => {
      const diagnostics = new Set<string>();
      for (const scenario of [
        { name: "path UUID", id: "sensitive-fixture-credential", body: '{"alias":"must not commit"}' },
        { name: "strict JSON decoder", id: fixtureId, body: '{"alias":"must not commit",' },
      ]) {
        const response = await timedFetch(`${baseUrl}/__fixture/patch/${scenario.id}`, {
          method: "PATCH",
          headers: { ...headers, "Content-Type": "application/json" },
          body: scenario.body,
        });
        assert.equal(response.status, 400, scenario.name);
        assert.equal(response.headers.get("Content-Type")?.split(";")[0], "application/json");
        const error: unknown = await response.json();
        assert(validateError(error), scenario.name);
        assert.equal(error.error.code, "invalid_request");
        assert.match(error.error.message, mode === "normal" ? /schema validation/ : /binding or JSON decoding/);
        assert.match(error.error.message, /PATCH \/__fixture\/patch\/\{fixture_id\}/);
        assert(!JSON.stringify(error).includes("sensitive"));
        assert.notEqual(error.error.request_id, unallocatedRequestId);
        assert(!diagnostics.has(error.error.request_id));
        diagnostics.add(error.error.request_id);
        const read = await timedFetch(`${baseUrl}/__fixture/patch/${fixtureId}`, { headers });
        assert.equal(read.status, 200);
        assert.deepEqual(await read.json(), { dataset_id: dataset, data: seed.initial });
      }
    },
    { mode },
  );
  console.log(`PASS ${mode}: malformed UUID/JSON rejection uses shared typed envelope without effects`);
}
