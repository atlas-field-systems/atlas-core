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
const invalidBodies = [
  ["immutable id", { id: "33333333-3333-4333-8333-333333333333" }],
  ["immutable type", { type: "track" }],
  ["unknown field", { forbidden_secret: "sensitive fixture credential" }],
  ["unknown nested field", { fixture_component: { left: 1, secret: "sensitive fixture credential" } }],
  ["required component removal", { required_component: null }],
  ["nullable misuse", { position: null }],
  ["wrong scalar", { alias: 0 }],
  ["wrong array", { labels: "single" }],
  ["wrong array item", { labels: ["ok", 0] }],
  ["wrong nested shape", { fixture_component: [] }],
  ["wrong nested scalar", { fixture_component: { left: "0" } }],
  ["nonnullable nested scalar", { fixture_component: { left: null } }],
  ["missing longitude", { position: { latitude: 0 } }],
  ["missing latitude", { position: { longitude: 0 } }],
  ["coordinate bounds", { position: { latitude: 120, longitude: 0 } }],
  ["unknown position field", { position: { latitude: 0, longitude: 0, altitude: 2 } }],
  ["Entity tag", { fixture_entity: { type: "geofeature", id: fixtureId, state: "stopped" } }],
  ["Entity enum", { fixture_entity: { type: "asset", id: fixtureId, state: "teleporting" } }],
  ["wrong Entity variant", { fixture_entity: { type: "asset", id: fixtureId, observation: 0 } }],
  ["malformed body UUID", { fixture_entity: { type: "asset", id: "sensitive fixture credential", state: "stopped" } }],
  ["Command tag", { fixture_command: { command: "unknown", position: { latitude: 0, longitude: 0 } } }],
  ["wrong Command variant", { fixture_command: { command: "fixture_pause", position: { latitude: 0, longitude: 0 } } }],
  ["incomplete Command position", { fixture_command: { command: "fixture_move", position: { latitude: 0 } } }],
  ...["01", "-1", "1.5", "", " 1", "1 ", "1\n", "1\r\n", 9007199254740993].map((count) => ["malformed decimal", { count }] as const),
  ...["0", "01", "-1", "1.5", "", " 1", "1 ", 9007199254740993].map((positive_count) => ["malformed positive decimal", { positive_count }] as const),
] as const;

for (const mode of ["generated transport", "direct Protocol"]) {
  await withFixture(async ({ baseUrl }) => {
    const client = createTransport<paths>({ baseUrl, headers, fetch: (request) => fetch(request, { signal: AbortSignal.timeout(5000) }) });
    client.use(responseValidation(protocol, { datasetId: dataset, protocolVersion: version }));
    async function unchanged() {
      if (mode === "generated transport") {
        const response = await client.GET("/__fixture/patch/{fixture_id}", { params });
        assert.equal(response.response.status, 200);
        assert.deepEqual(response.data, { dataset_id: dataset, data: seed.initial });
      } else {
        const response = await fetch(`${baseUrl}/__fixture/patch/${fixtureId}`, { headers, signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { dataset_id: dataset, data: seed.initial });
      }
    }
    const requestIds = new Set<string>();
    async function rejected(body: string, name: string, pathId = fixtureId, requestHeaders: Record<string, string> = headers, status = 400, code = "invalid_request") {
      const response = await fetch(`${baseUrl}/__fixture/patch/${pathId}?secret=sensitive-fixture-credential`, {
        method: "PATCH", headers: { ...requestHeaders, "Content-Type": "application/json", "Authorization": "Bearer sensitive fixture credential" },
        body, signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, status, name);
      assert.equal(response.headers.get("Content-Type")?.split(";")[0], "application/json", name);
      const text = await response.text();
      assert(!text.includes("sensitive"), `${name}: rejection excludes request values`);
      const error: unknown = JSON.parse(text);
      assert(validateError(error), `${name}: shared typed error schema`);
      assert.equal(error.error.code, code, name);
      assert.match(error.error.message, /PATCH/, `${name}: safe method diagnostic`);
      assert.notEqual(error.error.request_id, "00000000-0000-0000-0000-000000000000", `${name}: diagnostic correlation is allocated`);
      assert(!requestIds.has(error.error.request_id), `${name}: separate rejections have separate diagnostics`);
      requestIds.add(error.error.request_id);
      await unchanged();
    }
    await unchanged();
    if (mode === "generated transport") {
      const typedFailures: Array<{ name: string; body: components["schemas"]["FixturePatch"] }> = [
        { name: "generated malformed decimal", body: { count: "01" } },
        { name: "generated positive zero", body: { positive_count: "0" } },
        { name: "generated malformed body UUID", body: { fixture_entity: { type: "asset", id: "sensitive-fixture-credential", state: "stopped" } } },
        { name: "generated coordinate bounds", body: { position: { latitude: 120, longitude: 0 } } },
      ];
      for (const scenario of typedFailures) {
        const response = await client.PATCH("/__fixture/patch/{fixture_id}", { params, body: { alias: "must not commit", ...scenario.body } });
        assert.equal(response.response.status, 400, scenario.name);
        assert(validateError(response.error), scenario.name);
        assert.equal(response.error.error.code, "invalid_request");
        assert.match(response.error.error.message, /PATCH/);
        assert.notEqual(response.error.error.request_id, "00000000-0000-0000-0000-000000000000");
        assert(!JSON.stringify(response.error).includes("sensitive"));
        await unchanged();
      }
      for (const scenario of [
        { name: "generated malformed path UUID", params: { ...params, path: { fixture_id: "sensitive-fixture-credential" } } },
        { name: "generated malformed Dataset UUID", params: { ...params, header: { ...headers, "Atlas-Dataset-ID": "sensitive-fixture-credential" } } },
      ]) {
        const response = await client.PATCH("/__fixture/patch/{fixture_id}", { params: scenario.params, body: { alias: "must not commit" } });
        assert.equal(response.response.status, 400, scenario.name);
        assert(validateError(response.error), scenario.name);
        assert.equal(response.error.error.code, "invalid_request");
        assert(!JSON.stringify(response.error).includes("sensitive"));
        await unchanged();
      }
    }
    const contextBody = JSON.stringify({ alias: "must not commit" });
    await rejected(contextBody, "wrong Dataset", fixtureId, { ...headers, "Atlas-Dataset-ID": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, 409, "dataset_mismatch");
    await rejected(contextBody, "missing Dataset", fixtureId, { "Atlas-Protocol-Version": version }, 400, "dataset_required");
    await rejected(contextBody, "malformed Dataset UUID", fixtureId, { ...headers, "Atlas-Dataset-ID": "sensitive-fixture-credential" });
    await rejected(contextBody, "missing Protocol edition", fixtureId, { "Atlas-Dataset-ID": dataset });
    await rejected(contextBody, "unsupported artificial edition", fixtureId, { ...headers, "Atlas-Protocol-Version": "9.0.0" }, 426, "unsupported_protocol");
    for (const [name, body] of invalidBodies) {
      await rejected(JSON.stringify({ alias: "must not commit", ...body }), name);
    }
    await rejected('{"alias":"must not commit",', "malformed JSON");
    await rejected('{"alias":"must not commit"} {"alias":"second"}', "multiple JSON documents");
    await rejected('{"alias":"must not commit"} trailing', "trailing malformed JSON");
    await rejected('', "missing required JSON body");
    await rejected(JSON.stringify({ alias: "sensitive".repeat(1024) }), "bounded JSON body");
    await rejected('[]', "top-level array");
    await rejected('null', "top-level null");
    await rejected('{"position":{"latitude":NaN,"longitude":0}}', "nonfinite JSON token");
    await rejected(JSON.stringify({ alias: "must not commit" }), "malformed path UUID", "sensitive-fixture-credential");
  });
  console.log(`PASS ${mode}: structural errors have typed diagnostics and no stored effects`);
}
