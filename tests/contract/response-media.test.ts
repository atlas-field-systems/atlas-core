import assert from "node:assert/strict";
import protocol from "./generated/protocol.json" with { type: "json" };
import { dataset, fixtureClient, headers, isRefusal, otherDataset, version, withLoopbackServer } from "./support.js";

const declaredHeaders = protocol.paths["/__fixture/value"].get.responses["200"].headers;
const expected = { dataset_id: dataset, data: { value: "alternate JSON", count: "1" } };
// The Go fixture has no alternate JSON or mixed-media response declaration.
// This HTTP supplier qualifies the exported adapter with an independent schema.
const schema = {
  type: "object", required: ["dataset_id", "data"], additionalProperties: false,
  properties: {
    dataset_id: { type: "string", format: "uuid" },
    data: { type: "object", required: ["value", "count"], additionalProperties: false,
      properties: { value: { type: "string", enum: ["alternate JSON"] }, count: { type: "string", pattern: "^[0-9]+$" } } },
  },
};
let body: string | Uint8Array = JSON.stringify(expected);
let receivedMedia = "application/problem+json";
let receivedHeaders: Record<string, string> = headers;
let status = 200;
await withLoopbackServer((_request, response) => {
  response.writeHead(status, { ...receivedHeaders, "Content-Type": receivedMedia });
  response.end(body);
}, async (baseUrl) => {
  const clientFor = (content: Record<string, { schema: unknown }>) => fixtureClient(baseUrl, {
    document: { ...protocol, paths: { "/__fixture/value": { get: { responses: { "200": { headers: declaredHeaders, content } } } } } },
  });
  for (const authoredMedia of ["application/problem+json", "Application/Problem+JSON", "application/vnd.atlas.fixture+json"]) {
    const client = clientFor({ [authoredMedia]: { schema } });
    for (const suppliedMedia of [authoredMedia.toLowerCase(), `${authoredMedia.toUpperCase()}; CHARSET=UTF-8`]) {
      receivedMedia = suppliedMedia;
      body = JSON.stringify(expected);
      const valid = await client.GET("/__fixture/value", { params: { header: headers } });
      assert.deepEqual(valid.data, expected);
      body = JSON.stringify({ dataset_id: dataset, data: { value: "alternate JSON", count: 1 } });
      await assert.rejects(() => client.GET("/__fixture/value", { params: { header: headers } }),
        isRefusal("schema"));
      body = '{"dataset_id":';
      await assert.rejects(() => client.GET("/__fixture/value", { params: { header: headers } }),
        isRefusal("json"));
      body = JSON.stringify({ ...expected, dataset_id: otherDataset });
      await assert.rejects(() => client.GET("/__fixture/value", { params: { header: headers } }),
        isRefusal("context"));
    }
  }
  console.log("PASS authored +json schemas, invalid JSON, distinct Dataset mismatch, and media casing/parameters over real HTTP");

  const textSchema = protocol.paths["/__fixture/value"].get.responses["200"].content["application/json"].schema;
  const textClient = clientFor({ "application/json": { schema: textSchema }, "application/problem+json": { schema: textSchema } });
  for (const media of ["application/json", "application/problem+json"]) {
    receivedMedia = media;
    for (const invalidBytes of [[255], [192, 175], [226, 130], [237, 160, 128], [244, 144, 128, 128]]) {
      body = new Uint8Array([...new TextEncoder().encode(`{"dataset_id":"${dataset}","data":{"value":"`), ...invalidBytes,
        ...new TextEncoder().encode('","count":"1"}}')]);
      await assert.rejects(() => textClient.GET("/__fixture/value", { params: { header: headers } }),
        isRefusal("json"));
    }
    for (const [jsonString, value] of [['"船 🚀 �"', "船 🚀 �"], ['"\\ud83d\\ude80"', "🚀"]]) {
      body = new TextEncoder().encode(`{"dataset_id":"${dataset}","data":{"value":${jsonString},"count":"1"}}`);
      const result = await textClient.GET("/__fixture/value", { params: { header: headers } });
      assert.deepEqual(result.data, { dataset_id: dataset, data: { value, count: "1" } });
    }
  }
  console.log("PASS JSON-family UTF-8 rejects corrupted bytes, preserves multibyte/pairs and legitimate U+FFFD, and leaves the body readable");

  body = JSON.stringify({ dataset_id: dataset, data: { value: "ordinary text", count: "1" } });
  for (const media of [
    "application/json; charset", "application/json; charset=", "application/json; =utf-8",
    'application/json; note="unterminated', 'application/json; note="trailing\\',
    "application/json; charset =utf-8", "application/json; charset= utf-8", "application/json; charset=utf-8 extra",
    'application/json; note="closed"garbage', "application /json", "application/json, text/plain",
    "application/json; note=one/two",
  ]) {
    receivedMedia = media;
    await assert.rejects(() => textClient.GET("/__fixture/value", { params: { header: headers } }),
      isRefusal("media_type"), media);
    assert.throws(() => clientFor({ [media]: { schema: textSchema } }), /Response media type declaration has invalid syntax/u);
  }
  assert.throws(() => clientFor({ "": { schema: textSchema } }), /Response media type declaration has invalid syntax/u);
  for (const media of [
    'Application/JSON; CHARSET="UTF-8"', 'application/json; note="semicolon; value"; charset=utf-8',
    'application/json; note="escaped \\"quote\\" and \\\\backslash"',
    'application/json \t; \tnote=""; ; charset=utf-8;', 'application/json; note="tab\tvalue"',
    'application/json; note="\x80\xff"',
  ]) {
    receivedMedia = media;
    const result = await textClient.GET("/__fixture/value", { params: { header: headers } });
    assert.deepEqual(result.data, { dataset_id: dataset, data: { value: "ordinary text", count: "1" } }, media);
  }
  for (const [authored, received] of [
    ['Application/JSON; charset="UTF-8"', "application/json"],
    ['application/problem+json; note="semicolon; value"', "application/problem+json"],
    ["application/json;;charset=utf-8;", "application/json"],
    ["application/json; note=%2F", "application/json"],
    ['application/json; note="100%"', "application/json"],
    ['application/json; note="#"', "application/json"],
  ] as const) {
    const client = clientFor({ [authored]: { schema: textSchema } });
    receivedMedia = received;
    const result = await client.GET("/__fixture/value", { params: { header: headers } });
    assert.deepEqual(result.data, { dataset_id: dataset, data: { value: "ordinary text", count: "1" } }, authored);
  }
  console.log("PASS complete response media syntax rejects malformed parameters/declarations and preserves quoted values, escapes and empty slots");

  // Each JSON representation has a different accepted value. Using either
  // validator for both must fail one success and accept one wrong-media body.
  const ordinarySchema = { type: "object", required: ["data"], properties: {
    data: { type: "object", required: ["value"], properties: { value: { type: "string", enum: ["ordinary JSON"] } } },
  } };
  const mixed = clientFor({ "Application/JSON": { schema: ordinarySchema }, "application/problem+json": { schema },
    "application/octet-stream": { schema: { type: "string", format: "binary" } } });
  const ordinary = { dataset_id: dataset, data: { value: "ordinary JSON", count: "2" } };
  for (const [first, second] of [
    ["application/json", "application/json; profile=alternate"],
    ["application/json", "Application/JSON"],
    ["application/problem+json", 'Application/Problem+JSON; note="alternate"'],
  ] as const) {
    assert.throws(() => clientFor({ [first]: { schema: ordinarySchema }, [second]: { schema } }),
      /Response JSON media declarations have ambiguous normalized keys/u);
  }
  console.log("PASS ambiguous normalized JSON declarations are refused before requests");
  for (const [media, validBody, invalidBody] of [
    ["APPLICATION/JSON; charset=utf-8", ordinary, expected],
    ["Application/Problem+JSON; charset=utf-8", expected, ordinary],
  ] as const) {
    receivedMedia = media;
    body = JSON.stringify(validBody);
    const result = await mixed.GET("/__fixture/value", { params: { header: headers } });
    assert.deepEqual(result.data, validBody);
    body = JSON.stringify(invalidBody);
    await assert.rejects(() => mixed.GET("/__fixture/value", { params: { header: headers } }),
      isRefusal("schema"));
  }
  console.log("PASS differing JSON schemas are selected by received media, including mixed JSON/binary declarations");

  receivedMedia = "Application/Octet-Stream; fixture=bytes";
  body = new Uint8Array([0, 255, 128, 123, 10]);
  const binary = await mixed.GET("/__fixture/value", { params: { header: headers }, parseAs: "arrayBuffer" });
  assert(binary.data !== undefined);
  assert.deepEqual(new Uint8Array(binary.data), new Uint8Array([0, 255, 128, 123, 10]));
  receivedMedia = "image/png";
  await assert.rejects(() => mixed.GET("/__fixture/value", { params: { header: headers }, parseAs: "arrayBuffer" }),
    isRefusal("media_type"));
  receivedMedia = "application/octet-stream";
  receivedHeaders = { "Atlas-Protocol-Version": version };
  await assert.rejects(() => mixed.GET("/__fixture/value", { params: { header: headers }, parseAs: "arrayBuffer" }),
    isRefusal("context"));
  receivedHeaders = { ...headers, "Atlas-Dataset-ID": otherDataset };
  await assert.rejects(() => mixed.GET("/__fixture/value", { params: { header: headers }, parseAs: "arrayBuffer" }),
    isRefusal("context"));
  receivedHeaders = headers;
  status = 202;
  await assert.rejects(() => mixed.GET("/__fixture/value", { params: { header: headers }, parseAs: "arrayBuffer" }),
    isRefusal("status"));
  console.log("PASS selected binary preserves exact bytes and still rejects undeclared media, invalid context and status");
});
