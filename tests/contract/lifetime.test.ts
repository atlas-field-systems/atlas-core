import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { FixtureStartupError, withFixture } from "./runner.js";

function requireStopped(pid: number) {
  assert.throws(() => process.kill(pid, 0), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "ESRCH");
}
async function requireRemoved(directory: string) {
  await assert.rejects(access(directory), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "ENOENT");
}

const normal = await withFixture(async ({ dataDir, pid }) => ({ dataDir, pid }));
requireStopped(normal.pid);
await requireRemoved(normal.dataDir);
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
  requireStopped(failure.pid);
  await requireRemoved(failure.dataDir);
  if (mode === "missing_readiness") assert.match(failure.message, /readiness timeout/u);
  else assert.match(failure.trace, /controlled fixture startup failure/u);
  console.log(`PASS ${mode}: finite failure, stopped process and removed private data`);
}
