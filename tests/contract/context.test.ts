import assert from "node:assert/strict";
import { createTransport, responseValidation, ResponseValidationError } from "../../Atlas SDK/src/index.js";
import protocol from "./generated/protocol.json" with { type: "json" };
import type { paths } from "./generated/protocol.js";
import { withFixture } from "./runner.js";

const dataset = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const version = "0.2.0";
const canonicalHeaders = { "Atlas-Dataset-ID": dataset, "Atlas-Protocol-Version": version };
const spellings = [dataset, dataset.toUpperCase(), `urn:uuid:${dataset}`, `URN:UUID:${dataset.toUpperCase()}`];
await withFixture(async ({ baseUrl }) => {
  for (const [index, spelling] of spellings.entries()) {
    const headers = { ...canonicalHeaders, "Atlas-Dataset-ID": spelling };
    const client = createTransport<paths>({ baseUrl, headers, fetch: (request) => fetch(request, { signal: AbortSignal.timeout(5000) }) });
    client.use(responseValidation(protocol, { datasetId: spelling, protocolVersion: version }));
    const read = await client.GET("/__fixture/value", { params: { header: headers } });
    assert.equal(read.response.status, 200, `GET accepts Dataset identity ${spelling}`);
    const value = { value: `identity spelling ${index}`, count: "1" };
    const write = await client.PUT("/__fixture/value", { params: { header: headers }, body: value });
    assert.equal(write.response.status, 200, `PUT returns committed success for ${spelling}`);
    assert.deepEqual(write.data, { dataset_id: dataset, data: value, commit_cursor: "fixture:commit:1" });
    const stored = await fetch(`${baseUrl}/__fixture/value`, { headers: canonicalHeaders, signal: AbortSignal.timeout(5000) });
    assert.deepEqual(await stored.json(), { dataset_id: dataset, data: value }, "canonical read-back confirms the successful PUT");
  }
  const different = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const headers = { ...canonicalHeaders, "Atlas-Dataset-ID": different };
  const client = createTransport<paths>({ baseUrl, headers, fetch: (request) => fetch(request, { signal: AbortSignal.timeout(5000) }) });
  client.use(responseValidation(protocol, { datasetId: different, protocolVersion: version }));
  const isContextFailure = (error: unknown) => error instanceof ResponseValidationError && error.reason === "context" && error.status === 409;
  await assert.rejects(() => client.GET("/__fixture/value", { params: { header: headers } }), isContextFailure);
  await assert.rejects(() => client.PUT("/__fixture/value", { params: { header: headers }, body: { value: "must not commit", count: "1" } }), isContextFailure);
  const unchanged = await fetch(`${baseUrl}/__fixture/value`, { headers: canonicalHeaders, signal: AbortSignal.timeout(5000) });
  assert.deepEqual(await unchanged.json(), { dataset_id: dataset, data: { value: "identity spelling 3", count: "1" } });
});

// The fixture emits canonical spelling. Controlled wire responses isolate each
// validation point without changing Core's serialization behavior.
for (const spelling of spellings) {
  for (const location of ["header", "envelope"]) {
    const client = createTransport<paths>({ baseUrl: "http://response-adapter.invalid", fetch: async () => new Response(
      JSON.stringify({ dataset_id: location === "envelope" ? spelling : dataset, data: { value: "response identity", count: "1" } }),
      { status: 200, headers: { ...canonicalHeaders, "Atlas-Dataset-ID": location === "header" ? spelling : dataset, "Content-Type": "application/json" } }) });
    client.use(responseValidation(protocol, { datasetId: dataset, protocolVersion: version }));
    const read = await client.GET("/__fixture/value", { params: { header: canonicalHeaders } });
    assert.equal(read.response.status, 200, `${location} accepts equivalent identity ${spelling}`);
    assert.equal(read.data?.dataset_id, location === "envelope" ? spelling : dataset, "validation preserves response spelling");
  }
}
console.log("PASS Dataset UUID case/URN GET and committed PUT, independent header/envelope spellings and different-ID rejection");
