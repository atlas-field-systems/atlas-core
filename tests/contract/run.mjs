import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { register } from "../../Atlas SDK/node_modules/tsx/dist/esm/api/index.mjs";

register();
const { runContractTest } = await import("./supervisor.ts");
const directory = fileURLToPath(new URL("./", import.meta.url));
const files = process.argv.length > 2 ? process.argv.slice(2) :
  readdirSync(directory).filter((name) => name.endsWith(".test.ts")).sort();
for (const file of files) {
  const result = await runContractTest(fileURLToPath(new URL(file, import.meta.url)));
  if (result.timedOut) throw new Error(`Contract test ${file} exceeded 120000 ms deadline`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
