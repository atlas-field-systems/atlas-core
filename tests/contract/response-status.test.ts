import assert from "node:assert/strict";
import { responseValidation } from "../../Atlas SDK/src/index.js";
import protocol from "./generated/protocol.json" with { type: "json" };
import { dataset, fixtureClient, headers, version, withLoopbackServer } from "./support.js";

const definition = protocol.paths["/__fixture/value"].get.responses["200"];
const documentFor = (responses: Record<string, typeof definition>) => ({
  ...protocol,
  paths: { "/__fixture/value": { get: { responses } } },
});

// Unsupported declarations must fail when middleware is installed, before a
// caller can send a request whose successful response would be refused.
for (const status of ["default", "1XX", "2XX", "3XX", "4XX", "5XX", "99", "600", "0200", "200\n"]) {
  for (const responses of [{ [status]: definition }, { "200": definition, [status]: definition }]) {
    assert.throws(
      () =>
        responseValidation(
          documentFor(responses),
          { datasetId: dataset, protocolVersion: version },
          { maxJSONBytes: 256 },
        ),
      /Response status declarations require explicit HTTP codes from 100 to 599/u,
      status,
    );
  }
}
console.log("PASS unsupported response statuses fail construction, including beside an explicit status");

const expected = { dataset_id: dataset, data: { value: "explicit response status", count: "1" } };
let suppliedStatus = 200;
await withLoopbackServer(
  (_request, response) => {
    response.writeHead(suppliedStatus, { ...headers, "Content-Type": "application/json" });
    response.end(JSON.stringify(expected));
  },
  async (baseUrl) => {
    const client = fixtureClient(baseUrl, {
      maxJSONBytes: 256,
      document: documentFor({ "200": definition, "201": definition, "400": definition, "599": definition }),
    });
    for (const status of [200, 201, 400, 599]) {
      suppliedStatus = status;
      const result = await client.GET("/__fixture/value", { params: { header: headers } });
      assert.equal(result.response.status, status);
      assert.deepEqual(status < 400 ? result.data : result.error, expected);
    }
  },
);
console.log("PASS explicit success and error statuses retain real HTTP response validation");
