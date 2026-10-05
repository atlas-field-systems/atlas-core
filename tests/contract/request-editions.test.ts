import assert from "node:assert/strict";
import { withFixture } from "./runner.js";
import { dataset, fixtureClient, olderVersion, timedFetch, version } from "./support.js";

const input = { value: "artificial edition context fixture", count: "0" };
const stored = { dataset_id: dataset, data: { value: "artificial edition context fixture", count: "0" } };
const committed = { ...stored, commit_cursor: "fixture:commit:1" };

// This checks fixed header representation and echoing only. The independently
// generated older-client compatibility check belongs to the response scenarios.
for (const mode of ["generated transport", "direct Protocol"]) {
  for (const edition of [olderVersion, version]) {
    await withFixture(async ({ baseUrl }) => {
      const headers = { "Atlas-Dataset-ID": dataset, "Atlas-Protocol-Version": edition };
      if (mode === "generated transport") {
        const client = fixtureClient(baseUrl, { headers, protocolVersion: edition });
        const written = await client.PUT("/__fixture/value", { params: { header: headers }, body: input });
        assert.equal(written.response.status, 200);
        assert.equal(written.response.headers.get("Atlas-Protocol-Version"), edition);
        assert.deepEqual(written.data, committed);
        const read = await client.GET("/__fixture/value", { params: { header: headers } });
        assert.equal(read.response.status, 200);
        assert.equal(read.response.headers.get("Atlas-Protocol-Version"), edition);
        assert.deepEqual(read.data, stored);
      } else {
        const written = await timedFetch(`${baseUrl}/__fixture/value`, {
          method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(input),
        });
        assert.equal(written.status, 200);
        assert.equal(written.headers.get("Atlas-Dataset-ID"), dataset);
        assert.equal(written.headers.get("Atlas-Protocol-Version"), edition);
        assert.deepEqual(await written.json(), committed);
        const read = await timedFetch(`${baseUrl}/__fixture/value`, { headers: { ...headers, "Content-Type": "application/json" } });
        assert.equal(read.status, 200);
        assert.equal(read.headers.get("Atlas-Protocol-Version"), edition);
        assert.deepEqual(await read.json(), stored);
      }
    });
  }
  console.log(`PASS ${mode}: fixed supported artificial editions are echoed for write/read context`);
}
