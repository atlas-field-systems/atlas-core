import assert from "node:assert/strict";
import { FixtureStartupError, withFixture } from "./runner.js";
import { assertPathRemoved, assertProcessGone } from "./support.js";

const normal = await withFixture(async ({ dataDir, pid }) => ({ dataDir, pid }));
assertProcessGone(normal.pid);
await assertPathRemoved(normal.dataDir);
console.log("PASS normal fixture completion stops process and removes private data");

for (const mode of ["missing_readiness", "startup_failure"] as const) {
  let failure: FixtureStartupError | undefined;
  try {
    await withFixture(async () => assert.fail("failed fixture must never dispatch workflow"), { mode, startupMs: 1000 });
    assert.fail("fixture startup control must fail");
  } catch (error) {
    assert(error instanceof FixtureStartupError);
    failure = error;
  }
  assert(failure.pid !== undefined);
  assertProcessGone(failure.pid);
  await assertPathRemoved(failure.dataDir);
  if (mode === "missing_readiness") assert.match(failure.message, /readiness timeout/u);
  else assert.match(failure.trace, /controlled fixture startup failure/u);
  console.log(`PASS ${mode}: finite failure, stopped process and removed private data`);
}
