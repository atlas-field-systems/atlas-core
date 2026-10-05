import assert from "node:assert/strict";
import { ResponseValidationError, responseValidation } from "../../Atlas SDK/src/index.js";
import protocol from "./generated/protocol.json" with { type: "json" };
import { dataset, fixtureClient, headers, isRefusal, version, withLoopbackServer } from "./support.js";

const definition = protocol.paths["/__fixture/value"].get.responses["200"];
const documentFor = (responses: Record<string, typeof definition>) => ({
  ...protocol,
  paths: { "/__fixture/value": { get: { responses } } },
});

const expected = { dataset_id: dataset, data: { value: "explicit response status", count: "1" } };
let suppliedStatus = 200;
let body = JSON.stringify(expected);
let requests = 0;
await withLoopbackServer(
  (_request, response) => {
    requests++;
    response.writeHead(suppliedStatus, { ...headers, "Content-Type": "application/json" });
    response.end(body);
  },
  async (baseUrl) => {
    // Check both middleware construction and client installation. Configuration
    // errors must be synchronous, before any request reaches the supplier.
    for (const status of ["default", "1XX", "2XX", "3XX", "4XX", "5XX", "99", "600", "0200", "200\n"]) {
      for (const responses of [{ [status]: definition }, { "200": definition, [status]: definition }]) {
        const document = documentFor(responses);
        for (const construct of [
          () => responseValidation(document, { datasetId: dataset, protocolVersion: version }, { maxJSONBytes: 256 }),
          () => fixtureClient(baseUrl, { document, maxJSONBytes: 256 }),
        ]) {
          assert.throws(construct, (error: unknown) => {
            assert(error instanceof Error);
            assert(
              !(error instanceof ResponseValidationError),
              "configuration failure is not a received-response failure",
            );
            assert.match(error.message, /unsupported/iu);
            assert(error.message.includes(status), "configuration error identifies the unsupported declaration");
            assert(error.message.includes("GET /__fixture/value"), "configuration error identifies the operation");
            return true;
          });
          assert.equal(requests, 0, "invalid response configuration must fail before HTTP traffic");
        }
      }
    }
    console.log("PASS unsupported response statuses fail middleware and client construction before HTTP traffic");

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
    suppliedStatus = 200;
    body = JSON.stringify({ dataset_id: dataset, data: { value: "explicit response status", count: 1 } });
    await assert.rejects(() => client.GET("/__fixture/value", { params: { header: headers } }), isRefusal("schema"));
    assert.equal(requests, 5, "only exact-status controls reach the HTTP supplier");
  },
);
console.log("PASS explicit success and error statuses retain real HTTP validation and typed schema failures");
