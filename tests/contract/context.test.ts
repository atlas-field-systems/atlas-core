import assert from "node:assert/strict";
import { ResponseValidationError } from "../../Atlas SDK/src/index.js";
import { withFixture } from "./runner.js";
import { dataset, fixtureClient, headers as canonicalHeaders, otherDataset, timedFetch } from "./support.js";

const spellings = [dataset, dataset.toUpperCase(), `urn:uuid:${dataset}`, `URN:UUID:${dataset.toUpperCase()}`];
await withFixture(async ({ baseUrl }) => {
  for (const [index, spelling] of spellings.entries()) {
    const headers = { ...canonicalHeaders, "Atlas-Dataset-ID": spelling };
    const client = fixtureClient(baseUrl, { headers, datasetId: spelling });
    const read = await client.GET("/__fixture/value", { params: { header: headers } });
    assert.equal(read.response.status, 200, `GET accepts Dataset identity ${spelling}`);
    const value = { value: `identity spelling ${index}`, count: "1" };
    const write = await client.PUT("/__fixture/value", { params: { header: headers }, body: value });
    assert.equal(write.response.status, 200, `PUT returns committed success for ${spelling}`);
    assert.deepEqual(write.data, { dataset_id: dataset, data: value, commit_cursor: "fixture:commit:1" });
    const stored = await timedFetch(`${baseUrl}/__fixture/value`, { headers: canonicalHeaders });
    assert.deepEqual(await stored.json(), { dataset_id: dataset, data: value }, "canonical read-back confirms the successful PUT");
  }
  const headers = { ...canonicalHeaders, "Atlas-Dataset-ID": otherDataset };
  const client = fixtureClient(baseUrl, { headers, datasetId: otherDataset });
  const isContextFailure = (error: unknown) => error instanceof ResponseValidationError && error.reason === "context" && error.status === 409;
  await assert.rejects(() => client.GET("/__fixture/value", { params: { header: headers } }), isContextFailure);
  const body = { value: "must not commit", count: "1" };
  await assert.rejects(() => client.PUT("/__fixture/value", { params: { header: headers }, body }), isContextFailure);
  const unchanged = await timedFetch(`${baseUrl}/__fixture/value`, { headers: canonicalHeaders });
  assert.deepEqual(await unchanged.json(), { dataset_id: dataset, data: { value: "identity spelling 3", count: "1" } });
});

// The fixture emits canonical spelling. Controlled wire responses isolate each
// validation point without changing Core's serialization behavior.
for (const spelling of spellings) {
  for (const location of ["header", "envelope"]) {
    const client = fixtureClient("http://response-adapter.invalid", { fetch: async () => new Response(
      JSON.stringify({ dataset_id: location === "envelope" ? spelling : dataset, data: { value: "response identity", count: "1" } }),
      {
        status: 200,
        headers: { ...canonicalHeaders, "Atlas-Dataset-ID": location === "header" ? spelling : dataset, "Content-Type": "application/json" },
      }) });
    const read = await client.GET("/__fixture/value", { params: { header: canonicalHeaders } });
    assert.equal(read.response.status, 200, `${location} accepts equivalent identity ${spelling}`);
    assert.equal(read.data?.dataset_id, location === "envelope" ? spelling : dataset, "validation preserves response spelling");
  }
}
console.log("PASS Dataset UUID case/URN GET and committed PUT, independent header/envelope spellings and different-ID rejection");
