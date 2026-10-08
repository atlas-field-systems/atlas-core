import { rm } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { hasErrorCode } from "./support.js";

export interface TimeoutFixture {
  pid: number;
  dataDir: string;
  privateRoot: string;
}

interface CleanupOptions {
  signal?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  removeDirectory?: (path: string) => Promise<void>;
}

const shutdownGraceMs = 2000;

// The observer survives the workflow it checks. Keep its fallback within that
// owner, preserving failed assertions and every independent cleanup failure.
export async function withTimeoutFallback(
  evidenceDirectory: string,
  work: (observe: (fixture: TimeoutFixture) => void) => Promise<void>,
  options: CleanupOptions = {},
) {
  const fixtures = new Map<number, TimeoutFixture>();
  const errors: unknown[] = [];
  try {
    await work((fixture) => fixtures.set(fixture.pid, fixture));
  } catch (error) {
    errors.push(error);
  }

  const retained: string[] = [];
  const directories = new Set<string>();
  const signal = options.signal ?? ((pid, name) => process.kill(pid, name));
  const removeDirectory = options.removeDirectory ?? ((path) => rm(path, { recursive: true, force: true }));
  for (const fixture of fixtures.values()) {
    directories.add(fixture.dataDir);
    directories.add(fixture.privateRoot);
    let stopped = false;
    for (const name of ["SIGTERM", "SIGKILL"] as const) {
      try {
        signal(fixture.pid, name);
      } catch (error) {
        if (!hasErrorCode(error, "ESRCH")) errors.push(error);
      }
      try {
        stopped = await waitForExit(fixture.pid);
      } catch (error) {
        errors.push(error);
      }
      if (stopped) break;
    }
    if (!stopped) {
      retained.push(fixture.dataDir);
      errors.push(new Error(`Timeout fixture ${fixture.pid} could not be stopped; retained ${fixture.dataDir}`));
    }
  }

  directories.add(evidenceDirectory);
  for (const directory of [...directories].sort((left, right) => right.split(sep).length - left.split(sep).length)) {
    // An ancestor removal must not bypass a failed stop or child removal.
    if (retained.some((path) => contains(directory, path))) continue;
    try {
      await removeDirectory(directory);
    } catch (error) {
      retained.push(directory);
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Timeout workflow and fallback cleanup failed");
}

async function waitForExit(pid: number) {
  const deadline = performance.now() + shutdownGraceMs;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (hasErrorCode(error, "ESRCH")) return true;
      throw error;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await delay(Math.min(20, remaining));
  }
}

function contains(directory: string, path: string) {
  const descendant = relative(directory, path);
  return descendant === "" || (!isAbsolute(descendant) && descendant !== ".." && !descendant.startsWith(`..${sep}`));
}
