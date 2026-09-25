import assert from "node:assert/strict";

import { fixture } from "./harness/fixtures.mjs";
import { scenario } from "./harness/scenario.mjs";

scenario("Unsupported routes and methods return Protocol errors", async (s) => {
  const core = await s.startCore();
  const credential = core.installation.operatorKey;

  await s.step("An unknown route is not found", async () => {
    const response = await s.request(core, "/missing", { credential });
    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type"), /^application\/json/);
    assert.deepEqual(response.body, await fixture("not-found"));
  });

  await s.step("An unsupported method on a known route is not allowed", async () => {
    const response = await s.request(core, "/health", { method: "POST", credential });
    assert.equal(response.status, 405);
    assert.deepEqual(response.body, await fixture("method-not-allowed"));
  });
});
