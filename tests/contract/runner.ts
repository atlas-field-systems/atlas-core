import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
interface Ready {
  event: "ready";
  baseUrl: string;
  sqliteVersion: string;
  journalMode: string;
}

function isReady(value: unknown): value is Ready {
  return typeof value === "object" && value !== null &&
    "event" in value && value.event === "ready" &&
    "baseUrl" in value && typeof value.baseUrl === "string" &&
    "sqliteVersion" in value && typeof value.sqliteVersion === "string" &&
    "journalMode" in value && typeof value.journalMode === "string";
}

export class FixtureStartupError extends Error {
  constructor(message: string, readonly dataDir: string, readonly pid: number | undefined, readonly trace: string) {
    super(message);
    this.name = "FixtureStartupError";
  }
}

export interface FixtureOptions {
  mode?: "normal" | "missing_readiness" | "startup_failure";
  startupMs?: number;
}

// The runner owns the directory before process launch. Cleanup therefore works
// even when the child exits early or never publishes readiness.
export async function withFixture<T>(workflow: (ready: Ready & { dataDir: string; pid: number }) => Promise<T>, options: FixtureOptions = {}): Promise<T> {
  const dataDir = await mkdtemp(resolve(tmpdir(), "atlas-contract-"));
  const child = spawn(resolve(root, ".artifacts/contract-fixture"), ["--data-dir", dataDir, "--mode", options.mode ?? "normal"],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let trace = "";
  let output = "";
  let spawnError: Error | undefined;
  const exited = new Promise<number | null>((resolveExit) => {
    child.once("exit", (code) => resolveExit(code));
    child.once("error", (error) => { spawnError = error; resolveExit(null); });
  });
  const ready = new Promise<Ready>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new FixtureStartupError("fixture readiness timeout", dataDir, child.pid, trace)), options.startupMs ?? 5000);
    const fail = (message: string) => { clearTimeout(timer); reject(new FixtureStartupError(message, dataDir, child.pid, trace)); };
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
        if (isReady(message)) { clearTimeout(timer); resolveReady(message); }
      }
    });
  });
  try {
    const state = await ready;
    if (child.pid === undefined) throw new FixtureStartupError("fixture PID unavailable", dataDir, child.pid, trace);
    return await workflow({ ...state, dataDir, pid: child.pid });
  } finally {
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
            killTimer = setTimeout(() => reject(new Error("fixture could not be terminated")), 2000);
          })]);
        } finally { clearTimeout(killTimer); }
        throw new Error("fixture exceeded shutdown deadline");
      }
      if (result !== 0 && options.mode !== "startup_failure" && !spawnError) {
        throw new Error(`fixture exit ${result}: ${trace}`);
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}
