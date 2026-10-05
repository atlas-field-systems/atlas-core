import assert from "node:assert/strict";
import { withFixture } from "./runner.js";
import { dataset, fixtureClient, headers, pinnedSQLiteVersion, timedFetch, version } from "./support.js";

// Expectations are literals authored from the fixture contract, independent of
// the handler, query code and generated bindings.
const input = { value: "Slice 0: stored through real SQLite", count: "9007199254740993" };
const expected = { dataset_id: dataset, data: input, commit_cursor: "fixture:commit:1" };

for (const mode of ["generated transport", "direct Protocol"]) {
  await withFixture(async ({ baseUrl, sqliteVersion, journalMode }) => {
    assert.equal(sqliteVersion, pinnedSQLiteVersion);
    assert.equal(journalMode, "wal");
    if (mode === "generated transport") {
      const client = fixtureClient(baseUrl);
      const written = await client.PUT("/__fixture/value", { params: { header: headers }, body: input });
      assert.equal(written.response.status, 200);
      assert.deepEqual(written.data, expected);
      const read = await client.GET("/__fixture/value", { params: { header: headers } });
      assert.equal(read.response.status, 200);
      assert.deepEqual(read.data, { dataset_id: dataset, data: input });
    } else {
      const written = await timedFetch(`${baseUrl}/__fixture/value`, {
        method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(input),
      });
      assert.equal(written.status, 200);
      assert.equal(written.headers.get("Atlas-Dataset-ID"), dataset);
      assert.equal(written.headers.get("Atlas-Protocol-Version"), version);
      assert.deepEqual(await written.json(), expected);
      const read = await timedFetch(`${baseUrl}/__fixture/value`, { headers });
      assert.equal(read.status, 200);
      assert.deepEqual(await read.json(), { dataset_id: dataset, data: input });
    }
  });
  console.log(`PASS ${mode}: write and persisted read-back`);
}
