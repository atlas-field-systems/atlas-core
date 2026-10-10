import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest, type Server as HttpsServer } from "node:https";
import type { Socket } from "node:net";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { AtlasError, type components, type MutationOutcome } from "../../Atlas SDK/src/index.js";
import { prepareAsset, ReportingProcess, type CommandManifest, type Link } from "../simulator/index.js";
import { Installation, record, requestTimeoutMs, text, type InstallationOptions } from "../simulator/installation.js";

export type Schemas = components["schemas"];

// The same Core built under another writing release.
export const releaseProbeImage = "atlas-core:release-probe";

// runDirectory is the private directory the surviving runner owns and cleans,
// including any containers of installations created below it.
export function runDirectory() {
  const directory = process.argv[2];
  if (directory === undefined) throw new Error("Run S1 tests through tests/s1/run.mjs, which owns cleanup");
  return directory;
}

export {
  coreImage,
  freePort,
  Installation,
  ManageError,
  manage,
  manageWith,
  record,
  requestTimeoutMs,
  text,
} from "../simulator/installation.js";
export type { InstallationOptions } from "../simulator/installation.js";

// newInstallation sets up an installation below the runner-owned directory.
export function newInstallation(options: InstallationOptions = {}) {
  return Installation.create(runDirectory(), options);
}

// directProtocol is the independent oracle client for an installation, with
// its administrator credential.
export async function directProtocol(installation: Installation, baseUrl = installation.baseUrl) {
  return new DirectProtocol(baseUrl, await installation.ca(), await installation.adminKey());
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
// answers; hold keeps mutations undelivered until release(); tamper delivers
// mutations and replaces Core's answer with a schema-invalid one. Reads such
// as discovery always pass in the mutation modes.
export type ProxyMode = "pass" | "refuse" | "drop_response" | "stall" | "hold" | "tamper";

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
    // The relay only ever reaches Core: the upstream host and port are fixed,
    // and only an origin-form request target is forwarded as the path.
    const path = incoming.url ?? "";
    if (!path.startsWith("/") || path.startsWith("//")) {
      outgoing.writeHead(400).end();
      return;
    }
    const upstream = httpsRequest(
      {
        host: "127.0.0.1",
        port: this.target.port,
        path,
        method: incoming.method,
        headers,
        ca: this.ca,
        agent: false,
        timeout: requestTimeoutMs,
      },
      (response) => {
        const reply: Buffer[] = [];
        response.on("data", (chunk: Buffer) => reply.push(chunk));
        response.on("end", () => {
          if (mode === "stall") return;
          if (mode === "tamper") {
            const forged = Buffer.from("{}");
            outgoing.writeHead(response.statusCode ?? 502, {
              "content-type": "application/json",
              "content-length": String(forged.length),
            });
            outgoing.end(forged);
            return;
          }
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
