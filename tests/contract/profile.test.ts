import assert from "node:assert/strict";
import { contractValidator } from "../../Atlas SDK/src/index.js";
import canonical from "../../Atlas Protocol/protocol.json" with { type: "json" };
import { withFixture } from "./runner.js";

const ajv = contractValidator(canonical);
for (const name of ["DecimalCounter", "PositiveDecimalCounter"]) {
  const validate = ajv.compile({ $ref: `atlas#/components/schemas/${name}` });
  assert(validate("9007199254740993"));
  for (const invalid of ["1\n", "1\r\n", "01", "-1", "1.0", " 1", "1 ", 1]) {
    assert.equal(validate(invalid), false, `${name} rejects ${JSON.stringify(invalid)}`);
  }
}
console.log("PASS canonical decimal syntax in SDK schema consumer");

await withFixture(async ({ baseUrl }) => {
  const headers = { "Atlas-Dataset-ID": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Atlas-Protocol-Version": "0.2.0" };
  const initial = { dataset_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", data: { value: "initial fixture value", count: "0" } };
  for (const count of ["1\n", "1\r\n", "01", "-1", "1.0", " 1", "1 "]) {
    const response = await fetch(`${baseUrl}/__fixture/value`, {
      method: "PUT", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ value: "must remain unchanged", count }), signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 400, `Go validator rejects ${JSON.stringify(count)}`);
  }
  const read = await fetch(`${baseUrl}/__fixture/value`, { headers, signal: AbortSignal.timeout(5000) });
  assert.deepEqual(await read.json(), initial);
});
console.log("PASS canonical decimal syntax in Go HTTP consumer without effects");

// strictRequired compilation must not erase the inherited runtime requirement.
const mutation = ajv.compile({ $ref: "atlas#/components/schemas/MutationResponseContext" });
assert(mutation({ dataset_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", commit_cursor: "fixture:commit:1" }));
assert.equal(mutation({ dataset_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }), false);
console.log("PASS composed mutation context still requires commit cursor");
