import assert from "node:assert/strict";
import { contractValidator, lookupCommand, type components } from "../../Atlas SDK/src/index.js";
import protocol from "../../Atlas Protocol/protocol.json" with { type: "json" };
import fixtures from "./catalog-fixtures.json" with { type: "json" };

const move = lookupCommand("move_to");
assert(move, "installed Catalog contains Move To");
assert.deepEqual(move.metadata, {
  name: "move_to",
  scheduling: ["queued"],
  default_scheduling: "queued",
  success: "arrival_reported_by_asset",
  binding: "operational",
});
assert.equal(move.protocolVersion, "0.1.0");
assert.equal(move.inputSchema, "#/components/schemas/MoveTo");
assert(
  move.validateInput({ command: "move_to", target: { kind: "position", position: { latitude: 10, longitude: 20 } } }),
);
console.log("PASS local Move To metadata and canonical input lookup");

for (const name of ["pause", "resume", "unknown", "", "Move To"]) {
  assert.equal(lookupCommand(name), undefined, `unknown Command ${JSON.stringify(name)} stays absent`);
}
console.log("PASS unimplemented and unknown Commands stay absent from operational Catalog");

// #122 narrows operational advertising; retain the broader S0 shape evidence
// independently of lookup until S6 implements those Commands and targets.
const ajv = contractValidator(protocol);
const representativeMove = ajv.compile({ $ref: "atlas#/components/schemas/RepresentativeMoveTo" });
const representativePause = ajv.compile({ $ref: "atlas#/components/schemas/Pause" });
for (const example of fixtures.structural_inputs) {
  const validate = example.command === "pause" ? representativePause : representativeMove;
  assert.equal(validate(example.input), true, example.name);
  const command = lookupCommand(example.command);
  assert.equal(command?.validateInput(example.input) ?? false, false, `${example.name} is not operational S1 support`);
}

for (const example of fixtures.valid_inputs) {
  const command = lookupCommand(example.command);
  assert(command, example.name);
  const before = structuredClone(example.input);
  assert.equal(command.validateInput(example.input), true, example.name);
  assert.deepEqual(example.input, before, `${example.name} remains unchanged by validation`);
}
console.log("PASS independent valid Catalog inputs without default insertion");

for (const example of fixtures.invalid_inputs) {
  const command = lookupCommand(example.command);
  const validate = command?.validateInput ?? representativePause;
  const before = structuredClone(example.input);
  assert.equal(validate(example.input), false, example.name);
  assert.deepEqual(example.input, before, `${example.name} remains unchanged after rejection`);
}
console.log("PASS independent invalid Catalog inputs without coercion or property removal");

const precise: components["schemas"]["MoveTo"] = {
  command: "move_to",
  target: { kind: "position", position: { latitude: 10.123456789012345, longitude: 20.987654321098765 } },
};
const decoded: unknown = JSON.parse(JSON.stringify(precise));
assert(move.validateInput(decoded));
assert.deepEqual(decoded, {
  command: "move_to",
  target: { kind: "position", position: { latitude: 10.123456789012345, longitude: 20.987654321098765 } },
});
for (const position of [
  { latitude: -90, longitude: -180 },
  { latitude: 90, longitude: 180 },
]) {
  assert(move.validateInput({ command: "move_to", target: { kind: "position", position } }));
}
for (const nonfinite of [NaN, Infinity, -Infinity]) {
  assert.equal(
    move.validateInput({
      command: "move_to",
      target: { kind: "position", position: { latitude: nonfinite, longitude: 20 } },
    }),
    false,
  );
  assert.equal(
    move.validateInput({
      command: "move_to",
      target: { kind: "position", position: { latitude: 10, longitude: 20 } },
      target_altitude: { value_m: nonfinite, vertical_reference: "wgs84_ellipsoid" },
    }),
    false,
  );
}
console.log("PASS generated typed Catalog input, precision, inclusive bounds and nonfinite rejection");
