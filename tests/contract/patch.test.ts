import assert from "node:assert/strict";
import { createTransport, responseValidation, contractValidator } from "../../Atlas SDK/src/index.js";
import { withFixture } from "./runner.js";
import protocol from "./generated/protocol.json" with { type: "json" };
import seed from "./patch.fixtures.json" with { type: "json" };
import type { paths, components } from "./generated/protocol.js";

const dataset = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const fixtureId = "11111111-1111-4111-8111-111111111111";
const version = "0.2.0";
const headers = { "Atlas-Dataset-ID": dataset, "Atlas-Protocol-Version": version };
const params = { header: headers, path: { fixture_id: fixtureId } };
const validateError = contractValidator(protocol).compile<components["schemas"]["Error"]>({ $ref: "atlas#/components/schemas/Error" });

for (const mode of ["generated transport", "direct Protocol"]) {
  await withFixture(async ({ baseUrl }) => {
    const client = createTransport<paths>({ baseUrl, headers, fetch: (request) => fetch(request, { signal: AbortSignal.timeout(5000) }) });
    client.use(responseValidation(protocol, { datasetId: dataset, protocolVersion: version }, { maxJSONBytes: 1_048_576 }));
    async function read(expected: unknown) {
      if (mode === "generated transport") {
        const response = await client.GET("/__fixture/patch/{fixture_id}", { params });
        assert.equal(response.response.status, 200);
        assert.deepEqual(response.data, { dataset_id: dataset, data: expected });
      } else {
        const response = await fetch(`${baseUrl}/__fixture/patch/${fixtureId}`, { headers, signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { dataset_id: dataset, data: expected });
      }
    }
    async function patch(body: components["schemas"]["FixturePatch"], expected: unknown) {
      if (mode === "generated transport") {
        const response = await client.PATCH("/__fixture/patch/{fixture_id}", { params, body });
        assert.equal(response.response.status, 200);
        assert.deepEqual(response.data, { dataset_id: dataset, data: expected, commit_cursor: "fixture:commit:patch" });
      } else {
        const response = await fetch(`${baseUrl}/__fixture/patch/${fixtureId}`, {
          method: "PATCH", headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("Atlas-Dataset-ID"), dataset);
        assert.equal(response.headers.get("Atlas-Protocol-Version"), version);
        assert.deepEqual(await response.json(), { dataset_id: dataset, data: expected, commit_cursor: "fixture:commit:patch" });
      }
      await read(expected);
    }
    await read(seed.initial);
    await patch({}, seed.initial);
    await patch({ alias: "" }, { ...seed.initial, alias: "" });
    await patch({ alias: null }, { ...seed.initial, alias: null });
    await patch({ labels: [] }, { ...seed.initial, alias: null, labels: [] });
    await patch({ labels: ["b", "a", "a"] }, { ...seed.initial, alias: null, labels: ["b", "a", "a"] });
    await patch({ labels: null }, { ...seed.initial, alias: null, labels: null });
    const nullValues = { ...seed.initial, alias: null, labels: null };
    await patch({ fixture_component: { left: 0 } }, { ...nullValues, fixture_component: { left: 0, right: 20 } });
    await patch({ fixture_component: {} }, { ...nullValues, fixture_component: { left: 0, right: 20 } });
    const cleared = { ...nullValues, fixture_component: null };
    await patch({ fixture_component: null }, cleared);
    for (const fixture_component of [{ left: 30 }, { right: 40 }, {}]) {
      const body = { alias: "must not commit", fixture_component };
      if (mode === "generated transport") {
        const response = await client.PATCH("/__fixture/patch/{fixture_id}", { params, body });
        assert.equal(response.response.status, 400);
        assert(validateError(response.error));
        assert.equal(response.error.error.code, "invalid_request");
        assert.notEqual(response.error.error.request_id, "00000000-0000-0000-0000-000000000000");
      } else {
        const response = await fetch(`${baseUrl}/__fixture/patch/${fixtureId}`, {
          method: "PATCH", headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
        });
        assert.equal(response.status, 400);
        const error: unknown = await response.json();
        assert(validateError(error));
        assert.equal(error.error.code, "invalid_request");
        assert.match(error.error.message, /Complete patch result/);
        assert.notEqual(error.error.request_id, "00000000-0000-0000-0000-000000000000");
      }
      await read(cleared);
    }
    const recreated = { ...nullValues, fixture_component: { left: 0, right: 40 } };
    await patch({ fixture_component: { left: 0, right: 40 } }, recreated);
    await patch({ count: "9007199254740993", positive_count: "1", required_component: { enabled: false }, position: { latitude: 0, longitude: 0 } }, {
      ...recreated, count: "9007199254740993", positive_count: "1", required_component: { enabled: false }, position: { latitude: 0, longitude: 0 },
    });
    const moved = {
      ...recreated, count: "9007199254740993", positive_count: "1", required_component: { enabled: false }, position: { latitude: 0, longitude: 0 },
      fixture_entity: { type: "track", id: "33333333-3333-4333-8333-333333333333", observation: 0 },
      fixture_command: { command: "fixture_move", position: { latitude: 10.123456789012345, longitude: 20.987654321098765 } },
    };
    await patch({
      fixture_entity: { type: "track", id: "33333333-3333-4333-8333-333333333333", observation: 0 },
      fixture_command: { command: "fixture_move", position: { latitude: 10.123456789012345, longitude: 20.987654321098765 } },
    }, moved);
    await patch({ count: "0", position: { latitude: -90, longitude: 180 } }, { ...moved, count: "0", position: { latitude: -90, longitude: 180 } });
  });
  console.log(`PASS ${mode}: omission/null/arrays, nested partial updates and atomic recreation persist`);
}
