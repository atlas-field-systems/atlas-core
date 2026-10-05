import assert from "node:assert/strict";
import { ResponseValidationError } from "../../Atlas SDK/src/index.js";
import protocol from "./generated/protocol.json" with { type: "json" };
import { dataset, fixtureClient, headers, isRefusal, withLoopbackServer } from "./support.js";

const definition = protocol.paths["/__fixture/value"].get.responses["200"];
const expected = { dataset_id: dataset, data: { value: "exact status", count: "1" } };
let body = JSON.stringify(expected);
let requests = 0;
await withLoopbackServer(
  (_request, response) => {
    requests++;
    response.writeHead(200, { ...headers, "Content-Type": "application/json" });
    response.end(body);
  },
  async (baseUrl) => {
    for (const status of ["default", "1XX", "2XX", "3XX", "4XX", "5XX"]) {
      for (const mixed of [false, true]) {
        const responses = mixed ? { "200": definition, [status]: definition } : { [status]: definition };
        const document = {
          ...protocol,
          paths: { "/__fixture/value": { get: { responses } } },
        };
        await assert.rejects(
          async () => {
            const client = fixtureClient(baseUrl, { document });
            await client.GET("/__fixture/value", { params: { header: headers } });
          },
          (error: unknown) => {
            assert(error instanceof Error);
            assert(
              !(error instanceof ResponseValidationError),
              "configuration failure is not a received-response failure",
            );
            assert.equal(
              error.message,
              `Unsupported response status declaration "${status}" for GET /__fixture/value; use exact status codes`,
            );
            return true;
          },
        );
        assert.equal(requests, 0, "invalid response configuration must fail before HTTP traffic");
      }
    }
    console.log(
      "PASS default/status-range declarations, including mixed exact statuses, fail construction before HTTP traffic",
    );

    const exact = fixtureClient(baseUrl, {
      document: {
        ...protocol,
        paths: { "/__fixture/value": { get: { responses: { "200": definition } } } },
      },
    });
    const result = await exact.GET("/__fixture/value", { params: { header: headers } });
    assert.deepEqual(result.data, expected);
    body = JSON.stringify({ dataset_id: dataset, data: { value: "exact status", count: 1 } });
    await assert.rejects(() => exact.GET("/__fixture/value", { params: { header: headers } }), isRefusal("schema"));
    assert.equal(requests, 2, "only the supported exact-status control reaches the HTTP supplier");
  },
);
console.log("PASS exact-status control retains real HTTP success and typed invalid-response failure");
