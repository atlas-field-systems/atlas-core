import assert from "node:assert/strict";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFixture } from "./runner.js";

const observedFixtures: { dataDir: string; pid: number }[] = [];
for (const mode of ["fixture exit", "directory removal"]) {
  const original = new Error(`original workflow assertion: ${mode}`);
  let directory = "";
  let locked = "";
  let fixturePid = 0;
  try {
    await assert.rejects(() => withFixture(async ({ pid, dataDir }) => {
      directory = dataDir;
      observedFixtures.push({ dataDir, pid });
      fixturePid = pid;
      if (mode === "fixture exit") {
        process.kill(pid, "SIGKILL");
      } else {
        locked = join(dataDir, "locked");
        await mkdir(locked);
        await writeFile(join(locked, "content"), "controlled permission failure");
        await chmod(locked, 0);
      }
      throw original;
    }, { unprivilegedRemoval: mode === "directory removal" }), (error: unknown) => {
      assert(error instanceof AggregateError, "workflow and cleanup failures are both observable");
      assert(error.errors.includes(original), "original error identity is retained");
      assert.equal(error.errors.length, 2);
      assert(error.errors.some((failure: unknown) => failure instanceof Error && (mode === "fixture exit" ?
        /fixture exit/u.test(failure.message) : "code" in failure && failure.code === "EACCES")));
      assert.throws(() => process.kill(fixturePid, 0), { code: "ESRCH" }, "Go fixture is reaped before removal refusal");
      return true;
    });
  } finally {
    if (locked) await chmod(locked, 0o700);
    if (directory) await rm(directory, { recursive: true, force: true });
  }
  console.log(`PASS original assertion and ${mode} error are preserved together`);
}

// A separate surviving parent observes the supervisor's final retry and root
// removal after this worker exits, under both root and unprivileged execution.
const marker = process.env.ATLAS_CONTRACT_CLEANUP_MARKER;
if (marker) await writeFile(marker, JSON.stringify(observedFixtures));
