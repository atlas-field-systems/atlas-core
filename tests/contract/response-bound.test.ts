import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { responseValidation } from "../../Atlas SDK/src/index.js";
import protocol from "./generated/protocol.json" with { type: "json" };
import {
  dataset,
  fixtureClient,
  headers,
  isRefusal,
  timedFetch,
  version,
  withLoopbackServer,
  within,
} from "./support.js";

const definition = protocol.paths["/__fixture/value"].get.responses["200"];
const document = {
  ...protocol,
  paths: {
    "/__fixture/value": {
      get: { responses: { "200": definition } },
      put: { responses: { "200": definition } },
    },
  },
};
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

await withLoopbackServer(
  (request, response) => {
    if (redirect && request.url === "/__fixture/value") {
      response.writeHead(302, { Location: "/__fixture/final" });
      response.end();
      return;
    }
    if (request.method === "PUT") mutations++;
    const bytes = mode === "gzip" ? gzipSync(wire) : wire;
    response.writeHead(200, {
      ...headers,
      "Content-Type": mode === "binary" ? "application/octet-stream" : receivedMedia,
      ...(mode === "fixed" || mode === "gzip" || mode === "binary"
        ? { "Content-Length": String(bytes.byteLength) }
        : {}),
      ...(mode === "gzip" ? { "Content-Encoding": "gzip" } : {}),
    });
    if (mode === "never-ending") {
      const timer = setInterval(() => response.write(bytes), 10);
      streamClosed = new Promise<void>((resolve) =>
        response.once("close", () => {
          clearInterval(timer);
          resolve();
        }),
      );
      response.write(bytes);
    } else if (mode === "chunked") {
      response.write(bytes.subarray(0, 100));
      response.end(bytes.subarray(100));
    } else response.end(bytes);
  },
  async (baseUrl) => {
    let fetched: Response | undefined;
    const fetchAndKeep = async (request: Request) => {
      fetched = await timedFetch(request);
      return fetched;
    };
    for (const maxJSONBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => responseValidation(document, { datasetId: dataset, protocolVersion: version }, { maxJSONBytes }),
        /Response JSON byte bound must be a positive safe integer/u,
      );
    }
    // The explicit qualification limit is not a default policy for operational clients.
    const client = fixtureClient(baseUrl, { document, maxJSONBytes: bound, fetch: fetchAndKeep });
    wire = new TextEncoder().encode(exact + " ");
    for (const transfer of ["fixed", "chunked", "gzip"] as const) {
      mode = transfer;
      await assert.rejects(
        () => client.GET("/__fixture/value", { params: { header: headers } }),
        isRefusal("body_size"),
        transfer,
      );
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
    console.log(
      "PASS exact-byte-bound Unicode bodies preserve original Response identity, URL, redirect/type and returned bytes",
    );
    mode = "never-ending";
    wire = new TextEncoder().encode(" ".repeat(128));
    await assert.rejects(() => client.GET("/__fixture/value", { params: { header: headers } }), isRefusal("body_size"));
    await within(streamClosed, 1000, "oversized response supplier was not cancelled");
    receivedMedia = "text/plain";
    await assert.rejects(
      () => client.GET("/__fixture/value", { params: { header: headers } }),
      isRefusal("media_type"),
    );
    await within(streamClosed, 1000, "refused-media supplier was not cancelled");
    receivedMedia = "application/json";
    console.log("PASS oversized and refused-media never-ending suppliers are cancelled before the HTTP timeout");
    mode = "fixed";
    wire = new TextEncoder().encode(exact + " ");
    await assert.rejects(
      () => client.PUT("/__fixture/value", { params: { header: headers }, body: { value: "committed", count: "1" } }),
      isRefusal("body_size"),
    );
    assert.equal(mutations, 1, "response refusal does not establish absence of a server-side effect");
    const binaryDocument = {
      ...document,
      paths: {
        "/__fixture/value": {
          get: {
            responses: {
              "200": {
                ...definition,
                content: {
                  "application/json": definition.content["application/json"],
                  "application/octet-stream": { schema: { type: "string", format: "binary" } },
                },
              },
            },
          },
        },
      },
    };
    const binary = fixtureClient(baseUrl, { document: binaryDocument, maxJSONBytes: bound });
    mode = "binary";
    wire = new Uint8Array(bound + 1).fill(255);
    const result = await binary.GET("/__fixture/value", { params: { header: headers }, parseAs: "arrayBuffer" });
    assert(result.data !== undefined);
    assert.deepEqual(new Uint8Array(result.data), wire);
    console.log(
      "PASS oversized PUT response refusal follows a supplier effect and selected binary bypasses the JSON bound",
    );
  },
);
