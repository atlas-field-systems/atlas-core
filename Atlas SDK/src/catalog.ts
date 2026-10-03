import protocol from "../generated/protocol.json" with { type: "json" };
import { contractValidator, pointer } from "./schema.js";

const ajv = contractValidator(protocol);
const commands = Object.entries(protocol.components.schemas).flatMap(([name, schema]) => {
  if (!("x-atlas-command" in schema)) return [];
  const metadata = schema["x-atlas-command"];
  const input_schema = `#/components/schemas/${pointer(name)}`;
  const validate = ajv.compile<unknown>({ $ref: `atlas${input_schema}` });
  return [Object.freeze({
    protocol_version: protocol.info.version,
    input_schema,
    metadata: Object.freeze({ ...metadata, scheduling: Object.freeze([...metadata.scheduling]) }),
    validateInput(input: unknown): boolean {
      return validate(input) === true;
    },
  })];
});

// Lookup uses only the installed Protocol artifact. Unknown names stay absent.
export function lookupCommand(name: string) {
  return commands.find((command) => command.metadata.name === name);
}
