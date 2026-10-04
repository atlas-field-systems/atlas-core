import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { createTransport, responseValidation, ResponseValidationError } from "../../Atlas SDK/src/index.js";
import protocol from "./generated/protocol.json" with { type: "json" };
import type { paths } from "./generated/protocol.js";

const dataset = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const version = "0.2.0";
const headers = { "Atlas-Dataset-ID": dataset, "Atlas-Protocol-Version": version };
const definition = protocol.paths["/__fixture/value"].get.responses["200"];
const document = { ...protocol, paths: { "/__fixture/value": {
  get: { responses: { "200": definition } }, put: { responses: { "200": definition } },
} } };
const bound = 256;
const value = { dataset_id: dataset, data: { value: "船 🚀 �", count: "1" } };
const json = JSON.stringify(value);
const exact = json + " ".repeat(bound - new TextEncoder().encode(json).byteLength);
let wire = new TextEncoder().encode(exact);
let mode: "fixed" | "chunked" | "gzip" | "never-ending" | "binary" = "fixed";
let redirect = false;
let receivedMedia = "application/json";
let mutations = 0;
let streamClosed: Promise<void> = Promise.resolve();
const server = createServer((request, response) => {
  if (redirect && request.url === "/__fixture/value") {
    response.writeHead(302, { Location: "/__fixture/final" }); response.end(); return;
  }
  if (request.method === "PUT") mutations++;
  const bytes = mode === "gzip" ? gzipSync(wire) : wire;
  response.writeHead(200, { ...headers, "Content-Type": mode === "binary" ? "application/octet-stream" : receivedMedia,
    ...(mode === "fixed" || mode === "gzip" || mode === "binary" ? { "Content-Length": String(bytes.byteLength) } : {}),
    ...(mode === "gzip" ? { "Content-Encoding": "gzip" } : {}),
  });
  if (mode === "never-ending") {
    const timer = setInterval(() => response.write(bytes), 10);
    streamClosed = new Promise<void>((resolve) => response.once("close", () => { clearInterval(timer); resolve(); }));
    response.write(bytes);
  } else if (mode === "chunked") {
    response.write(bytes.subarray(0, 100)); response.end(bytes.subarray(100));
  } else response.end(bytes);
});
await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
try {
  const address = server.address(); assert(address !== null && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let fetched: Response | undefined;
  const client = createTransport<paths>({ baseUrl, headers, fetch: async (request) => {
    fetched = await fetch(request, { signal: AbortSignal.timeout(5000) }); return fetched;
  } });
  for (const maxJSONBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => responseValidation(document, { datasetId: dataset, protocolVersion: version }, { maxJSONBytes }),
      /Response JSON byte bound must be a positive safe integer/u);
  }
  // The explicit qualification limit is not a default policy for operational clients.
  client.use(responseValidation(document, { datasetId: dataset, protocolVersion: version }, { maxJSONBytes: bound }));
  wire = new TextEncoder().encode(exact + " ");
  for (const transfer of ["fixed", "chunked", "gzip"] as const) {
    mode = transfer;
    await assert.rejects(() => client.GET("/__fixture/value", { params: { header: headers } }),
      (error: unknown) => error instanceof ResponseValidationError && error.reason === "body_size", transfer);
  }
  console.log("PASS fixed/chunked and compressed JSON responses reject bytes above the explicit bound");
  wire = new TextEncoder().encode(exact);
  for (const transfer of ["fixed", "chunked", "gzip"] as const) {
    mode = transfer;
    const result = await client.GET("/__fixture/value", { params: { header: headers }, parseAs: "text" });
    assert.equal(result.data, exact);
    assert.equal(result.response, fetched);
    assert.equal(result.response.url, `${baseUrl}/__fixture/value`);
    assert.equal(result.response.redirected, false);
    assert.equal(result.response.type, "basic");
  }
  redirect = true;
  const redirected = await client.GET("/__fixture/value", { params: { header: headers }, parseAs: "text" });
  assert.equal(redirected.response, fetched);
  assert.equal(redirected.response.url, `${baseUrl}/__fixture/final`);
  assert.equal(redirected.response.redirected, true);
  assert.equal(redirected.response.type, "basic");
  assert.equal(redirected.data, exact);
  redirect = false;
  console.log("PASS exact-byte-bound Unicode bodies preserve original Response identity, URL, redirect/type and returned bytes");
  mode = "never-ending";
  wire = new TextEncoder().encode(" ".repeat(128));
  await assert.rejects(() => client.GET("/__fixture/value", { params: { header: headers } }),
    (error: unknown) => error instanceof ResponseValidationError && error.reason === "body_size");
  await Promise.race([streamClosed, new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error("oversized response supplier was not cancelled")), 1000);
    streamClosed.finally(() => clearTimeout(timer)).catch(() => {});
  })]);
  receivedMedia = "text/plain";
  await assert.rejects(() => client.GET("/__fixture/value", { params: { header: headers } }),
    (error: unknown) => error instanceof ResponseValidationError && error.reason === "media_type");
  await Promise.race([streamClosed, new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error("refused-media supplier was not cancelled")), 1000);
    streamClosed.finally(() => clearTimeout(timer)).catch(() => {});
  })]);
  receivedMedia = "application/json";
  console.log("PASS oversized and refused-media never-ending suppliers are cancelled before the HTTP timeout");
  mode = "fixed";
  wire = new TextEncoder().encode(exact + " ");
  await assert.rejects(() => client.PUT("/__fixture/value", { params: { header: headers }, body: { value: "committed", count: "1" } }),
    (error: unknown) => error instanceof ResponseValidationError && error.reason === "body_size");
  assert.equal(mutations, 1, "response refusal makes no claim that a mutation did not commit");
  const binaryDocument = { ...document, paths: { "/__fixture/value": { get: { responses: { "200": {
    ...definition, content: { "application/json": definition.content["application/json"],
      "application/octet-stream": { schema: { type: "string", format: "binary" } } },
  } } } } } };
  const binary = createTransport<paths>({ baseUrl, headers });
  binary.use(responseValidation(binaryDocument, { datasetId: dataset, protocolVersion: version }, { maxJSONBytes: bound }));
  mode = "binary";
  wire = new Uint8Array(bound + 1).fill(255);
  const result = await binary.GET("/__fixture/value", { params: { header: headers }, parseAs: "arrayBuffer" });
  assert(result.data !== undefined); assert.deepEqual(new Uint8Array(result.data), wire);
  console.log("PASS JSON refusal preserves unknown mutation outcome and the selected binary representation bypasses the JSON bound");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
