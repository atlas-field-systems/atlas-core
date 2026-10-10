import type { Ajv, ValidateFunction } from "ajv";
import type { Middleware } from "openapi-fetch";
import { contractValidator, pointer, type ContractDocument } from "./schema.js";

export type ResponseFailureReason =
  "context" | "status" | "media_type" | "body" | "body_size" | "json" | "schema" | "header";

// This failure says the response cannot be interpreted. It makes no claim about
// whether a mutation committed. Operational retry outcomes belong to SDK helpers.
export class ResponseValidationError extends Error {
  constructor(
    readonly reason: ResponseFailureReason,
    readonly status: number,
    readonly operation: string,
  ) {
    // The contract path contains no request values, credentials or response body.
    super(`Invalid Protocol response for ${operation} (${status}): ${reason}`);
    this.name = "ResponseValidationError";
  }
}

interface ResponseDefinition {
  $ref?: string;
  content?: Record<string, unknown>;
  headers?: Record<string, HeaderDefinition>;
}
interface HeaderDefinition {
  $ref?: string;
  required?: boolean;
  schema?: unknown;
}
const methods = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
type HTTPMethod = (typeof methods)[number];
interface OperationDefinition {
  responses: Record<string, ResponseDefinition>;
}
type PathItem = Partial<Record<HTTPMethod, OperationDefinition>> & {
  $ref?: string;
  summary?: string;
  description?: string;
  parameters?: unknown;
  servers?: unknown;
};
interface ResponseContract extends ContractDocument {
  components: ContractDocument["components"] & {
    headers?: Record<string, HeaderDefinition>;
    responses?: Record<string, ResponseDefinition>;
  };
  paths: Record<string, PathItem>;
}

interface DeclaredHeader {
  name: string;
  role: "dataset" | "version" | "other";
  required: boolean;
  validate: ValidateFunction;
}
interface DeclaredResponse {
  media: Set<string>;
  validators: Map<string, ValidateFunction>;
  headers: DeclaredHeader[];
}

// An absent datasetId is discovery: Dataset context is validated but not yet
// known, so it is not compared.
export function responseValidation(
  document: ResponseContract,
  context: { datasetId: string | undefined; protocolVersion: string },
  options: { maxJSONBytes: number },
): Middleware {
  const maxJSONBytes = options.maxJSONBytes;
  const expected = context.datasetId;
  const datasetAgrees = (value: string) => expected === undefined || sameDataset(value, expected);
  if (!Number.isSafeInteger(maxJSONBytes) || maxJSONBytes <= 0) {
    throw new Error("Response JSON byte bound must be a positive safe integer");
  }
  const responses = declareResponses(document);
  return {
    async onResponse({ response, schemaPath, request }) {
      const operation = `${request.method} ${schemaPath}`;
      const refuse = (reason: ResponseFailureReason) => {
        // No caller receives a refused response. Stop its transport stream even
        // when refusal happens before JSON reading, without waiting on a tee.
        void response.body?.cancel().catch(() => {});
        return new ResponseValidationError(reason, response.status, operation);
      };
      const declared = responses.get(`${operation} ${response.status}`);
      if (!declared) throw refuse("status");
      for (const header of declared.headers) {
        const failure = header.role === "other" ? "header" : "context";
        const value = response.headers.get(header.name);
        if (value === null) {
          if (header.required) throw refuse(failure);
          continue;
        }
        if (!header.validate(value)) throw refuse(failure);
        if (header.role === "dataset" && !datasetAgrees(value)) throw refuse("context");
        if (header.role === "version" && value !== context.protocolVersion) throw refuse("context");
      }
      const media = mediaType(response.headers.get("Content-Type") ?? "");
      if (media === undefined) throw refuse("media_type");
      const noBody = declared.media.size === 0;
      if (noBody ? media !== "" : !declared.media.has(media)) throw refuse("media_type");
      const validate = declared.validators.get(media);
      // Binary content bypasses JSON reading. All declared JSON, including raw
      // documents, is validated through a bounded clone below.
      if (!validate && !noBody) return response;
      const bytes = await readClone(response, noBody ? 0 : maxJSONBytes);
      if (bytes === "overflow") throw refuse(noBody ? "body" : "body_size");
      if (bytes === "unreadable") throw refuse(noBody ? "body" : "json");
      // An empty reply was checked through a clone, retaining its original
      // Response and readable body for the transport's chosen representation.
      if (!validate) return response;
      let body: unknown;
      try {
        // Fetch's JSON decoder replaces bad UTF-8 instead of rejecting it.
        body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        throw refuse("json");
      }
      if (!validate(body)) throw refuse("schema");
      if (
        typeof body === "object" &&
        body !== null &&
        "dataset_id" in body &&
        (typeof body.dataset_id !== "string" || !datasetAgrees(body.dataset_id))
      ) {
        throw refuse("context");
      }
      return response;
    },
  };
}

// Compile every declared response once, keyed by "METHOD path status".
function declareResponses(document: ResponseContract) {
  const ajv = contractValidator(document);
  const responses = new Map<string, DeclaredResponse>();
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of methods) {
      const operation = item[method];
      if (!operation) continue;
      for (const [status, response] of Object.entries(operation.responses)) {
        if (!/^[1-5][0-9]{2}$/u.test(status)) {
          throw new Error(
            `Unsupported response status declaration "${status}" for ${method.toUpperCase()} ${path}; use exact status codes`,
          );
        }
        const [location, definition] = resolveResponse(
          document,
          `#/paths/${pointer(path)}/${method}/responses/${status}`,
          response,
        );
        responses.set(
          `${method.toUpperCase()} ${path} ${status}`,
          declareResponse(document, ajv, location, definition),
        );
      }
    }
  }
  return responses;
}

// A Response Object may be a local component reference. Its schemas and
// headers then compile from the component's own location.
function resolveResponse(
  document: ResponseContract,
  location: string,
  response: ResponseDefinition,
): [string, ResponseDefinition] {
  if (response.$ref === undefined) return [location, response];
  const prefix = "#/components/responses/";
  const reference = response.$ref.startsWith("#") ? decodeURIComponent(response.$ref) : "";
  if (!reference.startsWith(prefix)) throw new Error("Responses require local component references");
  const component = reference.slice(prefix.length).replaceAll("~1", "/").replaceAll("~0", "~");
  const resolved = document.components.responses?.[component];
  if (!resolved || resolved.$ref !== undefined) throw new Error("Response reference is unresolved");
  return [`${prefix}${pointer(component)}`, resolved];
}

function declareResponse(
  document: ResponseContract,
  ajv: Ajv,
  location: string,
  response: ResponseDefinition,
): DeclaredResponse {
  const mediaDeclarations = Object.keys(response.content ?? {}).map((authored) => {
    const normalized = mediaType(authored);
    if (!normalized) throw new Error("Response media type declaration has invalid syntax");
    return { authored, normalized };
  });
  const headers = Object.entries(response.headers ?? {}).map(([name, authored]) =>
    declareHeader(document, ajv, `${location}/headers/${pointer(name)}`, name, authored),
  );
  const validators = new Map<string, ValidateFunction>();
  for (const { authored, normalized } of mediaDeclarations) {
    if (normalized !== "application/json" && !normalized.endsWith("+json")) continue;
    if (validators.has(normalized)) throw new Error("Response JSON media declarations have ambiguous normalized keys");
    validators.set(normalized, ajv.compile({ $ref: `atlas${location}/content/${pointer(authored)}/schema` }));
  }
  return { media: new Set(mediaDeclarations.map(({ normalized }) => normalized)), headers, validators };
}

function declareHeader(
  document: ResponseContract,
  ajv: Ajv,
  location: string,
  name: string,
  authored: HeaderDefinition,
): DeclaredHeader {
  let definition = authored;
  let ref = location;
  if (authored.$ref) {
    const prefix = "#/components/headers/";
    // URI fragment decoding precedes JSON Pointer token decoding.
    const reference = authored.$ref.startsWith("#") ? decodeURIComponent(authored.$ref) : "";
    if (!reference.startsWith(prefix)) throw new Error("Response headers require local component references");
    const component = reference.slice(prefix.length).replaceAll("~1", "/").replaceAll("~0", "~");
    const resolved = document.components.headers?.[component];
    if (!resolved) throw new Error("Response header reference is unresolved");
    definition = resolved;
    ref = `${prefix}${pointer(component)}`;
  }
  if (!definition.schema) throw new Error("Response header requires an authored schema");
  const lower = name.toLowerCase();
  const role = lower === "atlas-dataset-id" ? "dataset" : lower === "atlas-protocol-version" ? "version" : "other";
  return { name, role, required: definition.required === true, validate: ajv.compile({ $ref: `atlas${ref}/schema` }) };
}

// Read a clone so the original Response keeps its readable body. Stops at the
// first chunk that would exceed limit bytes.
async function readClone(response: Response, limit: number): Promise<Uint8Array | "overflow" | "unreadable"> {
  const reader = response.clone().body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > limit - length) {
        // A tee cancellation waits for the other branch. The caller cancels the
        // original branch; neither cancellation is awaited, so a refused
        // streaming supplier cannot block us.
        void reader.cancel().catch(() => {});
        return "overflow";
      }
      length += chunk.value.byteLength;
      chunks.push(chunk.value);
    }
  } catch {
    void reader.cancel().catch(() => {});
    return "unreadable";
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// The authored UUID schemas validate wire values first. Compare their identity
// without changing the caller's selected context or the returned representation.
function sameDataset(left: string, right: string) {
  const identity = (value: string) => value.toLowerCase().replace(/^urn:uuid:/u, "");
  return identity(left) === identity(right);
}

function mediaType(value: string) {
  // RFC 9110 sections 5.6 and 8.3.1. Validate the entire field before ignoring
  // parameters for schema selection; quoted semicolons are parameter data.
  const token = /[!#$%&'*+.^_`|~0-9A-Za-z-]+/y;
  let offset = 0;
  const whitespace = () => {
    while (value[offset] === " " || value[offset] === "\t") offset++;
  };
  const readToken = () => {
    token.lastIndex = offset;
    const match = token.exec(value);
    if (!match) return undefined;
    offset = token.lastIndex;
    return match[0];
  };
  whitespace();
  if (offset === value.length) return "";
  const type = readToken();
  if (!type || value[offset++] !== "/") return undefined;
  const subtype = readToken();
  if (!subtype) return undefined;
  while (offset < value.length) {
    whitespace();
    if (offset === value.length) break;
    if (value[offset++] !== ";") return undefined;
    whitespace();
    // The parameter grammar permits empty slots between semicolons.
    if (offset === value.length || value[offset] === ";") continue;
    if (!readToken() || value[offset++] !== "=") return undefined;
    if (value[offset] !== '"') {
      if (!readToken()) return undefined;
      continue;
    }
    offset++;
    let closed = false;
    while (offset < value.length) {
      const character = value[offset++];
      if (character === '"') {
        closed = true;
        break;
      }
      const code = character === "\\" ? value.charCodeAt(offset++) : value.charCodeAt(offset - 1);
      if (!(code === 9 || (code >= 32 && code <= 126) || (code >= 128 && code <= 255))) return undefined;
    }
    if (!closed) return undefined;
  }
  return `${type}/${subtype}`.toLowerCase();
}
