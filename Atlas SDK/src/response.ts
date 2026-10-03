import type { ValidateFunction } from "ajv";
import type { Middleware } from "openapi-fetch";
import { contractValidator, pointer, type ContractDocument } from "./schema.js";

export type ResponseFailureReason = "context" | "status" | "media_type" | "json" | "schema" | "header";

// This failure says the response cannot be interpreted. It makes no claim about
// whether a mutation committed. Operational retry outcomes belong to SDK helpers.
export class ResponseValidationError extends Error {
  constructor(readonly reason: ResponseFailureReason, readonly status: number, readonly operation: string) {
    // The contract path contains no request values, credentials or response body.
    super(`Invalid Protocol response for ${operation} (${status}): ${reason}`);
    this.name = "ResponseValidationError";
  }
}

interface ResponseDefinition {
  content?: Record<string, unknown>;
  headers?: Record<string, HeaderDefinition>;
}
interface HeaderDefinition {
  $ref?: string;
  required?: boolean;
  schema?: unknown;
}
interface ResponseContract extends ContractDocument {
  components: ContractDocument["components"] & { headers?: Record<string, HeaderDefinition> };
  paths: Record<string, Record<string, { responses: Record<string, ResponseDefinition> }>>;
}

export function responseValidation(document: ResponseContract, context: { datasetId: string; protocolVersion: string }): Middleware {
  const ajv = contractValidator(document);
  const responses = new Map<string, { media: Set<string>; validate?: ValidateFunction; headers: { name: string; required: boolean; validate: ValidateFunction }[] }>();
  for (const [path, item] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      for (const [status, response] of Object.entries(operation.responses)) {
        const media = new Set(Object.keys(response.content ?? {}));
        const key = `${method.toUpperCase()} ${path} ${status}`;
        const location = `#/paths/${pointer(path)}/${method}/responses/${status}`;
        const headers = Object.entries(response.headers ?? {}).map(([name, authored]) => {
          let definition = authored;
          let ref = `${location}/headers/${pointer(name)}`;
          if (authored.$ref) {
            const prefix = "#/components/headers/";
            if (!authored.$ref.startsWith(prefix)) throw new Error("Response headers require local component references");
            const component = authored.$ref.slice(prefix.length).replaceAll("~1", "/").replaceAll("~0", "~");
            const resolved = document.components.headers?.[component];
            if (!resolved) throw new Error("Response header reference is unresolved");
            definition = resolved;
            ref = authored.$ref;
          }
          if (!definition.schema) throw new Error("Response header requires an authored schema");
          return { name, required: definition.required === true, validate: ajv.compile({ $ref: `atlas${ref}/schema` }) };
        });
        if (media.has("application/json")) {
          const ref = `atlas#/paths/${pointer(path)}/${method}/responses/${status}/content/application~1json/schema`;
          responses.set(key, { media, headers, validate: ajv.compile({ $ref: ref }) });
        } else {
          responses.set(key, { media, headers });
        }
      }
    }
  }
  return {
    async onResponse({ response, schemaPath, request }) {
      const operation = `${request.method} ${schemaPath}`;
      const invalid = (reason: ResponseFailureReason): never => { throw new ResponseValidationError(reason, response.status, operation); };
      const declared = responses.get(`${operation} ${response.status}`);
      if (!declared) return invalid("status");
      for (const header of declared.headers) {
        const value = response.headers.get(header.name);
        const isContext = ["atlas-dataset-id", "atlas-protocol-version"].includes(header.name.toLowerCase());
        if (value === null) {
          if (header.required) invalid(isContext ? "context" : "header");
          continue;
        }
        if (!header.validate(value)) invalid(isContext ? "context" : "header");
        if (header.name.toLowerCase() === "atlas-dataset-id" && value !== context.datasetId ||
            header.name.toLowerCase() === "atlas-protocol-version" && value !== context.protocolVersion) invalid("context");
      }
      const media = response.headers.get("Content-Type")?.split(";")[0]?.trim() ?? "";
      if (declared.media.size === 0 ? media !== "" : !declared.media.has(media)) invalid("media_type");
      if (declared.validate) {
        let body: unknown;
        try { body = await response.clone().json(); } catch { return invalid("json"); }
        if (!declared.validate(body)) invalid("schema");
        if (typeof body === "object" && body !== null && "dataset_id" in body && body.dataset_id !== context.datasetId) {
          invalid("context");
        }
      }
      return response;
    },
  };
}
