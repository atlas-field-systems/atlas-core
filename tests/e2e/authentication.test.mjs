import assert from "node:assert/strict";
import { stat } from "node:fs/promises";

import { AtlasError } from "../../sdk/dist/index.js";
import { fixture } from "./harness/fixtures.mjs";
import { scenario } from "./harness/scenario.mjs";

scenario("Operational access requires a valid credential", async (s) => {
  const core = await s.startCore();
  const key = core.installation.operatorKey;

  await s.step("Setup retains the first credential in an owner-only file", async () => {
    const mode = (await stat(core.installation.firstKeyFile)).mode & 0o777;
    s.transcript.observe("first-key file mode", mode.toString(8));
    assert.equal(mode, 0o600);
  });

  await s.step("An anonymous request is rejected", async () => {
    const response = await s.request(core, "/health");
    assert.equal(response.status, 401);
    assert.deepEqual(response.body, await fixture("unauthorized"));
  });

  await s.step("An unknown credential is rejected without echoing it", async () => {
    const wrong = s.client(core, "wrong-credential", "unknown credential");
    await assert.rejects(wrong.dataset(), (error) =>
      error instanceof AtlasError && error.status === 401 && !error.message.includes("wrong-credential"));
  });

  await s.step("The operator credential reads health through the SDK and directly", async () => {
    const sdk = await s.client(core, key).health();
    const direct = await s.request(core, "/health", { credential: key });
    assert.deepEqual(sdk, await fixture("health"));
    assert.deepEqual(direct.body, sdk);
  });

  await s.step("Dataset discovery agrees between the SDK and a direct request", async () => {
    const sdk = await s.client(core, key).dataset();
    const direct = await s.request(core, "/dataset", { credential: key });
    assert.match(sdk.id, /^[0-9a-f-]{36}$/);
    assert.equal(sdk.writing_release, "0.1.0");
    assert.deepEqual(direct.body, sdk);
  });
});
