import assert from "node:assert/strict";
import { createTransport, responseValidation } from "../../Atlas SDK/src/index.js";
import { withFixture } from "./runner.js";
import protocol from "./generated/protocol.json" with { type: "json" };
import type { paths } from "./generated/protocol.js";

const dataset = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const input = { value: "artificial edition context fixture", count: "0" };

// This checks fixed header representation and echoing only. The independently
// generated older-client compatibility check belongs to the response scenarios.
for (const mode of ["generated transport", "direct Protocol"]) {
  for (const edition of ["0.1.0", "0.2.0"]) {
    await withFixture(async ({ baseUrl }) => {
      const headers = { "Atlas-Dataset-ID": dataset, "Atlas-Protocol-Version": edition };
      if (mode === "generated transport") {
        const client = createTransport<paths>({ baseUrl, headers, fetch: (request) => fetch(request, { signal: AbortSignal.timeout(5000) }) });
        client.use(responseValidation(protocol, { datasetId: dataset, protocolVersion: edition }, { maxJSONBytes: 1_048_576 }));
        const written = await client.PUT("/__fixture/value", { params: { header: headers }, body: input });
        assert.equal(written.response.status, 200);
        assert.equal(written.response.headers.get("Atlas-Protocol-Version"), edition);
        assert.deepEqual(written.data, { dataset_id: dataset, data: { value: "artificial edition context fixture", count: "0" }, commit_cursor: "fixture:commit:1" });
        const read = await client.GET("/__fixture/value", { params: { header: headers } });
        assert.equal(read.response.status, 200);
        assert.equal(read.response.headers.get("Atlas-Protocol-Version"), edition);
        assert.deepEqual(read.data, { dataset_id: dataset, data: { value: "artificial edition context fixture", count: "0" } });
      } else {
        const written = await fetch(`${baseUrl}/__fixture/value`, {
          method: "PUT", headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(input), signal: AbortSignal.timeout(5000),
        });
        assert.equal(written.status, 200);
        assert.equal(written.headers.get("Atlas-Dataset-ID"), dataset);
        assert.equal(written.headers.get("Atlas-Protocol-Version"), edition);
        assert.deepEqual(await written.json(), { dataset_id: dataset, data: { value: "artificial edition context fixture", count: "0" }, commit_cursor: "fixture:commit:1" });
        const read = await fetch(`${baseUrl}/__fixture/value`, { headers: { ...headers, "Content-Type": "application/json" }, signal: AbortSignal.timeout(5000) });
        assert.equal(read.status, 200);
        assert.equal(read.headers.get("Atlas-Protocol-Version"), edition);
        assert.deepEqual(await read.json(), { dataset_id: dataset, data: { value: "artificial edition context fixture", count: "0" } });
      }
    });
  }
  console.log(`PASS ${mode}: fixed supported artificial editions are echoed for write/read context`);
}
