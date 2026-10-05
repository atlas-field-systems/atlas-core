import assert from "node:assert/strict";
import protocol from "./generated/protocol.json" with { type: "json" };
import { withFixture } from "./runner.js";
import { dataset, fixtureClient, headers, isRefusal } from "./support.js";

const adapterOnly = "http://response-adapter.invalid";
const item = protocol.paths["/__fixture/value"];
const document = {
  ...protocol,
  paths: {
    "/__fixture/value": {
      summary: "Shared path metadata",
      description: "Parameters belong to the path",
      servers: [{ url: "http://unused.invalid" }],
      parameters: item.get.parameters,
      get: { responses: item.get.responses },
      put: { responses: item.put.responses },
    },
  },
};
await withFixture(async ({ baseUrl }) => {
  const client = fixtureClient(baseUrl, { document });
  const read = await client.GET("/__fixture/value", { params: { header: headers } });
  assert.deepEqual(read.data, { dataset_id: dataset, data: { value: "initial fixture value", count: "0" } });
  const write = await client.PUT("/__fixture/value", {
    params: { header: headers },
    body: { value: "metadata workflow", count: "1" },
  });
  assert.equal(write.response.status, 200);
  const stored = await client.GET("/__fixture/value", { params: { header: headers } });
  assert.deepEqual(stored.data, { dataset_id: dataset, data: { value: "metadata workflow", count: "1" } });
});
console.log("PASS ordinary OpenAPI Path Item metadata constructs and validates real GET/PUT responses");

// Core currently emits lowercase media tokens. Response suppliers exercise HTTP
// case equivalence and authored-key schema lookup through the public adapter.
for (const authoredMedia of ["application/json", "Application/JSON"]) {
  const response = item.get.responses["200"];
  const mediaDocument = {
    ...protocol,
    paths: {
      "/__fixture/value": {
        get: {
          responses: {
            "200": {
              ...response,
              content: { [authoredMedia]: response.content["application/json"] },
            },
          },
        },
      },
    },
  };
  for (const receivedMedia of ["application/json", "Application/JSON", "APPLICATION/JSON; CHARSET=UTF-8"]) {
    for (const valid of [true, false]) {
      const client = fixtureClient(adapterOnly, {
        document: mediaDocument,
        fetch: async () =>
          new Response(
            JSON.stringify({ dataset_id: dataset, data: { value: "media casing", count: valid ? "1" : 1 } }),
            { status: 200, headers: { ...headers, "Content-Type": receivedMedia } },
          ),
      });
      if (valid) {
        const result = await client.GET("/__fixture/value", { params: { header: headers } });
        assert.equal(result.data?.data.value, "media casing", `${authoredMedia}/${receivedMedia}`);
      } else {
        await assert.rejects(
          () => client.GET("/__fixture/value", { params: { header: headers } }),
          isRefusal("schema"),
        );
      }
    }
  }
  const unsupported = fixtureClient(adapterOnly, {
    document: mediaDocument,
    fetch: async () => new Response("{}", { status: 200, headers: { ...headers, "Content-Type": "text/plain" } }),
  });
  await assert.rejects(
    () => unsupported.GET("/__fixture/value", { params: { header: headers } }),
    isRefusal("media_type"),
  );
}
console.log("PASS authored/received media token casing, retained JSON schema checks and unsupported media rejection");
