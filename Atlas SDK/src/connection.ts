import createTransport, { type Client, type Middleware } from "openapi-fetch";
import protocol from "../generated/protocol.json" with { type: "json" };
import type { components, paths } from "../generated/protocol.js";
import { AtlasError, type MutationOutcome, type Rejection } from "./errors.js";
import { responseValidation, ResponseValidationError } from "./response.js";

type Schemas = components["schemas"];

// Protocol editions this SDK release implements: the installed canonical
// Protocol artifact's edition.
export const implementedEditions: readonly string[] = Object.freeze([protocol.info.version]);

export interface ConnectionOptions {
  readonly baseUrl: string;
  // Supplies the caller's authentication for each request: a bearer
  // credential, or deployment enrollment authorization before first
  // Enrollment. Credentials never enter URLs, cursors or results.
  readonly authentication?: () => Authentication | undefined | Promise<Authentication | undefined>;
  // Transport for HTTPS. Node callers supply trust with nodeFetch({ ca }).
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly requestTimeoutMs?: number;
  readonly maxJSONBytes?: number;
  // Editions to negotiate; defaults to the editions this SDK implements.
  readonly editions?: readonly string[];
}

export interface Discovery {
  readonly datasetId: string;
  readonly protocolVersion: string;
  readonly coreRelease: string;
  readonly responseTime: string;
  // The authenticated principal; absent when discovery used enrollment
  // authorization, which instead names the authorized Asset.
  readonly principal?: Schemas["Actor"];
  readonly enrollmentAssetId?: string;
  readonly acceptsGzip: boolean;
  readonly contactChallenge?: Schemas["ContactChallenge"];
}

export interface Session extends Discovery {
  readonly transport: Client<paths>;
  // Context headers every operational request carries.
  readonly headers: { readonly "Atlas-Dataset-ID": string; readonly "Atlas-Protocol-Version": string };
}

const defaultTimeoutMs = 10_000;
const defaultMaxJSONBytes = 4 << 20;

function released(version: string) {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.exec(version);
  return match ? match.slice(1).map(Number) : undefined;
}

// selectEdition chooses the highest released SemVer edition both sides
// support. Matching a major number alone is not compatibility.
export function selectEdition(local: readonly string[], remote: readonly string[]): string | undefined {
  const common = local.filter((edition) => remote.includes(edition) && released(edition));
  common.sort((a, b) => {
    const left = released(a) ?? [];
    const right = released(b) ?? [];
    for (let index = 0; index < 3; index++) {
      const difference = (left[index] ?? 0) - (right[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return 0;
  });
  return common.at(-1);
}

// The complete eligible size of one JSON message: body bytes, its
// Content-Length field line and, when coded, its Content-Encoding field line.
// Core applies the same accounting to responses.
export function encodedMessageSize(bodyBytes: number, gzipped: boolean) {
  const size = bodyBytes + "Content-Length: \r\n".length + String(bodyBytes).length;
  return gzipped ? size + "Content-Encoding: gzip\r\n".length : size;
}

export async function gzip(body: Uint8Array) {
  const stream = new Blob([new Uint8Array(body)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Selects gzip for a JSON request body only when Core declared support and
// the complete eligible message is smaller. The signed report is produced
// before compression; Core decompresses before validation and verification.
function requestCoding(acceptsGzip: boolean): Middleware {
  return {
    async onRequest({ request }) {
      if (!acceptsGzip || request.body === null || request.headers.has("Content-Encoding")) return request;
      const body = new Uint8Array(await request.clone().arrayBuffer());
      if (body.byteLength === 0) return request;
      const encoded = await gzip(body);
      if (encodedMessageSize(encoded.byteLength, true) >= encodedMessageSize(body.byteLength, false)) return request;
      const headers = new Headers(request.headers);
      headers.set("Content-Encoding", "gzip");
      return new Request(request.url, { method: request.method, headers, body: encoded, signal: request.signal });
    },
  };
}

export type Authentication = { readonly bearer: string } | { readonly enrollment: string };

function authorization(authentication: ConnectionOptions["authentication"]): Middleware {
  return {
    async onRequest({ request }) {
      // A retained registration descriptor carries its own enrollment
      // authorization, so its retries authenticate as first prepared.
      if (request.headers.has("Atlas-Enrollment")) return request;
      const current = await authentication?.();
      if (current === undefined) return request;
      if ("bearer" in current) request.headers.set("Authorization", `Bearer ${current.bearer}`);
      else request.headers.set("Atlas-Enrollment", current.enrollment);
      return request;
    },
  };
}

function acceptsRequestGzip(value: string | null) {
  return (value ?? "").split(",").some((coding) => coding.split(";")[0]?.trim().toLowerCase() === "gzip");
}

// commitCursorOf reads a validated mutation envelope's committed cursor.
export function commitCursorOf(data: { commit_cursor?: string } | undefined) {
  if (data?.commit_cursor === undefined)
    throw new AtlasError("protocol_error", "Mutation response has no committed cursor");
  return data.commit_cursor;
}

// rejectionOf narrows a validated Core error body.
function rejectionOf(error: unknown, status: number): Rejection {
  if (typeof error === "object" && error !== null && "error" in error) {
    const info = error.error;
    if (typeof info === "object" && info !== null && "code" in info && "message" in info) {
      const details =
        "details" in info && typeof info.details === "object" && info.details !== null
          ? { ...info.details }
          : undefined;
      return {
        code: String(info.code),
        message: String(info.message),
        status,
        ...(details === undefined ? {} : { details }),
      };
    }
  }
  return { code: "protocol_error", message: "Core returned an undeclared error", status };
}

export function currentDatasetOf(rejection: Rejection) {
  const current = rejection.details?.["current_dataset_id"];
  return typeof current === "string" ? current : undefined;
}

// Connection owns discovery, the selected edition, the current Dataset
// boundary and outcome classification. Every request has a finite deadline.
export class Connection {
  readonly options: ConnectionOptions;
  private current: Session | undefined;
  private readonly fetch: (request: Request) => Promise<Response>;

  constructor(options: ConnectionOptions) {
    this.options = options;
    const base = options.fetch ?? ((request: Request) => fetch(request));
    this.fetch = base;
  }

  get timeoutMs() {
    return this.options.requestTimeoutMs ?? defaultTimeoutMs;
  }

  private signal() {
    return AbortSignal.timeout(this.timeoutMs);
  }

  // discover authenticates health without a Dataset precondition, negotiates
  // the edition and binds a session to the current Dataset.
  async discover(challenge?: { assetId: string; generation: string }): Promise<Session> {
    const transport = createTransport<paths>({ baseUrl: this.options.baseUrl, fetch: this.fetch });
    transport.use(authorization(this.options.authentication));
    transport.use(
      responseValidation(
        protocol,
        { datasetId: undefined, protocolVersion: "" },
        { maxJSONBytes: this.options.maxJSONBytes ?? defaultMaxJSONBytes },
      ),
    );
    let result;
    try {
      result = await transport.GET("/health", {
        params: challenge
          ? { query: { challenge_asset_id: challenge.assetId, challenge_generation: challenge.generation } }
          : {},
        signal: this.signal(),
      });
    } catch (error) {
      throw transportError(error);
    }
    if (result.error !== undefined || result.data === undefined) {
      const rejection = rejectionOf(result.error, result.response.status);
      throw new AtlasError(rejection.code, rejection.message, rejection.status, rejection.details);
    }
    const health = result.data.data;
    const protocolVersion = selectEdition(
      this.options.editions ?? implementedEditions,
      health.supported_protocol_versions,
    );
    if (protocolVersion === undefined) {
      throw new AtlasError("protocol_unsupported", "Core and this SDK share no released Protocol edition");
    }
    const datasetId = result.data.dataset_id;
    const acceptsGzip = acceptsRequestGzip(result.response.headers.get("Accept-Encoding"));
    const session: Session = {
      datasetId,
      protocolVersion,
      coreRelease: health.core_release,
      responseTime: health.response_time,
      ...(health.principal === undefined ? {} : { principal: health.principal }),
      ...(health.enrollment_asset_id === undefined ? {} : { enrollmentAssetId: health.enrollment_asset_id }),
      acceptsGzip,
      ...(health.contact_challenge === undefined ? {} : { contactChallenge: health.contact_challenge }),
      transport: this.operational(datasetId, protocolVersion, acceptsGzip),
      headers: { "Atlas-Dataset-ID": datasetId, "Atlas-Protocol-Version": protocolVersion },
    };
    this.current = session;
    return session;
  }

  private operational(datasetId: string, protocolVersion: string, acceptsGzip: boolean) {
    const transport = createTransport<paths>({
      baseUrl: this.options.baseUrl,
      fetch: this.fetch,
      headers: { "Atlas-Dataset-ID": datasetId, "Atlas-Protocol-Version": protocolVersion },
    });
    transport.use(authorization(this.options.authentication));
    transport.use(requestCoding(acceptsGzip));
    transport.use(
      responseValidation(
        protocol,
        { datasetId, protocolVersion },
        { maxJSONBytes: this.options.maxJSONBytes ?? defaultMaxJSONBytes },
      ),
    );
    return transport;
  }

  // session returns the current session, discovering it first if needed.
  async session(): Promise<Session> {
    return this.current ?? (await this.discover());
  }

  // known is the current session without discovery.
  get known(): Session | undefined {
    return this.current;
  }

  // changedDataset rediscovers after a response refused for its Dataset or
  // edition context, returning Core's current Dataset when it differs from
  // the session's. A failed rediscovery establishes nothing.
  private async changedDataset(session: Session, error: unknown): Promise<string | undefined> {
    if (!(error instanceof ResponseValidationError) || error.reason !== "context") return undefined;
    let current: Discovery;
    try {
      current = await this.discover();
    } catch {
      return undefined;
    }
    return sameDataset(current.datasetId, session.datasetId) ? undefined : current.datasetId;
  }

  // invalidate discards the session after a known Dataset change. Old
  // descriptors are then rejected before transmission.
  invalidate() {
    this.current = undefined;
  }

  // read performs one read. Failures throw AtlasError: a Core rejection keeps
  // its code; an uninterpretable response is protocol_error; a valid
  // obsolete-Dataset rejection invalidates the session.
  async read<T>(
    perform: (session: Session, signal: AbortSignal) => Promise<{ data?: T; error?: unknown; response: Response }>,
  ): Promise<T> {
    const session = await this.session();
    let result;
    try {
      result = await perform(session, this.signal());
    } catch (error) {
      const changed = await this.changedDataset(session, error);
      if (changed !== undefined) {
        throw new AtlasError("dataset_invalidated", "The Dataset changed; old reads and cursors are invalid", 409, {
          current_dataset_id: changed,
        });
      }
      throw transportError(error);
    }
    if (result.error !== undefined || result.data === undefined) {
      const rejection = rejectionOf(result.error, result.response.status);
      if (rejection.code === "dataset_mismatch") {
        this.invalidate();
        throw new AtlasError(
          "dataset_invalidated",
          "The Dataset changed; old reads and cursors are invalid",
          409,
          rejection.details,
        );
      }
      throw new AtlasError(rejection.code, rejection.message, rejection.status, rejection.details);
    }
    return result.data;
  }

  // mutate submits one prepared mutation bound to datasetId and classifies
  // the outcome. It never retries automatically and never relabels an old
  // Dataset's submission.
  async mutate<T, R>(
    datasetId: string,
    perform: (session: Session, signal: AbortSignal) => Promise<{ data?: T; error?: unknown; response: Response }>,
    extract: (data: T | undefined, response: Response) => { value: R; commitCursor: string },
  ): Promise<MutationOutcome<R>> {
    let session: Session;
    try {
      session = await this.session();
    } catch (error) {
      return { outcome: "not_submitted", reason: error instanceof Error ? error.message : "discovery failed" };
    }
    if (!sameDataset(session.datasetId, datasetId)) {
      return { outcome: "dataset_invalidated", currentDatasetId: session.datasetId };
    }
    let result;
    try {
      result = await perform(session, this.signal());
    } catch (error) {
      // A known Dataset change makes the descriptor obsolete whatever
      // happened: the old Dataset and any commit in it are gone.
      const changed = await this.changedDataset(session, error);
      if (changed !== undefined) return { outcome: "dataset_invalidated", currentDatasetId: changed };
      // A timeout, connection loss, abort after transmission or an
      // uninterpretable response can hide a commit.
      return {
        outcome: "unknown_outcome",
        reason: error instanceof ResponseValidationError ? `invalid response: ${error.reason}` : describe(error),
      };
    }
    if (result.error !== undefined) {
      const rejection = rejectionOf(result.error, result.response.status);
      if (rejection.code === "dataset_mismatch") {
        this.invalidate();
        const current = currentDatasetOf(rejection);
        return current === undefined
          ? { outcome: "dataset_invalidated" }
          : { outcome: "dataset_invalidated", currentDatasetId: current };
      }
      return { outcome: "rejected", rejection };
    }
    const { value, commitCursor } = extract(result.data, result.response);
    return { outcome: "accepted", value, commitCursor, status: result.response.status };
  }
}

export function sameDataset(left: string, right: string) {
  const identity = (value: string) => value.toLowerCase().replace(/^urn:uuid:/u, "");
  return identity(left) === identity(right);
}

function describe(error: unknown) {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "request deadline elapsed";
    return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
  }
  return "transport failure";
}

function transportError(error: unknown) {
  if (error instanceof ResponseValidationError) return new AtlasError("protocol_error", error.message, error.status);
  if (error instanceof AtlasError) return error;
  return new AtlasError("transport_error", describe(error));
}
