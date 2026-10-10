import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest, type Server as HttpsServer } from "node:https";
import { createServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { AtlasClient, AtlasError, type components, type MutationOutcome } from "../../Atlas SDK/src/index.js";
import { nodeFetch } from "../../Atlas SDK/src/node.js";
import { prepareAsset, ReportingProcess, type CommandManifest, type Link } from "../simulator/index.js";

export type Schemas = components["schemas"];

const root = resolve(import.meta.dirname, "../..");
// The runner builds this from the shared management implementation.
const manageBinary = join(root, ".artifacts/atlas-manage");
export const coreImage = "atlas-core:dev";
// Every request in these tests has a finite deadline.
export const requestTimeoutMs = 15_000;

// runDirectory is the private directory the surviving runner owns and cleans,
// including any containers of installations created below it.
export function runDirectory() {
  const directory = process.argv[2];
  if (directory === undefined) throw new Error("Run S1 tests through tests/s1/run.mjs, which owns cleanup");
  return directory;
}

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
  return new Promise<unknown>((resolveCall, reject) => {
    execFile(
      manageBinary,
      [command, "--root", installation.root, "--recovery", installation.recovery, ...args],
      { timeout: 180_000, maxBuffer: 4 << 20 },
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

  // create runs non-test setup through the CLI. Secrets are generated into
  // owner-only files, never passed as arguments.
  static async create(options: InstallationOptions = {}) {
    const directory = join(runDirectory(), randomUUID());
    const installation = new Installation(directory, await freePort(), randomUUID());
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

  async operator(baseUrl = this.baseUrl, fetch?: (request: Request) => Promise<Response>) {
    const key = await this.adminKey();
    return new AtlasClient({
      baseUrl,
      fetch: fetch ?? (await this.fetch()),
      requestTimeoutMs,
      authentication: () => ({ bearer: key }),
    });
  }

  async direct(baseUrl = this.baseUrl) {
    return new DirectProtocol(baseUrl, await this.ca(), await this.adminKey());
  }
}

export interface DirectResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly raw: Buffer;
  readonly wire: Buffer;
  readonly body: unknown;
}

export interface DirectRequest {
  readonly headers?: Readonly<Record<string, string>>;
  readonly json?: unknown;
  readonly body?: Buffer | string;
  readonly bearer?: string | null;
}

// DirectProtocol is the independent oracle path: hand-built HTTPS requests
// with node:https, without the SDK's transport, validation or coding.
export class DirectProtocol {
  datasetId: string | undefined;
  protocolVersion = "0.0.0";

  constructor(
    readonly baseUrl: string,
    readonly ca: string,
    readonly bearer: string,
  ) {}

  async discover() {
    const health = await this.request("GET", "/health");
    assert.equal(health.status, 200, "authenticated health");
    this.datasetId = text(record(health.body).dataset_id, "dataset_id");
    return health;
  }

  context(): Record<string, string> {
    assert(this.datasetId !== undefined, "discover first");
    return { "Atlas-Dataset-ID": this.datasetId, "Atlas-Protocol-Version": this.protocolVersion };
  }

  request(method: string, path: string, options: DirectRequest = {}) {
    const url = new URL(path, this.baseUrl);
    const headers: Record<string, string> = { ...options.headers };
    const bearer = options.bearer === undefined ? this.bearer : options.bearer;
    if (bearer !== null) headers.Authorization = `Bearer ${bearer}`;
    let payload: Buffer | undefined;
    if (options.json !== undefined) {
      payload = Buffer.from(JSON.stringify(options.json));
      headers["Content-Type"] ??= "application/json";
    } else if (options.body !== undefined) {
      payload = Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body);
    }
    return new Promise<DirectResponse>((resolveRequest, reject) => {
      const outgoing = httpsRequest(
        url,
        { method, headers, ca: this.ca, timeout: requestTimeoutMs, agent: false },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () => {
            const wire = Buffer.concat(chunks);
            const encoding = response.headers["content-encoding"];
            const raw = encoding === "gzip" ? gunzipSync(wire) : wire;
            const flat: Record<string, string> = {};
            for (const [name, value] of Object.entries(response.headers)) {
              if (value !== undefined) flat[name] = Array.isArray(value) ? value.join(", ") : value;
            }
            let body: unknown;
            if ((flat["content-type"] ?? "").startsWith("application/json") && raw.length > 0) {
              body = JSON.parse(raw.toString("utf8"));
            }
            resolveRequest({ status: response.statusCode ?? 0, headers: flat, raw, wire, body });
          });
        },
      );
      outgoing.on("timeout", () => outgoing.destroy(new Error("direct request deadline elapsed")));
      outgoing.on("error", reject);
      outgoing.end(payload);
    });
  }
}

export function errorCode(response: DirectResponse) {
  return text(record(record(response.body).error).code, "error code");
}

// pass relays; refuse drops connections; drop_response delivers each mutation
// and discards Core's complete answer; stall delivers mutations and never
// answers; hold keeps mutations undelivered until release(). Reads such as
// discovery always pass in the mutation modes.
export type ProxyMode = "pass" | "refuse" | "drop_response" | "stall" | "hold";

const hopByHop = new Set(["connection", "keep-alive", "transfer-encoding", "host", "content-length"]);

// FaultProxy is an HTTPS relay in front of Core that presents the
// installation's own server certificate, so clients keep ordinary CA and
// hostname verification. It can refuse connections, or deliver a request and
// discard Core's complete response so the caller cannot tell whether Core
// committed.
export class FaultProxy {
  mode: ProxyMode = "pass";
  // Requests whose responses were discarded, in delivery order.
  readonly dropped: string[] = [];
  private readonly sockets = new Set<Socket>();
  private listening = 0;
  private held: (() => void)[] = [];
  // Resolves when the next held request is waiting.
  private onHeld: (() => void) | undefined;

  private constructor(
    private readonly server: HttpsServer,
    private readonly target: Installation,
    private readonly ca: string,
  ) {}

  static async start(target: Installation) {
    const tls = join(target.root, "setup", "core", "tls");
    const [cert, key] = await Promise.all([readFile(join(tls, "server.crt")), readFile(join(tls, "server.key"))]);
    let proxy: FaultProxy | undefined;
    const server = createHttpsServer({ cert, key }, (incoming, outgoing) => {
      if (proxy) proxy.relay(incoming, outgoing);
    });
    proxy = new FaultProxy(server, target, await target.ca());
    const sockets = proxy.sockets;
    server.on("secureConnection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      if (proxy?.mode === "refuse") socket.destroy();
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    assert(address !== null && typeof address === "object");
    proxy.listening = address.port;
    return proxy;
  }

  get baseUrl() {
    return `https://127.0.0.1:${this.listening}`;
  }

  // set changes the mode and severs existing connections so a pooled
  // connection cannot bypass it.
  set(mode: ProxyMode) {
    this.mode = mode;
    for (const socket of this.sockets) socket.destroy();
  }

  // nextHeld resolves once a request is held undelivered.
  nextHeld() {
    if (this.held.length > 0) return Promise.resolve();
    return new Promise<void>((resolveHeld) => {
      this.onHeld = resolveHeld;
    });
  }

  // release delivers every held request to Core now.
  release() {
    const held = this.held;
    this.held = [];
    this.mode = "pass";
    for (const deliver of held) deliver();
  }

  async close() {
    this.set("refuse");
    await new Promise<void>((resolveClose) => this.server.close(() => resolveClose()));
  }

  private relay(incoming: IncomingMessage, outgoing: ServerResponse) {
    const mode = this.mode;
    if (mode === "refuse") {
      outgoing.socket?.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      if (incoming.method === "GET") {
        this.forward(incoming, outgoing, Buffer.concat(chunks), "pass");
        return;
      }
      if (mode === "hold") {
        this.held.push(() => this.forward(incoming, outgoing, Buffer.concat(chunks), "pass"));
        this.onHeld?.();
        this.onHeld = undefined;
        return;
      }
      this.forward(incoming, outgoing, Buffer.concat(chunks), mode);
    });
  }

  private forward(incoming: IncomingMessage, outgoing: ServerResponse, body: Buffer, mode: ProxyMode) {
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value !== undefined && !hopByHop.has(name)) headers[name] = value;
    }
    headers["content-length"] = String(body.length);
    const upstream = httpsRequest(
      new URL(incoming.url ?? "/", this.target.baseUrl),
      { method: incoming.method, headers, ca: this.ca, agent: false, timeout: requestTimeoutMs },
      (response) => {
        const reply: Buffer[] = [];
        response.on("data", (chunk: Buffer) => reply.push(chunk));
        response.on("end", () => {
          if (mode === "stall") return;
          if (mode === "drop_response") {
            // Core finished the request; its answer is lost in transit.
            this.dropped.push(`${incoming.method} ${incoming.url}`);
            outgoing.socket?.destroy();
            return;
          }
          const replyHeaders: Record<string, string | string[]> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            if (value !== undefined && !hopByHop.has(name)) replyHeaders[name] = value;
          }
          outgoing.writeHead(response.statusCode ?? 502, replyHeaders);
          outgoing.end(Buffer.concat(reply));
        });
      },
    );
    upstream.on("timeout", () => upstream.destroy(new Error("relay deadline elapsed")));
    upstream.on("error", () => outgoing.socket?.destroy());
    upstream.end(body);
  }
}

// waitFor polls an observable condition with a deadline; it replaces sleeps.
export async function waitFor<T>(
  description: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
}

export function step(message: string) {
  console.log(`PASS ${message}`);
}

// acceptedOutcome returns an accepted mutation's value and status, reporting
// any other outcome with its typed details.
export function acceptedOutcome<T>(outcome: MutationOutcome<T>, message: string) {
  if (outcome.outcome !== "accepted") assert.fail(`${message}: ${JSON.stringify(outcome)}`);
  return outcome;
}

export function rejectionCode(outcome: MutationOutcome<unknown>, message: string) {
  if (outcome.outcome !== "rejected") assert.fail(`${message} should be rejected: ${JSON.stringify(outcome)}`);
  return outcome.rejection.code;
}

// establishedAsset enrolls, registers and claims process authority for one
// simulated Asset, with optional initial check-in data.
export async function establishedAsset(
  installation: Installation,
  options: {
    alias?: string | null;
    commandManifest?: CommandManifest;
    link?: Link;
    checkIn?: Parameters<ReportingProcess["establish"]>[0];
  } = {},
) {
  const os = await prepareAsset(runDirectory(), (assetId, key) => installation.authorizeEnrollment(assetId, key), {
    ...(options.alias === undefined ? {} : { alias: options.alias }),
    ...(options.commandManifest === undefined ? {} : { commandManifest: options.commandManifest }),
  });
  const process = new ReportingProcess(os, options.link ?? (await installation.link()));
  acceptedOutcome(await process.register(), "registration");
  acceptedOutcome(await process.establish(options.checkIn), "process-authority claim");
  return { os, process };
}

// moveTo is the independent S1 coordinate Move To input.
export function moveTo(latitude: number, longitude: number) {
  return { command: "move_to" as const, target: { kind: "position" as const, position: { latitude, longitude } } };
}

// failsWith is an assert.rejects predicate for an SDK read failure code.
export function failsWith(code: string) {
  return (error: unknown) => error instanceof AtlasError && error.code === code;
}

// sameInstant compares a read timestamp with a source timestamp. Reads return
// the original instant in RFC 3339 form; the original spelling remains in
// signed and compared report facts.
export function sameInstant(actual: string | null | undefined, expected: string | null | undefined, message: string) {
  assert(typeof actual === "string" && typeof expected === "string", `${message}: both instants are present`);
  assert.equal(Date.parse(actual), Date.parse(expected), message);
}
