import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createTransport, responseValidation, ResponseValidationError } from "../../Atlas SDK/src/index.js";
import protocol from "./generated/protocol.json" with { type: "json" };
import type { paths } from "./generated/protocol.js";

const dataset = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const version = "0.2.0";
const headers = { "Atlas-Dataset-ID": dataset, "Atlas-Protocol-Version": version };
const expected = { dataset_id: dataset, data: { value: "reference identity", count: "1" } };
const definition = protocol.paths["/__fixture/value"].get.responses["200"];
let suppliedHeaders: Record<string, string> = headers;
const server = createServer((_request, response) => {
  response.writeHead(200, { ...suppliedHeaders, "Content-Type": "application/json" });
  response.end(JSON.stringify(expected));
});
await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
try {
  const address = server.address(); assert(address !== null && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const clientFor = (reference: string) => {
    const document = { ...protocol, paths: { "/__fixture/value": { get: { responses: { "200": {
      ...definition, headers: { ...definition.headers, "Atlas-Dataset-ID": { $ref: reference } },
    } } } } } };
    const client = createTransport<paths>({ baseUrl, headers,
      fetch: (request) => fetch(request, { signal: AbortSignal.timeout(5000) }) });
    client.use(responseValidation(document, { datasetId: dataset, protocolVersion: version }, { maxJSONBytes: 256 }));
    return client;
  };
  // Independently authored URI spellings identify the same existing Header
  // Object. Encoding applies to the fragment, including pointer separators.
  for (const reference of [
    "#/components/headers/Atlas-Dataset-ID",
    "#/components/headers/%41tlas-Dataset-ID",
    "#/components/headers/Atlas%2DDataset%2DID",
    "#%2Fcomponents%2Fheaders%2FAtlas-Dataset-ID",
  ]) {
    const client = clientFor(reference);
    suppliedHeaders = headers;
    const result = await client.GET("/__fixture/value", { params: { header: headers } });
    assert.deepEqual(result.data, expected, reference);
    for (const invalidHeaders of [
      { "Atlas-Protocol-Version": version },
      { ...headers, "Atlas-Dataset-ID": "invalid-uuid" },
      { ...headers, "Atlas-Dataset-ID": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    ]) {
      suppliedHeaders = invalidHeaders;
      await assert.rejects(() => client.GET("/__fixture/value", { params: { header: headers } }),
        (error: unknown) => error instanceof ResponseValidationError && error.reason === "context", reference);
    }
  }
  console.log("PASS equivalent literal/encoded local header references preserve real HTTP body, required-header, UUID and context checks");

  assert.throws(() => clientFor("#/components/headers/%4Dissing"), /Response header reference is unresolved/u);
  assert.throws(() => clientFor("#/components/headers/%ZZ"), URIError);
  for (const reference of [
    "https://example.invalid/contract.json#/components/headers/Atlas-Dataset-ID",
    "%23/components/headers/Atlas-Dataset-ID",
    "#/components/schemas/Atlas-Dataset-ID",
  ]) {
    assert.throws(() => clientFor(reference), /Response headers require local component references/u);
  }
  console.log("PASS unresolved, malformed and unsupported header references still fail construction");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
