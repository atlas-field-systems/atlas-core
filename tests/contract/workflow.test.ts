import assert from "node:assert/strict";
import { createTransport, responseValidation } from "../../Atlas SDK/src/index.js";
import { withFixture } from "./runner.js";
import protocol from "./generated/protocol.json" with { type: "json" };
import type { paths } from "./generated/protocol.js";

// Expectations are literals authored from the fixture contract, independent of
// the handler, query code and generated bindings.
const dataset = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const version = "0.2.0";
const headers = { "Atlas-Dataset-ID": dataset, "Atlas-Protocol-Version": version };
const input = { value: "Slice 0: stored through real SQLite", count: "9007199254740993" };
const expected = { dataset_id: dataset, data: input, commit_cursor: "fixture:commit:1" };

for (const mode of ["generated transport", "direct Protocol"]) {
  await withFixture(async ({ baseUrl, sqliteVersion, journalMode }) => {
    assert.equal(sqliteVersion, "3.53.4");
    assert.equal(journalMode, "wal");
    if (mode === "generated transport") {
      const client = createTransport<paths>({ baseUrl, headers, fetch: (request) => fetch(request, { signal: AbortSignal.timeout(5000) }) });
      client.use(responseValidation(protocol, { datasetId: dataset, protocolVersion: version }));
      const written = await client.PUT("/__fixture/value", { params: { header: headers }, body: input });
      assert.equal(written.response.status, 200);
      assert.deepEqual(written.data, expected);
      const read = await client.GET("/__fixture/value", { params: { header: headers } });
      assert.equal(read.response.status, 200);
      assert.deepEqual(read.data, { dataset_id: dataset, data: input });
    } else {
      const written = await fetch(`${baseUrl}/__fixture/value`, {
        method: "PUT", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(input), signal: AbortSignal.timeout(5000),
      });
      assert.equal(written.status, 200);
      assert.equal(written.headers.get("Atlas-Dataset-ID"), dataset);
      assert.equal(written.headers.get("Atlas-Protocol-Version"), version);
      assert.deepEqual(await written.json(), expected);
      const read = await fetch(`${baseUrl}/__fixture/value`, { headers, signal: AbortSignal.timeout(5000) });
      assert.equal(read.status, 200);
      assert.deepEqual(await read.json(), { dataset_id: dataset, data: input });
    }
  });
  console.log(`PASS ${mode}: write and persisted read-back`);
}
