import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runContractTest } from "../contract/supervisor.js";

type Readiness = { workerPid: number; privateRoot: string; tlsDirectory: string };

async function readiness(marker: string, signal: AbortSignal): Promise<Readiness> {
  const deadline = Date.now() + 15000;
  for (;;) {
    signal.throwIfAborted();
    try {
      const value: unknown = JSON.parse(await readFile(marker, "utf8"));
      if (
        typeof value !== "object" ||
        value === null ||
        !("workerPid" in value) ||
        !Number.isSafeInteger(value.workerPid) ||
        typeof value.workerPid !== "number" ||
        value.workerPid <= 0 ||
        !("privateRoot" in value) ||
        typeof value.privateRoot !== "string" ||
        !("tlsDirectory" in value) ||
        typeof value.tlsDirectory !== "string"
      )
        throw new Error("TLS lifetime marker is invalid");
      return { workerPid: value.workerPid, privateRoot: value.privateRoot, tlsDirectory: value.tlsDirectory };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      if (Date.now() >= deadline) throw new Error("TLS lifetime probe did not become ready");
      await delay(25, undefined, { signal });
    }
  }
}

export async function checkTLSFixtureLifetime(signal: AbortSignal): Promise<void> {
  await using control = {
    root: await mkdtemp(join(tmpdir(), "atlas-s1-tls-owner-")),
    async [Symbol.asyncDispose]() {
      await rm(this.root, { recursive: true, force: true });
    },
  };
  const probe = fileURLToPath(new URL("./fixture-lifetime-probe.ts", import.meta.url));
  for (const schedule of ["worker_death", "deadline", "cancellation"] as const) {
    if (signal.aborted) return;
    const marker = join(control.root, `${schedule}.json`);
    const cancellation = new AbortController();
    const running = runContractTest(probe, {
      args: [marker],
      providePrivateRoot: true,
      timeoutMs: schedule === "deadline" ? 5000 : 20000,
      signal: AbortSignal.any([signal, cancellation.signal]),
    }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      const ready = await readiness(marker, signal);
      assert.equal(dirname(ready.tlsDirectory), ready.privateRoot);
      assert.ok((await stat(join(ready.tlsDirectory, "server.key"))).isFile());
      assert.ok((await stat(join(ready.tlsDirectory, "server.pem"))).isFile());
      if (schedule === "worker_death") process.kill(ready.workerPid, "SIGKILL");
      if (schedule === "cancellation") cancellation.abort();
      const completion = await running;
      if ("error" in completion) throw completion.error;
      const { result } = completion;
      assert.equal(result.privateRoot, ready.privateRoot);
      assert.equal(result.timedOut, schedule === "deadline");
      assert.equal(result.cancelled, schedule === "cancellation");
      assert.equal(result.status, null);
      await assert.rejects(stat(ready.tlsDirectory), { code: "ENOENT" });
      await assert.rejects(stat(result.privateRoot), { code: "ENOENT" });
      console.log(`PASS S1 nested TLS ${schedule}: private keys removed by surviving owner`);
    } catch (error) {
      cancellation.abort();
      const completion = await running;
      if ("error" in completion && completion.error !== error)
        throw new AggregateError([error, completion.error], "TLS lifetime schedule and cleanup failed");
      if (signal.aborted && !("error" in completion)) return;
      throw error;
    }
  }
}
