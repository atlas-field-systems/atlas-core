import assert from "node:assert/strict";
import { withFixture } from "./runner.js";
import olderProtocol from "./older-client.json" with { type: "json" };
import type { paths as OlderPaths } from "./generated/older-client.js";
import { dataset, fixtureClient, headers as currentHeaders, olderVersion, timedFetch, version } from "./support.js";

const oldHeaders = { "Atlas-Dataset-ID": dataset, "Atlas-Protocol-Version": olderVersion };
const expectedAddition = {
  dataset_id: dataset, data: { state: "ready", result: { kind: "value", value: "response fixture" }, label: "new optional field" },
};
const expectedOmission = { dataset_id: dataset, data: { state: "ready", result: { kind: "value", value: "response fixture" } } };
const initial = { dataset_id: dataset, data: { value: "initial fixture value", count: "0" } };

for (const mode of ["generated transport", "direct Protocol"]) {
  await withFixture(async ({ baseUrl }) => {
    if (mode === "generated transport") {
      const older = fixtureClient<OlderPaths>(baseUrl, { headers: oldHeaders, document: olderProtocol, protocolVersion: olderVersion });
      const addition = await older.GET("/__fixture/response/read", { params: { header: oldHeaders } });
      assert.equal(addition.response.status, 200);
      assert.equal(addition.response.headers.get("Atlas-Protocol-Version"), olderVersion);
      assert.deepEqual(addition.data, expectedAddition);
      const current = fixtureClient(baseUrl);
      const omission = await current.GET("/__fixture/response/read", { params: { header: currentHeaders, query: { fault: "omit_optional" } } });
      assert.deepEqual(omission.data, expectedOmission);
      assert.equal(omission.response.headers.get("Atlas-Protocol-Version"), version);
      const unsupportedHeaders = { ...currentHeaders, "Atlas-Protocol-Version": "9.0.0" };
      const unsupported = await current.GET("/__fixture/response/read", { params: { header: unsupportedHeaders } });
      assert.equal(unsupported.response.status, 426);
      assert.equal(unsupported.error?.error.code, "unsupported_protocol");
      assert.equal(unsupported.error?.dataset_id, dataset);
    } else {
      const addition = await timedFetch(`${baseUrl}/__fixture/response/read`, { headers: oldHeaders });
      assert.equal(addition.status, 200);
      assert.equal(addition.headers.get("Atlas-Protocol-Version"), olderVersion);
      assert.deepEqual(await addition.json(), expectedAddition);
      const omission = await timedFetch(`${baseUrl}/__fixture/response/read?fault=omit_optional`, { headers: currentHeaders });
      assert.equal(omission.status, 200);
      assert.deepEqual(await omission.json(), expectedOmission);
      const unsupported = await timedFetch(`${baseUrl}/__fixture/response/read`,
        { headers: { ...currentHeaders, "Atlas-Protocol-Version": "9.0.0" } });
      assert.equal(unsupported.status, 426);
      assert.equal(unsupported.headers.get("Atlas-Protocol-Version"), version);
      const refusal: unknown = await unsupported.json();
      assert(typeof refusal === "object" && refusal !== null && "error" in refusal);
      assert(typeof refusal.error === "object" && refusal.error !== null && "code" in refusal.error);
      assert.equal(refusal.error.code, "unsupported_protocol");
    }
    const persisted = await timedFetch(`${baseUrl}/__fixture/value`, { headers: currentHeaders });
    assert.deepEqual(await persisted.json(), initial);
  });
  console.log(`PASS ${mode}: artificial older/current optional addition and unsupported-edition refusal without effects`);
}
