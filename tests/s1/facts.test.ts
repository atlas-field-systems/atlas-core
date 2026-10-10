import assert from "node:assert/strict";
import vectors from "./canonical-vectors.json" with { type: "json" };
import { canonicalJSON } from "../../Atlas SDK/src/index.js";
for (const vector of vectors)
  assert.equal(new TextDecoder().decode(canonicalJSON(JSON.parse(vector.input))), vector.canonical, vector.name);
for (const invalid of [
  NaN,
  Infinity,
  undefined,
  1n,
  { omitted: undefined },
  [undefined],
  new Date(),
  "\ud800",
  { "\ud800": "bad key" },
])
  assert.throws(() => canonicalJSON(invalid));
const cycle: { self?: unknown } = {};
cycle.self = cycle;
assert.throws(() => canonicalJSON(cycle));
console.log("PASS published JCS property/number vectors and original timestamp/null facts");
