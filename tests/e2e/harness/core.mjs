import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { track } from "./processes.mjs";

const run = promisify(execFile);
export const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// Covers a cold Go build on the first scenario of a run.
const listenTimeoutMs = 10_000;

let binaries;

/**
 * Uses the binaries scripts/test-e2e.sh built for the whole run, or builds
 * them once for this test file when a file is run on its own.
 */
function buildBinaries() {
  const shared = process.env.ATLAS_E2E_BIN_DIR;
  if (shared) return Promise.resolve({ core: path.join(shared, "atlas-core"), ctl: path.join(shared, "atlasctl") });
  binaries ??= (async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "atlas-e2e-bin-"));
    const core = path.join(dir, "atlas-core");
    const ctl = path.join(dir, "atlasctl");
    const cwd = path.join(repository, "core");
    await run("go", ["build", "-o", core, "./cmd/atlas-core"], { cwd });
    await run("go", ["build", "-o", ctl, "./cmd/atlasctl"], { cwd });
    return { core, ctl };
  })();
  return binaries;
}

/** A temporary local installation set up through atlasctl. */
export class Installation {
  static async create() {
    const root = await mkdtemp(path.join(os.tmpdir(), "atlas-e2e-"));
    const installation = new Installation(root, await buildBinaries());
    await installation.atlasctl("setup");
    installation.operatorKey = (await readFile(installation.firstKeyFile, "utf8")).trim();
    installation.enrollmentKey = (await readFile(path.join(installation.setupDir, "enrollment-key"), "utf8")).trim();
    return installation;
  }

  constructor(root, bins) {
    this.root = root;
    this.bins = bins;
  }

  get setupDir() { return path.join(this.root, "state", "setup"); }
  get operationalDir() { return path.join(this.root, "state", "operational"); }
  get firstKeyFile() { return path.join(this.setupDir, "first-key"); }

  async atlasctl(...args) {
    const { stdout } = await run(this.bins.ctl, ["-root", this.root, ...args]);
    return stdout;
  }

  /** Starts Core. env adds Core settings such as ATLAS_CHANGE_RETENTION. */
  async start(env = {}) {
    const child = track(spawn(this.bins.core, [], {
      env: { ...process.env, ATLAS_SETUP_DIR: this.setupDir, ATLAS_OPERATIONAL_DIR: this.operationalDir, ATLAS_LISTEN_ADDR: "127.0.0.1:0", ...env },
      stdio: ["ignore", "pipe", "inherit"],
    }));
    const address = await listenAddress(child);
    return new CoreProcess(this, child, `http://${address}`);
  }

  async remove() {
    await rm(this.root, { recursive: true, force: true });
  }
}

/** One running Core process. */
export class CoreProcess {
  constructor(installation, child, baseUrl) {
    this.installation = installation;
    this.child = child;
    this.baseUrl = baseUrl;
  }

  /** Stops Core with SIGTERM and waits for it to exit. Safe to call twice. */
  async stop() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = once(this.child, "exit");
    this.child.kill("SIGTERM");
    await exited;
  }
}

function listenAddress(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => finish(new Error("Core did not report its listen address")), listenTimeoutMs);
    const onData = (chunk) => {
      output += chunk;
      const match = output.match(/LISTEN_ADDR=(\S+)\n/);
      if (match) finish(null, match[1]);
    };
    const onExit = () => finish(new Error("Core exited before listening"));
    function finish(error, address) {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(address);
    }
    child.stdout.on("data", onData);
    child.once("exit", onExit);
    child.once("error", finish);
  });
}
