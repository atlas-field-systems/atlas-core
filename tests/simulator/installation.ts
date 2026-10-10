// Local installation driver shared by the S1 demonstration and tests. It runs
// the real atlas-manage CLI, so setup and lifecycle use the same private
// host-management implementation an administrator uses.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { AtlasClient } from "../../Atlas SDK/src/index.js";
import { nodeFetch } from "../../Atlas SDK/src/node.js";
import type { Link } from "./reporting.js";

const root = resolve(import.meta.dirname, "../..");
// scripts/build_core.py builds the CLI over the shared private host-management
// implementation and loads the Core image.
const manageBinary = join(root, ".artifacts/atlas-manage");
export const coreImage = "atlas-core:dev";
// Every request has a finite deadline.
export const requestTimeoutMs = 15_000;

export class ManageError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number | null,
    readonly stderr: string,
    readonly result: unknown,
  ) {
    super(`atlas-manage ${command} failed (${exitCode}): ${stderr.trim()}`);
  }
}

// manage runs the same CLI an administrator uses, over the shared private
// host-management implementation.
export function manage(installation: { root: string; recovery: string }, command: string, ...args: string[]) {
  return manageWith(installation, {}, command, ...args);
}

// manageWith runs the CLI with extra environment, such as a private fault
// adapter ahead of the real docker client on PATH.
export function manageWith(
  installation: { root: string; recovery: string },
  env: Readonly<Record<string, string>>,
  command: string,
  ...args: string[]
) {
  return new Promise<unknown>((resolveCall, reject) => {
    execFile(
      manageBinary,
      [command, "--root", installation.root, "--recovery", installation.recovery, ...args],
      { timeout: 180_000, maxBuffer: 4 << 20, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        let result: unknown;
        try {
          result = stdout.trim() === "" ? undefined : JSON.parse(stdout);
        } catch {
          result = stdout;
        }
        if (error) {
          reject(new ManageError(command, typeof error.code === "number" ? error.code : null, stderr, result));
          return;
        }
        resolveCall(result);
      },
    );
  });
}

export function record(value: unknown): Readonly<Record<string, unknown>> {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), "expected a JSON object");
  return Object.fromEntries(Object.entries(value));
}

export function text(value: unknown, name: string): string {
  assert.equal(typeof value, "string", `${name} is a string`);
  return String(value);
}

export async function freePort() {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  assert(address !== null && typeof address === "object");
  return address.port;
}

export interface InstallationOptions {
  readonly port?: number;
  readonly testFaults?: boolean;
  readonly serverCertificate?: string;
  readonly serverKey?: string;
  readonly hostnames?: readonly string[];
}

// Installation is one real local installation: owned root, external recovery
// storage, Core container, SQLite and files.
export class Installation {
  readonly root: string;
  readonly recovery: string;
  readonly adminKeyFile: string;
  readonly enrollmentAuthorityFile: string;
  private caPem: string | undefined;

  private constructor(
    directory: string,
    readonly port: number,
    readonly installationId: string,
  ) {
    this.root = join(directory, "root");
    this.recovery = join(directory, "recovery");
    this.adminKeyFile = join(directory, "deployment", "admin.key");
    this.enrollmentAuthorityFile = join(directory, "deployment", "enrollment-authority.pem");
  }

  // create runs setup through the CLI in a new directory below parent.
  // Secrets are generated into owner-only files, never passed as arguments.
  static async create(parent: string, options: InstallationOptions = {}) {
    const directory = join(parent, randomUUID());
    const installation = new Installation(directory, options.port ?? (await freePort()), randomUUID());
    await mkdir(join(directory, "deployment"), { recursive: true, mode: 0o700 });
    await installation.setup(options);
    return installation;
  }

  async setup(options: InstallationOptions = {}) {
    const args = [
      "--installation-id",
      this.installationId,
      "--image",
      coreImage,
      "--port",
      String(this.port),
      "--admin-key-file",
      this.adminKeyFile,
      "--enrollment-authority-file",
      this.enrollmentAuthorityFile,
    ];
    if (options.testFaults) args.push("--test-faults");
    if (options.serverCertificate !== undefined) args.push("--server-certificate", options.serverCertificate);
    if (options.serverKey !== undefined) args.push("--server-key", options.serverKey);
    for (const hostname of options.hostnames ?? []) args.push("--hostname", hostname);
    return record(await manage(this, "setup", ...args));
  }

  get baseUrl() {
    return `https://127.0.0.1:${this.port}`;
  }

  async ca() {
    this.caPem ??= await readFile(text(record(await manage(this, "ca")).certificate, "CA path"), "utf8");
    return this.caPem;
  }

  async adminKey() {
    return (await readFile(this.adminKeyFile, "utf8")).trim();
  }

  start() {
    return manage(this, "start").then(record);
  }
  stop() {
    return manage(this, "stop").then(record);
  }
  restart() {
    return manage(this, "restart").then(record);
  }
  reset(actionId = randomUUID()) {
    return manage(this, "reset", "--action-id", actionId).then(record);
  }
  inspect() {
    return manage(this, "inspect").then(record);
  }
  async activity(): Promise<readonly Readonly<Record<string, unknown>>[]> {
    const result = await manage(this, "activity");
    assert(Array.isArray(result), "activity is a list");
    return result.map(record);
  }
  armFault(operation: string, count = 1) {
    return manage(this, "arm-fault", "--operation", operation, "--count", String(count));
  }

  // authorizeEnrollment is deployment tooling: it signs one Asset's
  // enrollment with the retained enrollment authority.
  async authorizeEnrollment(assetId: string, recoveryPublicKey: string) {
    const result = record(
      await manage(
        this,
        "authorize-enrollment",
        "--enrollment-authority-file",
        this.enrollmentAuthorityFile,
        "--asset-id",
        assetId,
        "--recovery-public-key",
        recoveryPublicKey,
      ),
    );
    return text(result.token, "enrollment token");
  }

  // fetch trusts only this installation's CA with ordinary verification.
  async fetch() {
    return nodeFetch({ ca: await this.ca() });
  }

  // link is a direct, verified HTTPS path to Core for simulated Assets.
  async link(): Promise<Link> {
    return { baseUrl: this.baseUrl, fetch: await this.fetch(), requestTimeoutMs };
  }

  async operator(baseUrl = this.baseUrl, options: { timeoutMs?: number } = {}) {
    const key = await this.adminKey();
    return new AtlasClient({
      baseUrl,
      fetch: await this.fetch(),
      requestTimeoutMs: options.timeoutMs ?? requestTimeoutMs,
      authentication: () => ({ bearer: key }),
    });
  }
}
