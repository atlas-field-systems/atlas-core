// S1 runner. It is the surviving cleanup owner: each test worker receives a
// private run directory, and after the worker exits for any reason the runner
// removes every Core container of installations set up below that directory,
// then the directory itself.
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const loader = fileURLToPath(new URL("../../Atlas SDK/node_modules/tsx/dist/loader.mjs", import.meta.url));
const directory = fileURLToPath(new URL("./", import.meta.url));
const timeoutMs = 900_000;
const files =
  process.argv.length > 2
    ? process.argv.slice(2)
    : (await readdir(directory)).filter((name) => name.endsWith(".test.ts")).sort();

let active;
let interrupted = 0;
for (const [signal, status] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.on(signal, () => {
    interrupted ||= status;
    active?.kill("SIGTERM");
  });
}

async function installations(root) {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name === "manager.json") {
      const record = JSON.parse(await readFile(join(entry.parentPath, entry.name), "utf8"));
      found.push(record.installation_id);
    }
  }
  return found;
}

async function cleanup(root) {
  const failures = [];
  for (const id of await installations(root).catch((error) => (failures.push(error), []))) {
    try {
      const { stdout } = await run("docker", [
        "ps",
        "--all",
        "--quiet",
        "--filter",
        `label=com.atlas.installation=${id}`,
      ]);
      const containers = stdout.split("\n").filter(Boolean);
      if (containers.length > 0) await run("docker", ["rm", "--force", ...containers]);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) throw new AggregateError(failures, `S1 cleanup of ${root} failed`);
}

for (const file of files) {
  if (interrupted) break;
  const root = await mkdtemp(join(tmpdir(), "atlas-s1-"));
  const started = performance.now();
  let timedOut = false;
  const status = await new Promise((resolveExit) => {
    active = spawn(process.execPath, ["--import", loader, join(directory, file), root], { stdio: "inherit" });
    const timer = setTimeout(() => {
      timedOut = true;
      active.kill("SIGTERM");
    }, timeoutMs);
    active.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveExit(code ?? (signal ? 1 : 0));
    });
  });
  active = undefined;
  let cleanupError;
  try {
    await cleanup(root);
  } catch (error) {
    cleanupError = error;
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  if (timedOut) throw new Error(`S1 test ${file} exceeded ${timeoutMs} ms deadline`, { cause: cleanupError });
  if (status !== 0) {
    if (cleanupError) console.error(cleanupError);
    process.exitCode = status;
    break;
  }
  if (cleanupError) throw cleanupError;
  console.log(`PASS ${file} (${seconds} s, containers and files removed)`);
}
if (interrupted) process.exitCode = interrupted;
