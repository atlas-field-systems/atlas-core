import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runContractTest } from "./supervisor.js";

function readyEvidence(value: unknown): value is { pid: number; dataDir: string; sqliteVersion: string; journalMode: string } {
  return typeof value === "object" && value !== null && "pid" in value && typeof value.pid === "number" &&
    "dataDir" in value && typeof value.dataDir === "string" && "sqliteVersion" in value && value.sqliteVersion === "3.53.4" &&
    "journalMode" in value && value.journalMode === "wal";
}
export async function run(signal: AbortSignal) {
  for (const mode of ["async", "blocked", "startup"]) {
    if (signal.aborted) return;
    const evidence = await mkdtemp(join(tmpdir(), "atlas-timeout-evidence-"));
    const marker = join(evidence, "ready.json");
    let observed: { pid: number; dataDir: string } | undefined;
    try {
      const before = performance.now();
      const result = await runContractTest(fileURLToPath(new URL("timeout-probe.ts", import.meta.url)), { signal, timeoutMs: 2500, args: [mode, marker] });
      if (result.cancelled) return;
      assert(result.timedOut, `${mode}: actual outer deadline must fire`);
      assert.notEqual(result.status, 0);
      assert(performance.now() - before < 12000, "failure and cleanup finish within a finite bound");
      await assert.rejects(access(result.privateRoot), { code: "ENOENT" });
      if (mode === "startup") {
        assert.equal(result.fixtures.length, 1, "timeout interrupts an actual launched fixture before readiness");
        const resource = result.fixtures[0];
        assert(resource && resource.pid !== undefined);
        observed = { dataDir: resource.dataDir, pid: resource.pid };
        const pid = resource.pid;
        assert.throws(() => process.kill(pid, 0), (error: unknown) => error instanceof Error && "code" in error && error.code === "ESRCH");
        await assert.rejects(access(resource.dataDir), { code: "ENOENT" });
        console.log("PASS startup: outer deadline cleans the fixture while readiness is pending");
        continue;
      }
      const state: unknown = JSON.parse(await readFile(marker, "utf8"));
      assert(readyEvidence(state), "actual HTTP/SQLite fixture was ready before the hang");
      observed = state;
      assert.throws(() => process.kill(state.pid, 0), (error: unknown) => error instanceof Error && "code" in error && error.code === "ESRCH",
        `${mode}: supervisor reaps the actual fixture before reporting completion`);
      await assert.rejects(access(state.dataDir), { code: "ENOENT" });
      console.log(`PASS ${mode}: actual outer timeout reaps Go fixture and removes private SQLite/content directory`);
    } finally {
      // Failed red runs still leave no resources after the independent observer.
      if (observed) {
        try { process.kill(observed.pid, "SIGTERM"); } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        }
        for (let attempt = 0; attempt < 100; attempt++) {
          try { process.kill(observed.pid, 0); } catch { break; }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await rm(observed.dataDir, { recursive: true, force: true });
      }
      await rm(evidence, { recursive: true, force: true });
    }
  }
}
