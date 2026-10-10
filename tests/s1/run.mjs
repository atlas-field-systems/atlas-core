import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { register } from "../../Atlas SDK/node_modules/tsx/dist/esm/api/index.mjs";

register();
const { runContractTest } = await import("../contract/supervisor.ts");
const { checkTLSFixtureLifetime } = await import("./fixture-lifetime.ts");
const files =
  process.argv.length > 2
    ? process.argv.slice(2)
    : readdirSync(fileURLToPath(new URL("./", import.meta.url)))
        .filter((name) => name.endsWith(".test.ts"))
        .sort();
const cancellation = new AbortController();
let interruptedStatus = 0;
const stop = (status) => {
  interruptedStatus ||= status;
  cancellation.abort();
};
const sigint = () => stop(130);
const sigterm = () => stop(143);
process.on("SIGINT", sigint);
process.on("SIGTERM", sigterm);
try {
  if (process.argv.length === 2) await checkTLSFixtureLifetime(cancellation.signal);
  for (const file of files) {
    if (cancellation.signal.aborted) break;
    const result = await runContractTest(fileURLToPath(new URL(file, import.meta.url)), {
      signal: cancellation.signal,
      providePrivateRoot: true,
    });
    if (result.cancelled) break;
    if (result.timedOut || result.status !== 0)
      throw new Error(`S1 test ${file} failed: timeout=${result.timedOut}, status=${result.status}`);
  }
} finally {
  process.off("SIGINT", sigint);
  process.off("SIGTERM", sigterm);
}
if (interruptedStatus) process.exitCode = interruptedStatus;
