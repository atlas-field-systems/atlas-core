import assert from "node:assert/strict";
import protocol from "./generated/protocol.json" with { type: "json" };
import { dataset, fixtureClient, headers, isRefusal, otherDataset, version, withLoopbackServer } from "./support.js";

const expected = { dataset_id: dataset, data: { value: "reference identity", count: "1" } };
const definition = protocol.paths["/__fixture/value"].get.responses["200"];
let suppliedHeaders: Record<string, string> = headers;
await withLoopbackServer(
  (_request, response) => {
    response.writeHead(200, { ...suppliedHeaders, "Content-Type": "application/json" });
    response.end(JSON.stringify(expected));
  },
  async (baseUrl) => {
    const clientFor = (reference: string) =>
      fixtureClient(baseUrl, {
        maxJSONBytes: 256,
        document: {
          ...protocol,
          paths: {
            "/__fixture/value": {
              get: {
                responses: {
                  "200": {
                    ...definition,
                    headers: { ...definition.headers, "Atlas-Dataset-ID": { $ref: reference } },
                  },
                },
              },
            },
          },
        },
      });
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
        { ...headers, "Atlas-Dataset-ID": otherDataset },
      ]) {
        suppliedHeaders = invalidHeaders;
        await assert.rejects(
          () => client.GET("/__fixture/value", { params: { header: headers } }),
          isRefusal("context"),
          reference,
        );
      }
    }
    console.log(
      "PASS equivalent literal/encoded local header references preserve real HTTP body, required-header, UUID and context checks",
    );

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
  },
);

// S1 operations share one error Response Object by local reference. The
// referenced component keeps every body, header and context check of an inline
// Response Object.
let suppliedBody: unknown = expected;
await withLoopbackServer(
  (_request, response) => {
    response.writeHead(200, { ...suppliedHeaders, "Content-Type": "application/json" });
    response.end(JSON.stringify(suppliedBody));
  },
  async (baseUrl) => {
    const clientFor = (
      reference: string,
      responses: Record<string, typeof definition | { $ref: string }> = { FixtureValue: definition },
    ) =>
      fixtureClient(baseUrl, {
        maxJSONBytes: 256,
        document: {
          ...protocol,
          components: { ...protocol.components, responses },
          paths: { "/__fixture/value": { get: { responses: { "200": { $ref: reference } } } } },
        },
      });
    for (const reference of [
      "#/components/responses/FixtureValue",
      "#/components/responses/%46ixtureValue",
      "#%2Fcomponents%2Fresponses%2FFixtureValue",
    ]) {
      const client = clientFor(reference);
      suppliedHeaders = headers;
      suppliedBody = expected;
      const result = await client.GET("/__fixture/value", { params: { header: headers } });
      assert.deepEqual(result.data, expected, reference);
      for (const [invalidHeaders, invalidBody, reason] of [
        [{ "Atlas-Protocol-Version": version }, expected, "context"],
        [{ ...headers, "Atlas-Dataset-ID": otherDataset }, expected, "context"],
        [headers, { ...expected, dataset_id: otherDataset }, "context"],
        [headers, { dataset_id: dataset, data: { value: 1, count: "1" } }, "schema"],
      ] as const) {
        suppliedHeaders = invalidHeaders;
        suppliedBody = invalidBody;
        await assert.rejects(
          () => client.GET("/__fixture/value", { params: { header: headers } }),
          isRefusal(reason),
          `${reference} ${reason}`,
        );
      }
    }
    console.log("PASS literal/encoded local Response Object references keep body schema, header and context checks");

    assert.throws(() => clientFor("#/components/responses/Missing"), /Response reference is unresolved/u);
    assert.throws(
      () =>
        clientFor("#/components/responses/Chained", {
          Chained: { $ref: "#/components/responses/FixtureValue" },
          FixtureValue: definition,
        }),
      /Response reference is unresolved/u,
    );
    for (const reference of [
      "https://example.invalid/contract.json#/components/responses/FixtureValue",
      "#/components/schemas/FixtureValue",
    ]) {
      assert.throws(() => clientFor(reference), /Responses require local component references/u);
    }
    console.log("PASS missing, chained, external and non-response references fail construction");
  },
);
