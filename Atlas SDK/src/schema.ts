import { Ajv } from "ajv";
import { fullFormats } from "ajv-formats/dist/formats.js";

export interface ContractDocument {
  components: { schemas: Record<string, unknown> };
  paths: Record<string, unknown>;
}

// Schemas are references into the authored contract. This adapter never copies
// field declarations, inserts defaults, coerces values or deletes properties.
export function contractValidator(document: ContractDocument) {
  // Required fields may be declared by another allOf member. Ajv strictRequired
  // checks only local declarations; runtime required validation stays enabled.
  const ajv = new Ajv({ strict: true, strictRequired: false, allErrors: true });
  for (const [name, format] of Object.entries(fullFormats)) ajv.addFormat(name, format);
  for (const keyword of ["components", "paths", "discriminator", "x-atlas-command", "x-go-type"]) {
    ajv.addKeyword({ keyword });
  }
  ajv.addSchema({ $id: "atlas", components: document.components, paths: document.paths });
  return ajv;
}

export function pointer(value: string) {
  // Callers embed this token in a URI-fragment JSON Pointer (RFC 6901 §6).
  // Escape the pointer identity first, then encode literal URI characters.
  return encodeURIComponent(value.replaceAll("~", "~0").replaceAll("/", "~1"));
}
