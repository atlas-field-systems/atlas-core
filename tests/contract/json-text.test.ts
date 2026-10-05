import assert from "node:assert/strict";
import { withFixture } from "./runner.js";
import { dataset, fixtureClient, headers, timedFetch, validateError } from "./support.js";

const encoder = new TextEncoder();
const baseline = { value: "preserved before rejected text", count: "1" };
const invalid = [
  { name: "invalid UTF-8 byte", bytes: Uint8Array.from([...encoder.encode('{"value":"'), 255, ...encoder.encode('","count":"1"}')]) },
  ...['\\ud800', '\\udfff', '\\ud800\\u0041'].map((text) => ({ name: `unpaired surrogate ${text}`, bytes: encoder.encode(`{"value":"${text}","count":"1"}`) })),
];
for (const mode of ["generated transport", "direct Protocol"]) {
  await withFixture(async ({ baseUrl }) => {
    let injected: Uint8Array<ArrayBuffer> | undefined;
    const client = fixtureClient(baseUrl, {
      fetch: (request) => timedFetch(injected !== undefined && request.method === "PUT" ? new Request(request, { body: injected }) : request),
    });
    const seed = await client.PUT("/__fixture/value", { params: { header: headers }, body: baseline });
    assert.equal(seed.response.status, 200);
    for (const scenario of invalid) {
      let error: unknown;
      if (mode === "generated transport") {
        injected = scenario.bytes;
        const response = await client.PUT("/__fixture/value", { params: { header: headers }, body: baseline });
        injected = undefined;
        assert.equal(response.response.status, 400, scenario.name);
        error = response.error;
      } else {
        const response = await timedFetch(`${baseUrl}/__fixture/value`, {
          method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: scenario.bytes,
        });
        assert.equal(response.status, 400, scenario.name);
        error = await response.json();
      }
      assert(validateError(error), scenario.name);
      assert.equal(error.error.code, "invalid_request");
      const read = await client.GET("/__fixture/value", { params: { header: headers } });
      assert.deepEqual(read.data, { dataset_id: dataset, data: baseline }, `${scenario.name} preserves prior text`);
    }
    for (const [json, expected] of [
      ['{"value":"雪🌍","count":"1"}', "雪🌍"],
      ['{"value":"\\ud83c\\udf0d","count":"1"}', "🌍"],
      ['{"value":"\\\\ud800","count":"1"}', "\\ud800"],
      ['{"value":"�","count":"1"}', "�"],
    ]) {
      assert(json !== undefined && expected !== undefined);
      if (mode === "generated transport") {
        injected = encoder.encode(json);
        const response = await client.PUT("/__fixture/value", { params: { header: headers }, body: baseline });
        injected = undefined;
        assert.equal(response.response.status, 200);
        assert.equal(response.data?.data.value, expected);
      } else {
        const response = await timedFetch(`${baseUrl}/__fixture/value`, {
          method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: json,
        });
        assert.equal(response.status, 200);
      }
      const read = await client.GET("/__fixture/value", { params: { header: headers } });
      assert.equal(read.data?.data.value, expected, "accepted Unicode text survives storage and response");
    }
  });
  console.log(`PASS ${mode}: invalid UTF-8 and unpaired escapes reject before effects; Unicode scalars round-trip`);
}
