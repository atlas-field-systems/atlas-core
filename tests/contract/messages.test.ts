import assert from "node:assert/strict";
import { contractValidator } from "../../Atlas SDK/src/index.js";
import protocol from "./generated/protocol.json" with { type: "json" };
import type { components } from "./generated/protocol.js";
import fixtures from "./message-fixtures.json" with { type: "json" };

const validator = contractValidator(protocol);
const validateChange = validator.compile<components["schemas"]["FixtureChangeMessage"]>({
  $ref: "atlas#/components/schemas/FixtureChangeMessage",
});
const validateDispatch = validator.compile<components["schemas"]["FixturePluginDispatch"]>({
  $ref: "atlas#/components/schemas/FixturePluginDispatch",
});

for (const fixture of fixtures) {
  if (fixture.schema === "FixturePluginDispatch") {
    assert.equal(validateDispatch(fixture.body), fixture.valid, fixture.name);
    if (fixture.valid) {
      assert(validateDispatch(fixture.body));
      assert.equal(fixture.body.input.latitude, fixture.expected_latitude);
      assert.equal(fixture.body.input.longitude, fixture.expected_longitude);
      // The consumer serializes the validated generated type, then validates
      // the wire result through the same authored schema. No field schema is
      // reconstructed here or in the Go consumer.
      const decoded: unknown = JSON.parse(JSON.stringify(fixture.body));
      assert(validateDispatch(decoded));
      assert.deepEqual(decoded, fixture.body, `${fixture.name} survives generated-type serialization`);
    }
  } else {
    assert.equal(fixture.schema, "FixtureChangeMessage");
    assert.equal(validateChange(fixture.body), fixture.valid, fixture.name);
    if (fixture.valid) {
      assert(validateChange(fixture.body));
      assert.equal(fixture.body.commit_id, fixture.expected_commit_id);
      assert.equal(fixture.body.resource_version, fixture.expected_resource_version);
      assert.equal(fixture.body.resource.version, fixture.expected_entity_version);
      assert.equal(fixture.body.resource.position.latitude, fixture.expected_latitude);
      assert.equal(fixture.body.resource.position.longitude, fixture.expected_longitude);
      const decoded: unknown = JSON.parse(JSON.stringify(fixture.body));
      assert(validateChange(decoded));
      assert.deepEqual(decoded, fixture.body, `${fixture.name} survives generated-type serialization`);
    }
  }
}
console.log(
  `PASS TypeScript canonical message consumer: ${fixtures.length} independent fixtures and generated-type serialization`,
);
