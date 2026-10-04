import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runContractTest } from "./supervisor.js";

function isReadyEvidence(value: unknown): value is { pid: number; dataDir: string; workerPid: number; sqliteVersion: string; journalMode: string } {
  return typeof value === "object" && value !== null && "pid" in value && typeof value.pid === "number" &&
    "workerPid" in value && typeof value.workerPid === "number" &&
    "dataDir" in value && typeof value.dataDir === "string" && "sqliteVersion" in value && value.sqliteVersion === "3.53.4" &&
    "journalMode" in value && value.journalMode === "wal";
}

const cancellation = new AbortController();
const pending = runContractTest(fileURLToPath(new URL("timeout-probe.ts", import.meta.url)), {
  signal: cancellation.signal, args: ["startup", "unused-marker"],
});
cancellation.abort();
const cancelled = await pending;
assert(cancelled.cancelled, "cancellation during root allocation is retained");
assert.notEqual(cancelled.status, 0);
assert.equal(cancelled.fixtures.length, 0, "cancelled allocation dispatches no fixture launch");
await assert.rejects(access(cancelled.privateRoot), { code: "ENOENT" });
console.log("PASS cancellation during private-root allocation drains without launching a fixture");

// A separate executable owns the fixture. This observer survives its signals
// and checks actual process/filesystem outcomes after real HTTP readiness.
for (const mode of ["async", "blocked", "startup"]) {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const evidence = await mkdtemp(join(tmpdir(), "atlas-interrupt-evidence-"));
    const privateTmp = join(evidence, "private");
    const marker = join(evidence, "ready.json");
    await mkdir(privateTmp);
    const runner = spawn(process.execPath, [fileURLToPath(new URL("run.mjs", import.meta.url)), "timeout-probe.ts"], {
      detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TMPDIR: privateTmp, ATLAS_CONTRACT_PROBE_MODE: mode, ATLAS_CONTRACT_PROBE_MARKER: marker },
    });
    let output = "";
    runner.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    runner.stderr.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    const exited = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      runner.once("close", (status, exitSignal) => resolve({ status, signal: exitSignal }));
      runner.once("error", reject);
    });
    let observed: { pid: number; dataDir: string; workerPid?: number } | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const readyDeadline = performance.now() + 10000;
      while (performance.now() < readyDeadline) {
        try {
          if (mode === "startup") {
            // Missing-readiness startup cannot supply the worker marker. On the
            // supported Linux profile, observe its real child and SQLite files.
            assert(runner.pid !== undefined);
            const children = await readFile(`/proc/${runner.pid}/task/${runner.pid}/children`, "utf8");
            for (const pid of children.trim().split(/\s+/u).filter(Boolean).map(Number)) {
              if (await readlink(`/proc/${pid}/exe`) !== fileURLToPath(new URL("../../.artifacts/contract-fixture", import.meta.url))) continue;
              for (const root of await readdir(privateTmp)) {
                if (!root.startsWith("atlas-contract-test-")) continue;
                for (const fixture of await readdir(join(privateTmp, root))) {
                  if (!fixture.startsWith("fixture-")) continue;
                  const dataDir = join(privateTmp, root, fixture);
                  await access(join(dataDir, "fixture.sqlite"));
                  observed = { pid, dataDir };
                }
              }
            }
          } else {
            const state: unknown = JSON.parse(await readFile(marker, "utf8"));
            assert(isReadyEvidence(state), "real HTTP/SQLite readiness evidence is complete");
            observed = state;
          }
          if (observed) break;
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert(observed, `fixture must reach ${mode === "startup" ? "pending readiness" : "HTTP readiness"} before interruption: ${output}`);
      assert(runner.pid !== undefined);
      const before = performance.now();
      process.kill(signal === "SIGINT" ? -runner.pid : runner.pid, signal);
      const outcome = await Promise.race([exited, new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error(`interrupted runner did not exit: ${output}`)), 12000);
      })]);
      assert(performance.now() - before < 12000, "interruption and cleanup have a finite deadline");
      const fixturePid = observed.pid;
      assert.throws(() => process.kill(fixturePid, 0), (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "ESRCH", "interrupted runner reaps the real Go fixture");
      if (observed.workerPid !== undefined) {
        const workerPid = observed.workerPid;
        assert.throws(() => process.kill(workerPid, 0), (error: unknown) =>
          error instanceof Error && "code" in error && error.code === "ESRCH", "interrupted runner stops its test worker");
      }
      await assert.rejects(access(observed.dataDir), { code: "ENOENT" });
      await assert.rejects(access(dirname(observed.dataDir)), { code: "ENOENT" });
      assert.deepEqual(outcome, { status: signal === "SIGTERM" ? 143 : 130, signal: null }, output);
      console.log(`PASS ${mode}/${signal}: executable interruption reaps Go and removes both private directory levels`);
    } finally {
      clearTimeout(deadline);
      // Red runs must not leave the reproduced serving process or private data.
      if (runner.pid !== undefined) {
        try { process.kill(-runner.pid, "SIGKILL"); } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        }
      }
      await exited;
      await rm(evidence, { recursive: true, force: true });
    }
  }
}
