import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FixtureStartupError, isReady, type FixtureOptions, type Ready } from "./fixture-messages.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
export interface OwnedFixture {
  readonly pid: number | undefined;
  readonly dataDir: string;
  ready: Promise<Ready & { dataDir: string; pid: number }>;
  stop(): Promise<void>;
  readonly cleaned: boolean;
}

// Only the surviving supervisor calls this. It already owns dataDir, so launch,
// readiness, shutdown and private-data removal stay in the same process.
export function startFixture(dataDir: string, options: FixtureOptions): OwnedFixture {
  const child = spawn(resolve(root, ".artifacts/contract-fixture"), ["--data-dir", dataDir, "--mode", options.mode ?? "normal"],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let trace = "";
  let output = "";
  let spawnError: Error | undefined;
  const exited = new Promise<number | null>((resolveExit) => {
    child.once("close", resolveExit);
    child.once("error", (error) => { spawnError = error; });
  });
  let readinessTimer: ReturnType<typeof setTimeout>;
  const ready = new Promise<Ready & { dataDir: string; pid: number }>((resolveReady, reject) => {
    readinessTimer = setTimeout(() => reject(new FixtureStartupError("fixture readiness timeout", dataDir, child.pid, trace)), options.startupMs ?? 5000);
    const fail = (message: string) => { clearTimeout(readinessTimer); reject(new FixtureStartupError(message, dataDir, child.pid, trace)); };
    child.once("error", (error) => fail(`fixture startup failed: ${error.message}`));
    child.once("exit", () => fail("fixture exited before readiness"));
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { trace = (trace + chunk).slice(-65536); });
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 65536) { fail("fixture readiness output exceeds bound"); return; }
      const lines = output.split("\n");
      output = lines.pop() ?? "";
      for (const line of lines) {
        let message: unknown;
        try { message = JSON.parse(line); } catch { fail("invalid fixture readiness JSON"); return; }
        if (isReady(message)) {
          clearTimeout(readinessTimer);
          if (child.pid === undefined) { fail("fixture PID unavailable"); return; }
          resolveReady({ ...message, dataDir, pid: child.pid });
        }
      }
    });
  });
  let cleaned = false;
  let stopPromise: Promise<void> | undefined;
  let exitReported = false;
  async function cleanup() {
    const errors: unknown[] = [];
    let stopped = false;
    clearTimeout(readinessTimer);
    try {
      if (child.exitCode === null && child.signalCode === null && !spawnError) child.kill("SIGTERM");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<"timeout">((resolveTimeout) => { timer = setTimeout(() => resolveTimeout("timeout"), 5000); });
      const result = await Promise.race([exited, grace]);
      clearTimeout(timer);
      if (result === "timeout") {
        child.kill("SIGKILL");
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([exited, new Promise<never>((_, reject) => {
            killTimer = setTimeout(() => reject(new Error(`fixture could not be terminated; retained ${dataDir}`)), 2000);
          })]);
          stopped = true;
        } finally { clearTimeout(killTimer); }
        throw new Error("fixture exceeded shutdown deadline");
      }
      stopped = true;
      if (!exitReported && result !== 0 && options.mode !== "startup_failure" && !spawnError) {
        exitReported = true;
        throw new Error(`fixture exit ${result}: ${trace}`);
      }
    } catch (error) { errors.push(error); }
    // Never remove a directory while its process may still be writing.
    if (stopped) {
      try { await rm(dataDir, { recursive: true, force: true }); cleaned = true; } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Fixture shutdown and private-data cleanup failed");
  }
  return { ready, pid: child.pid, dataDir, get cleaned() { return cleaned; }, stop() {
    if (cleaned) return Promise.resolve();
    // Concurrent timeout/finally cleanup shares one attempt. A failed removal can
    // be retried after the caller reports and repairs the filesystem failure.
    stopPromise ??= cleanup().catch((error: unknown) => { stopPromise = undefined; throw error; });
    return stopPromise;
  } };
}
