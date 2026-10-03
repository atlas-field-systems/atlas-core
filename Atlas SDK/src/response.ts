import type { ValidateFunction } from "ajv";
import type { Middleware } from "openapi-fetch";
import type { components } from "../generated/protocol.js";
import { contractValidator, pointer, type ContractDocument } from "./schema.js";

export type ResponseFailureReason = "context" | "status" | "media_type" | "json" | "schema";

// This failure says the response cannot be interpreted. It makes no claim about
// whether a mutation committed. Operational retry outcomes belong to SDK helpers.
export class ResponseValidationError extends Error {
  constructor(readonly reason: ResponseFailureReason, readonly status: number) {
    super(`Invalid Protocol response: ${reason}`);
    this.name = "ResponseValidationError";
  }
}

interface ResponseDefinition {
  content?: Record<string, unknown>;
}
interface ResponseContract extends ContractDocument {
  paths: Record<string, Record<string, { responses: Record<string, ResponseDefinition> }>>;
}

export function responseValidation(document: ResponseContract, context: { datasetId: string; protocolVersion: string }): Middleware {
  const ajv = contractValidator(document);
  const validContext = ajv.compile<components["schemas"]["ResponseContext"]>({ $ref: "atlas#/components/schemas/ResponseContext" });
  const validError = ajv.compile<components["schemas"]["Error"]>({ $ref: "atlas#/components/schemas/Error" });
  const responses = new Map<string, { media: Set<string>; validate?: ValidateFunction }>();
  for (const [path, item] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      for (const [status, response] of Object.entries(operation.responses)) {
        const media = new Set(Object.keys(response.content ?? {}));
        const key = `${method.toUpperCase()} ${path} ${status}`;
        if (media.has("application/json")) {
          const ref = `atlas#/paths/${pointer(path)}/${method}/responses/${status}/content/application~1json/schema`;
          responses.set(key, { media, validate: ajv.compile({ $ref: ref }) });
        } else {
          responses.set(key, { media });
        }
      }
    }
  }
  return {
    async onResponse({ response, schemaPath, request }) {
      const invalid = (reason: ResponseFailureReason): never => { throw new ResponseValidationError(reason, response.status); };
      if (response.headers.get("Atlas-Dataset-ID") !== context.datasetId ||
          response.headers.get("Atlas-Protocol-Version") !== context.protocolVersion) invalid("context");
      const declared = responses.get(`${request.method} ${schemaPath} ${response.status}`);
      if (!declared) return invalid("status");
      const media = response.headers.get("Content-Type")?.split(";")[0]?.trim() ?? "";
      if (declared.media.size === 0 ? media !== "" : !declared.media.has(media)) invalid("media_type");
      if (declared.validate) {
        let body: unknown;
        try { body = await response.clone().json(); } catch { return invalid("json"); }
        if (!declared.validate(body)) invalid("schema");
        if (response.ok) {
          if (validContext(body) && body.dataset_id !== context.datasetId) invalid("context");
        } else if (!validError(body) || body.dataset_id !== undefined && body.dataset_id !== context.datasetId) {
          invalid("context");
        }
      }
      return response;
    },
  };
}
