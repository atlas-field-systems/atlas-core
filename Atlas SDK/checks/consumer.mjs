import assert from "node:assert/strict";
import {
  createTransport,
  contractValidator,
  lookupCommand,
  responseValidation,
  ResponseValidationError,
  createAtlasClient,
  createAssetClient,
  restoreMutation,
  canonicalJSON,
} from "@atlas-field-systems/sdk";

for (const exported of [
  createTransport,
  contractValidator,
  lookupCommand,
  responseValidation,
  ResponseValidationError,
  createAtlasClient,
  createAssetClient,
  restoreMutation,
  canonicalJSON,
]) {
  assert.equal(typeof exported, "function");
}

const move = lookupCommand("move_to");
assert(move, "the consumer package carries its local canonical Catalog");
assert.deepEqual(move.metadata, {
  name: "move_to",
  scheduling: ["queued"],
  default_scheduling: "queued",
  success: "arrival_reported_by_asset",
  binding: "operational",
});
assert.equal(move.inputSchema, "#/components/schemas/MoveTo");
assert.equal(
  move.validateInput({ command: "move_to", target: { kind: "position", position: { latitude: 10, longitude: 20 } } }),
  true,
);
assert.equal(move.validateInput({ command: "move_to", unexpected: true }), false);
assert.equal(lookupCommand("unknown"), undefined);
await import("@atlas-field-systems/sdk/protocol");
const { createHTTPSFetch } = await import("@atlas-field-systems/sdk/node");
assert.equal(typeof createHTTPSFetch, "function");
assert.equal(lookupCommand("pause"), undefined);
console.log("PASS ordinary Node consumer package exports and installed canonical Catalog");
