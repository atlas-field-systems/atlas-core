import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runContractTest } from "./supervisor.js";
import { assertPathRemoved, assertProcessGone, hasErrorCode, within } from "./support.js";
import { withTimeoutFallback, type TimeoutFixture } from "./timeout-fallback.js";

export async function run(signal: AbortSignal) {
  // These cases qualify the observer's fallback, rather than the ordinary
  // supervisor. Signaling faults leave a real writer running, and removal faults
  // come from an actual nonempty-directory refusal. Liveness is never mocked.
  for (const fault of ["signal", "remove", "grace", "refusal", "ancestor"]) {
    if (signal.aborted) return;
    const privateRoot = await mkdtemp(join(tmpdir(), "atlas-fallback-writer-"));
    const dataDir = join(privateRoot, "data");
    await mkdir(dataDir);
    const evidence = fault === "ancestor" ? privateRoot : await mkdtemp(join(tmpdir(), "atlas-fallback-evidence-"));
    const writer = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { writeFileSync } from "node:fs";
         const path = process.argv[1];
         if (process.argv[2] === "grace") process.on("SIGTERM", () => {});
         let count = 0;
         const write = () => writeFileSync(path, String(++count));
         write();
         console.log("ready");
         setInterval(write, 10);`,
        join(dataDir, "writer-state"),
        fault === "grace" ? "grace" : "normal",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const exited = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      writer.once("close", (status, exitSignal) => resolve({ status, signal: exitSignal }));
      writer.once("error", reject);
    });
    const cancel = () => writer.kill("SIGKILL");
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    const primary = new Error(`original timeout assertion: ${fault}`);
    const signalingFailure = Object.assign(new Error("controlled signal permission refusal"), { code: "EPERM" });
    let outcome: { ok: true } | { ok: false; error: unknown };
    try {
      await within(
        new Promise<void>((resolve, reject) => {
          writer.stdout.once("data", () => resolve());
          writer.once("error", reject);
          writer.once("exit", () => reject(new Error("writer exited before readiness")));
        }),
        5000,
        "real fallback writer did not become ready",
      );
      assert(writer.pid !== undefined);
      const resource = { pid: writer.pid, dataDir, privateRoot };
      await access(join(dataDir, "writer-state"));
      const before = performance.now();
      const refusal = fault === "refusal" || fault === "ancestor";
      await assert.rejects(
        () =>
          withTimeoutFallback(
            evidence,
            async (observe) => {
              observe(resource);
              throw primary;
            },
            {
              signal(pid, name) {
                if (refusal || (fault === "signal" && name === "SIGTERM")) throw signalingFailure;
                process.kill(pid, name);
              },
              removeDirectory(path) {
                // Unlike a fake rm result, rmdir actually refuses this nonempty
                // directory. The containing root must not bypass that refusal.
                return fault === "remove" && path === dataDir
                  ? rmdir(path)
                  : rm(path, { recursive: true, force: true });
              },
            },
          ),
        (error: unknown) => {
          if (fault === "grace") {
            assert.equal(error, primary);
          } else {
            assert(error instanceof AggregateError);
            assert.equal(error.errors[0], primary, "the original assertion remains the first failure");
            if (fault === "remove") assert(error.errors.some((failure: unknown) => hasErrorCode(failure, "ENOTEMPTY")));
            else assert(error.errors.includes(signalingFailure));
            if (refusal)
              assert(
                error.errors.some(
                  (failure: unknown) =>
                    failure instanceof Error && /could not be stopped; retained/u.test(failure.message),
                ),
              );
          }
          return true;
        },
      );
      assert(performance.now() - before < 6000, "fallback has bounded graceful and forced termination phases");
      if (refusal) {
        process.kill(resource.pid, 0);
        await access(join(dataDir, "writer-state"));
        await access(privateRoot);
        if (fault === "ancestor") await access(evidence);
        else await assertPathRemoved(evidence, "independent evidence cleanup still runs after stop refusal");
      } else {
        assertProcessGone(resource.pid);
        if (fault === "remove") {
          await access(dataDir);
          await access(privateRoot);
        } else {
          await assertPathRemoved(dataDir);
          await assertPathRemoved(privateRoot);
        }
        await assertPathRemoved(evidence, "independent evidence cleanup still runs after a removal failure");
        const stopped = await exited;
        assert.equal(stopped.signal, fault === "grace" || fault === "signal" ? "SIGKILL" : "SIGTERM");
      }
      outcome = { ok: true };
    } catch (error) {
      outcome = { ok: false, error };
    }
    signal.removeEventListener("abort", cancel);
    // This independent child owner contains red runs too. Awaiting close proves
    // that the writer is reaped before any retained storage is removed.
    const cleanupErrors: unknown[] = [];
    let stopped = false;
    try {
      if (writer.exitCode === null && writer.signalCode === null) cancel();
      await within(exited, 5000, "fallback regression writer could not be reaped; storage retained");
      stopped = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (stopped) {
      for (const path of new Set([privateRoot, evidence])) {
        try {
          await rm(path, { recursive: true, force: true });
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }
    if (!outcome.ok) cleanupErrors.unshift(outcome.error);
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Fallback regression or observer cleanup failed");
    console.log(`PASS ${fault}: real fallback writer and storage preserve the specified failure and cleanup outcome`);
  }

  if (signal.aborted) return;
  const evidence = await mkdtemp(join(tmpdir(), "atlas-fallback-started-"));
  const original = new Error("fixture observer fails before supervisor result");
  let observed: TimeoutFixture | undefined;
  await assert.rejects(
    () =>
      withTimeoutFallback(evidence, async (observe) => {
        await runContractTest(fileURLToPath(new URL("timeout-probe.ts", import.meta.url)), {
          signal,
          timeoutMs: 2500,
          args: ["async", join(evidence, "ready.json")],
          onFixtureStarted(resource) {
            observed = resource;
            observe(resource);
            throw original;
          },
        });
      }),
    (error: unknown) => {
      assert(error instanceof AggregateError);
      assert(error.errors.includes(original));
      return true;
    },
  );
  assert(observed, "launch observer receives real Go ownership before the failing supervisor completes");
  assertProcessGone(observed.pid);
  await assertPathRemoved(observed.dataDir);
  await assertPathRemoved(observed.privateRoot);
  await assertPathRemoved(evidence);
  console.log("PASS failed launch observer retains real Go cleanup ownership and its original error");
}
