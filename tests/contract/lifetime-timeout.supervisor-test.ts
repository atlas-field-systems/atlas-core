import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runContractTest } from "./supervisor.js";
import { assertPathRemoved, assertProcessGone, hasErrorCode, isProbeEvidence } from "./support.js";

export async function run(signal: AbortSignal) {
  for (const mode of ["async", "blocked", "startup"]) {
    if (signal.aborted) return;
    const evidence = await mkdtemp(join(tmpdir(), "atlas-timeout-evidence-"));
    const marker = join(evidence, "ready.json");
    let observed: { pid: number; dataDir: string } | undefined;
    try {
      const before = performance.now();
      const result = await runContractTest(fileURLToPath(new URL("timeout-probe.ts", import.meta.url)), {
        signal,
        timeoutMs: 2500,
        args: [mode, marker],
      });
      if (result.cancelled) return;
      assert(result.timedOut, `${mode}: actual outer deadline must fire`);
      assert.notEqual(result.status, 0);
      assert(performance.now() - before < 12000, "failure and cleanup finish within a finite bound");
      await assertPathRemoved(result.privateRoot);
      if (mode === "startup") {
        assert.equal(result.fixtures.length, 1, "timeout interrupts an actual launched fixture before readiness");
        const resource = result.fixtures[0];
        assert(resource && resource.pid !== undefined);
        observed = { dataDir: resource.dataDir, pid: resource.pid };
        assertProcessGone(resource.pid);
        await assertPathRemoved(resource.dataDir);
        console.log("PASS startup: outer deadline cleans the fixture while readiness is pending");
        continue;
      }
      const state: unknown = JSON.parse(await readFile(marker, "utf8"));
      assert(isProbeEvidence(state), "actual HTTP/SQLite fixture was ready before the hang");
      observed = state;
      assertProcessGone(state.pid, `${mode}: supervisor reaps the actual fixture before reporting completion`);
      await assertPathRemoved(state.dataDir);
      console.log(`PASS ${mode}: actual outer timeout reaps Go fixture and removes private SQLite/content directory`);
    } finally {
      // Failed red runs still leave no resources after the independent observer.
      if (observed) {
        try {
          process.kill(observed.pid, "SIGTERM");
        } catch (error) {
          if (!hasErrorCode(error, "ESRCH")) throw error;
        }
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            process.kill(observed.pid, 0);
          } catch {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await rm(observed.dataDir, { recursive: true, force: true });
      }
      await rm(evidence, { recursive: true, force: true });
    }
  }
}
