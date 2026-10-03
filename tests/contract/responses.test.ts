import assert from "node:assert/strict";
import { createTransport, responseValidation, ResponseValidationError } from "../../Atlas SDK/src/index.js";
import { withFixture } from "./runner.js";
import protocol from "./generated/protocol.json" with { type: "json" };
import fixtures from "./response-fixtures.json" with { type: "json" };
import type { paths } from "./generated/protocol.js";

const dataset = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const version = "0.2.0";
const headers = { "Atlas-Dataset-ID": dataset, "Atlas-Protocol-Version": version };
const read = { dataset_id: dataset, data: { state: "ready", result: { kind: "value", value: "response fixture" }, label: "new optional field" } };
const error = { dataset_id: dataset, error: { code: "fixture_refusal", message: "Fixture read refused", request_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", details: { retryable: false, scope: "read fixture" } } };
const openapi = { openapi: "3.0.3", info: { title: "Raw fixture contract", version }, paths: {} };
const initial = { dataset_id: dataset, data: { value: "initial fixture value", count: "0" } };
type ResponsePath = Extract<keyof paths, `/__fixture/response/${string}`>;
const routes: Record<string, ResponsePath> = {
  read: "/__fixture/response/read", mutation: "/__fixture/response/mutation", error: "/__fixture/response/error",
  openapi: "/__fixture/response/openapi", empty: "/__fixture/response/empty", binary: "/__fixture/response/binary",
};

for (const mode of ["generated transport", "direct Protocol"]) {
  await withFixture(async ({ baseUrl }) => {
    const client = createTransport<paths>({ baseUrl, headers, fetch: (request) => fetch(request, { signal: AbortSignal.timeout(5000) }) });
    client.use(responseValidation(protocol, { datasetId: dataset, protocolVersion: version }));
    if (mode === "generated transport") {
      const validRead = await client.GET("/__fixture/response/read", { params: { header: headers } });
      assert.deepEqual(validRead.data, read);
      assert.equal(validRead.response.headers.get("Fixture-Receipt"), "receipt:17");
      const withOptionalHeader = await client.GET("/__fixture/response/read", { params: { header: headers, query: { fault: "valid_optional_header" } } });
      assert.deepEqual(withOptionalHeader.data, read);
      assert.equal(withOptionalHeader.response.headers.get("Fixture-Note"), "optional");
      const mutationEnvelope = await client.GET("/__fixture/response/mutation", { params: { header: headers } });
      assert.deepEqual(mutationEnvelope.data, { ...read, commit_cursor: "fixture:commit:17" });
      const refused = await client.GET("/__fixture/response/error", { params: { header: headers } });
      assert.equal(refused.response.status, 400);
      assert.deepEqual(refused.error, error);
      const rawContract = await client.GET("/__fixture/response/openapi", { params: { header: headers } });
      assert.deepEqual(rawContract.data, openapi);
      const empty = await client.GET("/__fixture/response/empty", { params: { header: headers } });
      assert.equal(empty.response.status, 204);
      assert.equal(empty.data, undefined);
      const binary = await client.GET("/__fixture/response/binary", { params: { header: headers }, parseAs: "arrayBuffer" });
      assert.equal(binary.response.headers.get("Content-Type"), "application/octet-stream");
      assert.equal(binary.response.headers.get("Content-Length"), "3");
      assert.equal(binary.response.headers.get("Fixture-Digest"), "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      assert.equal(binary.data?.byteLength, 3);
    } else {
      for (const [route, expected, status] of [
        ["/__fixture/response/read", read, 200],
        ["/__fixture/response/mutation", { ...read, commit_cursor: "fixture:commit:17" }, 200],
        ["/__fixture/response/error", error, 400],
        ["/__fixture/response/openapi", openapi, 200],
      ] as const) {
        const response = await fetch(`${baseUrl}${route}`, { headers, signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, status);
        assert.equal(response.headers.get("Atlas-Dataset-ID"), dataset);
        assert.equal(response.headers.get("Atlas-Protocol-Version"), version);
        assert.deepEqual(await response.json(), expected);
      }
      const empty = await fetch(`${baseUrl}/__fixture/response/empty`, { headers, signal: AbortSignal.timeout(5000) });
      assert.equal(empty.status, 204);
      assert.equal(empty.headers.get("Content-Type"), null);
      assert.equal((await empty.arrayBuffer()).byteLength, 0);
      const binary = await fetch(`${baseUrl}/__fixture/response/binary`, { headers, signal: AbortSignal.timeout(5000) });
      assert.equal(binary.status, 200);
      assert.equal(binary.headers.get("Content-Type"), "application/octet-stream");
      assert.equal(binary.headers.get("Content-Length"), "3");
      assert.equal(binary.headers.get("Fixture-Digest"), "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      assert.equal((await binary.arrayBuffer()).byteLength, 3);
    }
    for (const fixture of fixtures) {
      if (!("reason" in fixture)) continue;
      const route = routes[fixture.kind];
      assert(route, `unknown independent fixture kind ${fixture.kind}`);
      if (mode === "generated transport") {
        await assert.rejects(() => client.GET(route, { params: { header: headers, query: { fault: fixture.fault } }, parseAs: "arrayBuffer" }),
          (failure: unknown) => {
            assert(failure instanceof ResponseValidationError, `${fixture.kind}/${fixture.fault} is a typed validation failure`);
            assert.equal(failure.reason, fixture.reason, `${fixture.kind}/${fixture.fault}`);
            assert.equal(failure.status, fixture.status);
            assert.equal(failure.operation, `GET ${route}`);
            assert.equal(failure.message, `Invalid Protocol response for GET ${route} (${fixture.status}): ${fixture.reason}`);
            return true;
          });
      } else {
        const response = await fetch(`${baseUrl}${route}?fault=${encodeURIComponent(fixture.fault)}`, { headers, signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, fixture.status, fixture.fault);
        for (const [name, value] of Object.entries(fixture.headers)) {
          if (!fixture.omit_headers.some((omitted) => omitted === name)) assert.equal(response.headers.get(name), value, fixture.fault);
        }
        for (const name of fixture.omit_headers) assert.equal(response.headers.get(name), null, fixture.fault);
        assert.equal(await response.text(), fixture.body, fixture.fault);
      }
    }
    const persisted = await fetch(`${baseUrl}/__fixture/value`, { headers, signal: AbortSignal.timeout(5000) });
    assert.deepEqual(await persisted.json(), initial);
  });
  console.log(`PASS ${mode}: response envelopes, exceptions and independent corruption corpus; fixture state preserved`);
}
