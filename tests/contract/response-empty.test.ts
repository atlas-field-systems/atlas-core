import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createTransport, responseValidation, ResponseValidationError } from "../../Atlas SDK/src/index.js";
import protocol from "./generated/protocol.json" with { type: "json" };
import type { paths } from "./generated/protocol.js";

const dataset = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const version = "0.2.0";
const headers = { "Atlas-Dataset-ID": dataset, "Atlas-Protocol-Version": version };
// A 200 can carry bytes over HTTP. The existing 204 fixture cannot expose a
// supplier violating an authored no-content declaration because Fetch strips it.
const document = { ...protocol, paths: { "/__fixture/value": { get: { responses: { "200": {
  description: "Empty fixture reply", headers: protocol.paths["/__fixture/value"].get.responses["200"].headers,
} } } } } };
let wire = new Uint8Array();
let mode: "fixed" | "chunked" | "never-ending" = "fixed";
let suppliedHeaders: Record<string, string> = headers;
let supplierClosed: Promise<void> | undefined;
const server = createServer((_request, response) => {
  response.writeHead(200, { ...suppliedHeaders,
    ...(mode === "fixed" ? { "Content-Length": String(wire.byteLength) } : { "Transfer-Encoding": "chunked" }),
  });
  if (mode === "never-ending") {
    supplierClosed = new Promise<void>((resolve) => response.once("close", resolve));
    response.write(wire);
  } else if (mode === "chunked") {
    response.write(wire.subarray(0, 1)); response.end(wire.subarray(1));
  } else response.end(wire);
});
await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
try {
  const address = server.address(); assert(address !== null && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let fetched: Response | undefined;
  const client = createTransport<paths>({ baseUrl, headers, fetch: async (request) => {
    fetched = await fetch(request, { signal: AbortSignal.timeout(5000) }); return fetched;
  } });
  client.use(responseValidation(document, { datasetId: dataset, protocolVersion: version }, { maxJSONBytes: 256 }));
  for (const transfer of ["fixed", "chunked"] as const) {
    mode = transfer;
    const result = await client.GET("/__fixture/value", { params: { header: headers } });
    assert.equal(result.data, undefined);
    assert.equal(result.response, fetched);
    assert.equal(result.response.url, `${baseUrl}/__fixture/value`);
    assert.equal(result.response.headers.get("Atlas-Dataset-ID"), dataset);
    assert.equal(result.response.headers.get("Atlas-Protocol-Version"), version);
    assert.equal(result.response.headers.get("Content-Type"), null);
  }
  console.log("PASS fixed/chunked empty 200 responses preserve declared context and original Response metadata");

  for (const transfer of ["fixed", "chunked"] as const) {
    mode = transfer;
    for (const body of ['{"unexpected":true}', " ", new Uint8Array([0, 255])]) {
      wire = typeof body === "string" ? new TextEncoder().encode(body) : body;
      await assert.rejects(() => client.GET("/__fixture/value", { params: { header: headers } }),
        (error: unknown) => error instanceof ResponseValidationError && error.reason === "body" && error.status === 200);
    }
  }
  console.log("PASS no-content declarations reject JSON, whitespace and binary bytes without Content-Type");

  mode = "never-ending";
  wire = new Uint8Array([1]);
  await assert.rejects(() => client.GET("/__fixture/value", { params: { header: headers }, parseAs: "stream" }),
    (error: unknown) => error instanceof ResponseValidationError && error.reason === "body");
  assert(supplierClosed !== undefined);
  await Promise.race([supplierClosed, new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error("undeclared-body supplier was not cancelled")), 1000);
    supplierClosed?.finally(() => clearTimeout(timer)).catch(() => {});
  })]);
  console.log("PASS the first undeclared body byte rejects and cancels a supplier that never finishes");

  mode = "fixed";
  wire = new Uint8Array();
  for (const invalidHeaders of [
    { "Atlas-Protocol-Version": version },
    { ...headers, "Atlas-Dataset-ID": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    { ...headers, "Atlas-Protocol-Version": "9.0.0" },
  ]) {
    suppliedHeaders = invalidHeaders;
    await assert.rejects(() => client.GET("/__fixture/value", { params: { header: headers } }),
      (error: unknown) => error instanceof ResponseValidationError && error.reason === "context");
  }
  suppliedHeaders = { ...headers, "Content-Type": "application/json" };
  await assert.rejects(() => client.GET("/__fixture/value", { params: { header: headers } }),
    (error: unknown) => error instanceof ResponseValidationError && error.reason === "media_type");
  console.log("PASS empty responses retain required context and undeclared media rejection");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
