import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFixture, type OwnedFixture } from "./fixture-owner.js";
import { fixtureFailure, isFixtureCommand, type FixtureReply } from "./fixture-messages.js";

const loader = fileURLToPath(new URL("../../Atlas SDK/node_modules/tsx/dist/loader.mjs", import.meta.url));
export interface SupervisorOptions { timeoutMs?: number; args?: string[]; signal?: AbortSignal }

// One surviving owner runs each test worker and owns its real Go children.
// Worker termination cannot skip this owner's exit/reaping or directory cleanup.
export async function runContractTest(file: string, options: SupervisorOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Test deadline must be positive and finite");
  const privateRoot = await mkdtemp(join(tmpdir(), "atlas-contract-test-"));
  const startedFixtures: { pid: number | undefined; dataDir: string }[] = [];
  const fixtures = new Map<string, Promise<OwnedFixture | undefined>>();
  let closing = false;
  let timedOut = false;
  let cancelled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const controlErrors: unknown[] = [];
  const child = spawn(process.execPath, ["--import", loader, file, ...options.args ?? []],
    { stdio: ["inherit", "inherit", "inherit", "ipc"] });
  const send = (reply: FixtureReply) => {
    if (!child.connected || closing) return;
    child.send(reply, (error) => { if (error && !closing) controlErrors.push(error); });
  };
  child.on("message", (message: unknown) => {
    if (closing || !isFixtureCommand(message)) return;
    if (message.action === "start") {
      if (fixtures.has(message.id)) { send(fixtureFailure(message.id, new Error("Fixture start ID was reused"))); return; }
      // Register allocation before its first await, then gate launch after that
      // await. Deadline cleanup drains these entries before removing the root.
      const entry = (async () => {
        const dataDir = await mkdtemp(join(privateRoot, "fixture-"));
        if (closing) return undefined;
        const fixture = startFixture(dataDir, message.options);
        startedFixtures.push({ pid: fixture.pid, dataDir });
        return fixture;
      })();
      fixtures.set(message.id, entry);
      void (async () => {
        try {
          const fixture = await entry;
          if (fixture) send({ id: message.id, event: "ready", state: await fixture.ready });
        } catch (error) { send(fixtureFailure(message.id, error)); }
      })();
    } else {
      const entry = fixtures.get(message.id);
      if (!entry) { send({ id: message.id, event: "stopped" }); return; }
      void (async () => {
        let fixture: OwnedFixture | undefined;
        try {
          fixture = await entry;
          if (fixture) await fixture.stop();
          send({ id: message.id, event: "stopped" });
        } catch (error) { send(fixtureFailure(message.id, error)); }
        finally { if (!fixture || fixture.cleaned) fixtures.delete(message.id); }
      })();
    }
  });
  const stopWorker = () => {
    closing = true;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 2000);
    }
  };
  const cancel = () => { cancelled = true; stopWorker(); };
  const deadline = setTimeout(() => { timedOut = true; stopWorker(); }, timeoutMs);
  options.signal?.addEventListener("abort", cancel, { once: true });
  // Cancellation can arrive while the private root is being allocated, before
  // the listener exists. Recheck it before dispatching any worker messages.
  if (options.signal?.aborted) cancel();
  let outcome: { status: number | null; timedOut: boolean; cancelled: boolean } | undefined;
  let primary: unknown;
  try {
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    outcome = { status, timedOut, cancelled };
  } catch (error) { primary = error; }
  finally {
    closing = true;
    clearTimeout(deadline);
    clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", cancel);
  }
  const cleanupErrors: unknown[] = [...controlErrors];
  const pending = await Promise.allSettled(fixtures.values());
  let writersStopped = true;
  for (const entry of pending) {
    if (entry.status === "rejected") { cleanupErrors.push(entry.reason); continue; }
    if (!entry.value) continue;
    try { await entry.value.stop(); } catch (error) { cleanupErrors.push(error); }
    if (!entry.value.cleaned) writersStopped = false;
  }
  if (writersStopped) {
    try { await rm(privateRoot, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) {
    const failure = primary ?? new Error(timedOut ? `Test exceeded ${timeoutMs} ms deadline` : `Test worker exit ${outcome?.status}`);
    throw new AggregateError([failure, ...cleanupErrors], `Test failed with fixture cleanup errors; owned root ${privateRoot}`);
  }
  if (primary !== undefined) throw primary;
  if (!outcome) throw new Error("Test worker outcome unavailable");
  return { ...outcome, privateRoot, fixtures: startedFixtures };
}
