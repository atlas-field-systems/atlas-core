import assert from "node:assert/strict";
import { createTransport, responseValidation } from "../../Atlas SDK/src/index.js";
import { withFixture } from "./runner.js";
import protocol from "./generated/protocol.json" with { type: "json" };
import olderProtocol from "./older-client.json" with { type: "json" };
import type { paths } from "./generated/protocol.js";
import type { paths as OlderPaths } from "./generated/older-client.js";

const dataset = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const oldHeaders = { "Atlas-Dataset-ID": dataset, "Atlas-Protocol-Version": "0.1.0" };
const currentHeaders = { "Atlas-Dataset-ID": dataset, "Atlas-Protocol-Version": "0.2.0" };
const expectedAddition = { dataset_id: dataset, data: { state: "ready", result: { kind: "value", value: "response fixture" }, label: "new optional field" } };
const expectedOmission = { dataset_id: dataset, data: { state: "ready", result: { kind: "value", value: "response fixture" } } };
const initial = { dataset_id: dataset, data: { value: "initial fixture value", count: "0" } };

for (const mode of ["generated transport", "direct Protocol"]) {
  await withFixture(async ({ baseUrl }) => {
    if (mode === "generated transport") {
      const older = createTransport<OlderPaths>({ baseUrl, headers: oldHeaders, fetch: (request) => fetch(request, { signal: AbortSignal.timeout(5000) }) });
      older.use(responseValidation(olderProtocol, { datasetId: dataset, protocolVersion: "0.1.0" }));
      const addition = await older.GET("/__fixture/response/read", { params: { header: oldHeaders } });
      assert.equal(addition.response.status, 200);
      assert.equal(addition.response.headers.get("Atlas-Protocol-Version"), "0.1.0");
      assert.deepEqual(addition.data, expectedAddition);
      const current = createTransport<paths>({ baseUrl, headers: currentHeaders, fetch: (request) => fetch(request, { signal: AbortSignal.timeout(5000) }) });
      current.use(responseValidation(protocol, { datasetId: dataset, protocolVersion: "0.2.0" }));
      const omission = await current.GET("/__fixture/response/read", { params: { header: currentHeaders, query: { fault: "omit_optional" } } });
      assert.deepEqual(omission.data, expectedOmission);
      assert.equal(omission.response.headers.get("Atlas-Protocol-Version"), "0.2.0");
      const unsupported = await current.GET("/__fixture/response/read", { params: { header: { ...currentHeaders, "Atlas-Protocol-Version": "9.0.0" } } });
      assert.equal(unsupported.response.status, 426);
      assert.equal(unsupported.error?.error.code, "unsupported_protocol");
      assert.equal(unsupported.error?.dataset_id, dataset);
    } else {
      const addition = await fetch(`${baseUrl}/__fixture/response/read`, { headers: oldHeaders, signal: AbortSignal.timeout(5000) });
      assert.equal(addition.status, 200);
      assert.equal(addition.headers.get("Atlas-Protocol-Version"), "0.1.0");
      assert.deepEqual(await addition.json(), expectedAddition);
      const omission = await fetch(`${baseUrl}/__fixture/response/read?fault=omit_optional`, { headers: currentHeaders, signal: AbortSignal.timeout(5000) });
      assert.equal(omission.status, 200);
      assert.deepEqual(await omission.json(), expectedOmission);
      const unsupported = await fetch(`${baseUrl}/__fixture/response/read`, { headers: { ...currentHeaders, "Atlas-Protocol-Version": "9.0.0" }, signal: AbortSignal.timeout(5000) });
      assert.equal(unsupported.status, 426);
      assert.equal(unsupported.headers.get("Atlas-Protocol-Version"), "0.2.0");
      const refusal: unknown = await unsupported.json();
      assert(typeof refusal === "object" && refusal !== null && "error" in refusal);
      assert(typeof refusal.error === "object" && refusal.error !== null && "code" in refusal.error);
      assert.equal(refusal.error.code, "unsupported_protocol");
    }
    const persisted = await fetch(`${baseUrl}/__fixture/value`, { headers: currentHeaders, signal: AbortSignal.timeout(5000) });
    assert.deepEqual(await persisted.json(), initial);
  });
  console.log(`PASS ${mode}: artificial older/current optional addition and unsupported-edition refusal without effects`);
}
