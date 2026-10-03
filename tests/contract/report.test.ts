import assert from "node:assert/strict";
import { contractValidator, createTransport, responseValidation } from "../../Atlas SDK/src/index.js";
import protocol from "./generated/protocol.json" with { type: "json" };
import type { components, paths } from "./generated/protocol.js";
import reports from "./report-fixtures.json" with { type: "json" };
import { withFixture } from "./runner.js";

const dataset = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const version = "0.2.0";
const headers = { "Atlas-Dataset-ID": dataset, "Atlas-Protocol-Version": version };
const validateReport = contractValidator(protocol).compile<components["schemas"]["FixturePositionReport"]>({
  $ref: "atlas#/components/schemas/FixturePositionReport",
});

for (const mode of ["generated transport", "direct Protocol"]) {
  await withFixture(async ({ baseUrl }) => {
    const client = createTransport<paths>({
      baseUrl, headers, fetch: (request) => fetch(request, { signal: AbortSignal.timeout(5000) }),
    });
    client.use(responseValidation(protocol, { datasetId: dataset, protocolVersion: version }));
    for (const scenario of reports) {
      assert(validateReport(scenario.body), scenario.name);
      if (mode === "generated transport") {
        const written = await client.PUT("/__fixture/report", { params: { header: headers }, body: scenario.body });
        assert.equal(written.response.status, 200, scenario.name);
        assert.deepEqual(written.data, { ...scenario.expected, commit_cursor: "fixture:report:1" }, scenario.name);
        const read = await client.GET("/__fixture/report", { params: { header: headers } });
        assert.equal(read.response.status, 200);
        assert.deepEqual(read.data, scenario.expected, scenario.name);
      } else {
        const written = await fetch(`${baseUrl}/__fixture/report`, {
          method: "PUT", headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(scenario.body), signal: AbortSignal.timeout(5000),
        });
        assert.equal(written.status, 200, scenario.name);
        assert.equal(written.headers.get("Atlas-Dataset-ID"), dataset);
        assert.equal(written.headers.get("Atlas-Protocol-Version"), version);
        assert.deepEqual(await written.json(), { ...scenario.expected, commit_cursor: "fixture:report:1" }, scenario.name);
        const read = await fetch(`${baseUrl}/__fixture/report`, { headers, signal: AbortSignal.timeout(5000) });
        assert.equal(read.status, 200);
        assert.deepEqual(await read.json(), scenario.expected, scenario.name);
      }
    }
  });
  console.log(`PASS ${mode}: ${reports.length} report writes and persisted read-backs`);
}
