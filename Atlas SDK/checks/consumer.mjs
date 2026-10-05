import assert from "node:assert/strict";
import {
  createTransport,
  contractValidator,
  lookupCommand,
  responseValidation,
  ResponseValidationError,
} from "@atlas-field-systems/sdk";

for (const exported of [
  createTransport,
  contractValidator,
  lookupCommand,
  responseValidation,
  ResponseValidationError,
]) {
  assert.equal(typeof exported, "function");
}

const pause = lookupCommand("pause");
assert(pause, "the consumer package carries its local canonical Catalog");
assert.deepEqual(pause.metadata, {
  name: "pause",
  scheduling: ["immediate"],
  default_scheduling: "immediate",
  success: "suspension_reported_by_asset",
  binding: "representative",
});
assert.equal(pause.inputSchema, "#/components/schemas/Pause");
assert.equal(pause.validateInput({ command: "pause" }), true);
assert.equal(pause.validateInput({ command: "pause", unexpected: true }), false);
assert.equal(lookupCommand("unknown"), undefined);
await import("@atlas-field-systems/sdk/protocol");
console.log("PASS ordinary Node consumer package exports and installed canonical Catalog");
