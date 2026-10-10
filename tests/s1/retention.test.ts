import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openExecutionStore } from "../../examples/s1/execution-store.js";

test("external execution evidence survives replacement without another execution", async () => {
  const index = process.argv.indexOf("--owned-root");
  const directory = await mkdtemp(
    join(index < 0 ? tmpdir() : (process.argv[index + 1] ?? tmpdir()), "atlas-execution-"),
  );
  await using _cleanup = { [Symbol.asyncDispose]: () => rm(directory, { recursive: true, force: true }) };
  const original = await openExecutionStore(directory);
  await original.loadTasks(["completed", "running", "suspended", "uncertain", "continuation"]);
  const eventTime = "2026-10-10T10:00:00.500+00:00";
  await original.start("completed", eventTime, { processGeneration: "1", sequence: "4" });
  await original.distance("completed", 5.1, eventTime);
  assert.equal(original.snapshot("completed").state, "running");
  await original.distance("completed", 4.9, eventTime);
  assert.equal(original.snapshot("completed").state, "completed");
  await original.start("running", eventTime, { processGeneration: "1", sequence: "4" });
  await original.start("suspended", eventTime, null);
  await original.suspend("suspended", eventTime);
  await original.start("uncertain", eventTime, null);
  await original.loseEvidence("uncertain", ["continuation"]);
  const replaced = await openExecutionStore(directory);
  assert.deepEqual(replaced.snapshots(), original.snapshots());
  assert.equal(replaced.snapshot("completed").executionCount, 1);
  assert.equal(replaced.snapshot("completed").eventTime, eventTime);
  await assert.rejects(replaced.start("completed", eventTime, null));
  await replaced.start("running", eventTime, null);
  await replaced.start("suspended", eventTime, null);
  assert.equal(replaced.snapshot("running").executionCount, 1);
  assert.equal(replaced.snapshot("suspended").executionCount, 1);
  await assert.rejects(replaced.start("uncertain", eventTime, null));
  await assert.rejects(replaced.start("continuation", eventTime, null));
  await replaced.recover("uncertain", { state: "running", eventTime, progress: { distanceRemainingM: 20 } });
  await replaced.start("continuation", eventTime, null);
  assert.equal(replaced.snapshot("continuation").executionCount, 1);
  assert.equal(replaced.snapshot("uncertain").executionCount, 1);
  assert.equal(replaced.snapshot("running").origin?.sequence, "4");
});
