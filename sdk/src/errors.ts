import type { components } from "./generated/protocol.js";

type ProtocolError = components["schemas"]["Error"];

/** A failure reported by Core, carrying its Protocol error code. */
export class AtlasError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AtlasError";
  }
}

interface FetchResult {
  data?: unknown;
  error?: unknown;
  response: Response;
}

/** Returns the success body of an openapi-fetch result, or throws its Protocol error. */
export function unwrap<R extends FetchResult>(result: R): NonNullable<R["data"]> {
  if (result.error === undefined) return result.data as NonNullable<R["data"]>;
  if (isProtocolError(result.error)) {
    throw new AtlasError(result.response.status, result.error.code, result.error.message);
  }
  throw new AtlasError(result.response.status, "unexpected_response", `Core returned HTTP ${result.response.status}.`);
}

function isProtocolError(body: unknown): body is ProtocolError {
  return typeof body === "object" && body !== null && "code" in body && "message" in body;
}

/** A local synchronization failure or an unavailable local read. */
export class PictureError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PictureError";
  }
}

/** Whether error is Core's or the picture's report of an expired cursor. */
export function isCursorExpired(error: unknown): boolean {
  return (error instanceof AtlasError || error instanceof PictureError) && error.code === "cursor_expired";
}
