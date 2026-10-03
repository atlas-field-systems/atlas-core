import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("./", import.meta.url));
const tsx = fileURLToPath(new URL("../../Atlas SDK/node_modules/tsx/dist/cli.mjs", import.meta.url));
for (const file of readdirSync(directory).filter((name) => name.endsWith(".test.ts")).sort()) {
  const result = spawnSync(process.execPath, [tsx, fileURLToPath(new URL(file, import.meta.url))],
    { stdio: "inherit", timeout: 120_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
