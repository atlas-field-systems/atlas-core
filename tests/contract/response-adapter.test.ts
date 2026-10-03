import assert from "node:assert/strict";
import { createTransport, responseValidation, ResponseValidationError } from "../../Atlas SDK/src/index.js";
import protocol from "./generated/protocol.json" with { type: "json" };
import type { paths } from "./generated/protocol.js";
import { withFixture } from "./runner.js";

const dataset = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const version = "0.2.0";
const headers = { "Atlas-Dataset-ID": dataset, "Atlas-Protocol-Version": version };
const item = protocol.paths["/__fixture/value"];
const document = { ...protocol, paths: { "/__fixture/value": {
  summary: "Shared path metadata", description: "Parameters belong to the path", servers: [{ url: "http://unused.invalid" }],
  parameters: item.get.parameters, get: { responses: item.get.responses }, put: { responses: item.put.responses },
} } };
await withFixture(async ({ baseUrl }) => {
  const client = createTransport<paths>({ baseUrl, headers, fetch: (request) => fetch(request, { signal: AbortSignal.timeout(5000) }) });
  client.use(responseValidation(document, { datasetId: dataset, protocolVersion: version }));
  const read = await client.GET("/__fixture/value", { params: { header: headers } });
  assert.deepEqual(read.data, { dataset_id: dataset, data: { value: "initial fixture value", count: "0" } });
  const write = await client.PUT("/__fixture/value", { params: { header: headers }, body: { value: "metadata workflow", count: "1" } });
  assert.equal(write.response.status, 200);
  const stored = await client.GET("/__fixture/value", { params: { header: headers } });
  assert.deepEqual(stored.data, { dataset_id: dataset, data: { value: "metadata workflow", count: "1" } });
});
console.log("PASS ordinary OpenAPI Path Item metadata constructs and validates real GET/PUT responses");

// Core currently emits lowercase media tokens. Response suppliers exercise HTTP
// case equivalence and authored-key schema lookup through the public adapter.
for (const authoredMedia of ["application/json", "Application/JSON"]) {
  const response = item.get.responses["200"];
  const mediaDocument = { ...protocol, paths: { "/__fixture/value": { get: { responses: { "200": {
    ...response, content: { [authoredMedia]: response.content["application/json"] },
  } } } } } };
  for (const receivedMedia of ["application/json", "Application/JSON", "APPLICATION/JSON; CHARSET=UTF-8"]) {
    for (const valid of [true, false]) {
      const client = createTransport<paths>({ baseUrl: "http://response-adapter.invalid", fetch: async () => new Response(
        JSON.stringify({ dataset_id: dataset, data: { value: "media casing", count: valid ? "1" : 1 } }),
        { status: 200, headers: { ...headers, "Content-Type": receivedMedia } }) });
      client.use(responseValidation(mediaDocument, { datasetId: dataset, protocolVersion: version }));
      if (valid) {
        const result = await client.GET("/__fixture/value", { params: { header: headers } });
        assert.equal(result.data?.data.value, "media casing", `${authoredMedia}/${receivedMedia}`);
      } else {
        await assert.rejects(() => client.GET("/__fixture/value", { params: { header: headers } }),
          (error: unknown) => error instanceof ResponseValidationError && error.reason === "schema");
      }
    }
  }
  const unsupported = createTransport<paths>({ baseUrl: "http://response-adapter.invalid", fetch: async () => new Response(
    '{}', { status: 200, headers: { ...headers, "Content-Type": "text/plain" } }) });
  unsupported.use(responseValidation(mediaDocument, { datasetId: dataset, protocolVersion: version }));
  await assert.rejects(() => unsupported.GET("/__fixture/value", { params: { header: headers } }),
    (error: unknown) => error instanceof ResponseValidationError && error.reason === "media_type");
}
console.log("PASS authored/received media token casing, retained JSON schema checks and unsupported media rejection");
