import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runContractTest } from "./supervisor.js";
import { assertPathRemoved, assertProcessGone, isProbeEvidence } from "./support.js";
import { withTimeoutFallback } from "./timeout-fallback.js";

export async function run(signal: AbortSignal) {
  for (const mode of ["async", "blocked", "startup"]) {
    if (signal.aborted) return;
    const evidence = await mkdtemp(join(tmpdir(), "atlas-timeout-evidence-"));
    const marker = join(evidence, "ready.json");
    let cancelled = false;
    await withTimeoutFallback(evidence, async (observe) => {
      const before = performance.now();
      const result = await runContractTest(fileURLToPath(new URL("timeout-probe.ts", import.meta.url)), {
        signal,
        timeoutMs: 2500,
        args: [mode, marker],
        onFixtureStarted: observe,
      });
      cancelled = result.cancelled;
      if (cancelled) return;
      assert(result.timedOut, `${mode}: actual outer deadline must fire`);
      assert.notEqual(result.status, 0);
      assert(performance.now() - before < 12000, "failure and cleanup finish within a finite bound");
      await assertPathRemoved(result.privateRoot);
      if (mode === "startup") {
        assert.equal(result.fixtures.length, 1, "timeout interrupts an actual launched fixture before readiness");
        const resource = result.fixtures[0];
        assert(resource && resource.pid !== undefined);
        assertProcessGone(resource.pid);
        await assertPathRemoved(resource.dataDir);
        console.log("PASS startup: outer deadline cleans the fixture while readiness is pending");
        return;
      }
      const state: unknown = JSON.parse(await readFile(marker, "utf8"));
      assert(isProbeEvidence(state), "actual HTTP/SQLite fixture was ready before the hang");
      assertProcessGone(state.pid, `${mode}: supervisor reaps the actual fixture before reporting completion`);
      await assertPathRemoved(state.dataDir);
      console.log(`PASS ${mode}: actual outer timeout reaps Go fixture and removes private SQLite/content directory`);
    });
    if (cancelled) return;
  }
}
