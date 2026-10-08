import type { ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { hasErrorCode } from "./support.js";

export interface TimeoutFixture {
  child: ChildProcess;
  pid: number;
  dataDir: string;
  privateRoot: string;
}

interface CleanupOptions {
  signal?: (child: ChildProcess, signal: "SIGTERM" | "SIGKILL") => void;
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
  const fixtures = new Map<ChildProcess, TimeoutFixture>();
  const errors: unknown[] = [];
  try {
    await work((fixture) => fixtures.set(fixture.child, fixture));
  } catch (error) {
    errors.push(error);
  }

  const retained: string[] = [];
  const directories = new Set<string>();
  const signal = options.signal ?? ((child, name) => child.kill(name));
  const removeDirectory = options.removeDirectory ?? ((path) => rm(path, { recursive: true, force: true }));
  for (const fixture of fixtures.values()) {
    directories.add(fixture.dataDir);
    directories.add(fixture.privateRoot);
    let stopped = false;
    const signalError = (error: Error) => errors.push(error);
    fixture.child.on("error", signalError);
    for (const name of ["SIGTERM", "SIGKILL"] as const) {
      // The surviving owner may already have reaped this child, including during
      // a preceding wait. Its numeric PID can then belong to another process.
      stopped = hasExited(fixture.child);
      if (stopped) break;
      try {
        signal(fixture.child, name);
      } catch (error) {
        if (!hasErrorCode(error, "ESRCH")) errors.push(error);
      }
      try {
        stopped = await waitForExit(fixture.child);
      } catch (error) {
        errors.push(error);
      }
      if (stopped) break;
    }
    fixture.child.off("error", signalError);
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

function hasExited(child: ChildProcess) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(child: ChildProcess) {
  const deadline = performance.now() + shutdownGraceMs;
  while (true) {
    if (hasExited(child)) return true;
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await delay(Math.min(20, remaining));
  }
}

function contains(directory: string, path: string) {
  const descendant = relative(directory, path);
  return descendant === "" || (!isAbsolute(descendant) && descendant !== ".." && !descendant.startsWith(`..${sep}`));
}
