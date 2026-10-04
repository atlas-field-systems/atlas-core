import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { register } from "../../Atlas SDK/node_modules/tsx/dist/esm/api/index.mjs";

register();
const { runContractTest } = await import("./supervisor.ts");
const directory = fileURLToPath(new URL("./", import.meta.url));
const files = process.argv.length > 2 ? process.argv.slice(2) :
  readdirSync(directory).filter((name) => name.endsWith(".test.ts")).sort();
const cancellation = new AbortController();
let interruptedStatus = 0;
const interrupt = (status) => {
  interruptedStatus ||= status;
  cancellation.abort();
};
const sigint = () => interrupt(130);
const sigterm = () => interrupt(143);
process.on("SIGINT", sigint);
process.on("SIGTERM", sigterm);
try {
  for (const file of files) {
    if (cancellation.signal.aborted) break;
    const result = await runContractTest(fileURLToPath(new URL(file, import.meta.url)), { signal: cancellation.signal });
    if (result.cancelled) break;
    if (result.timedOut) throw new Error(`Contract test ${file} exceeded 120000 ms deadline`);
    if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
  }
} catch (error) {
  if (!interruptedStatus) throw error;
  console.error(error);
} finally {
  process.off("SIGINT", sigint);
  process.off("SIGTERM", sigterm);
}
if (interruptedStatus) process.exitCode = interruptedStatus;
