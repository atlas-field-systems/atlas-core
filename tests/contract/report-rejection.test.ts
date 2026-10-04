import assert from "node:assert/strict";
import { contractValidator, createTransport, responseValidation } from "../../Atlas SDK/src/index.js";
import protocol from "./generated/protocol.json" with { type: "json" };
import type { components, paths } from "./generated/protocol.js";
import reports from "./report-fixtures.json" with { type: "json" };
import { withFixture } from "./runner.js";

const dataset = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const version = "0.2.0";
const headers = { "Atlas-Dataset-ID": dataset, "Atlas-Protocol-Version": version };
const validator = contractValidator(protocol);
const validateReport = validator.compile<components["schemas"]["FixturePositionReport"]>({
  $ref: "atlas#/components/schemas/FixturePositionReport",
});
const validateError = validator.compile<components["schemas"]["Error"]>({ $ref: "atlas#/components/schemas/Error" });
const baseline = reports[0];
assert(baseline);
assert(validateReport(baseline.body));
const validBody = baseline.body;
const context = baseline.body.report_context;

const invalidBodies = [
  { name: "incomplete latitude-only position", body: { ...baseline.body, position: { latitude: 10 } } },
  { name: "incomplete longitude-only position", body: { ...baseline.body, position: { longitude: 20 } } },
  { name: "latitude is not swapped to infer an axis order", body: { ...baseline.body, position: { latitude: 120, longitude: 10 } } },
  { name: "latitude below lower bound", body: { ...baseline.body, position: { latitude: -91, longitude: 20 } } },
  { name: "longitude above upper bound", body: { ...baseline.body, position: { latitude: 10, longitude: 181 } } },
  { name: "longitude below lower bound", body: { ...baseline.body, position: { latitude: 10, longitude: -181 } } },
  { name: "coordinate strings are not coerced", body: { ...baseline.body, position: { latitude: "10", longitude: 20 } } },
  { name: "null position is not unknown coordinates", body: { ...baseline.body, position: null } },
  { name: "unknown coordinate reference", body: { ...baseline.body, position: { latitude: 10, longitude: 20, reference: "another-reference" } } },
  { name: "origin lacks its sequence", body: { ...baseline.body, report_context: { ...context, evidence_origin: { process_generation: "1" } } } },
  { name: "origin lacks its generation", body: { ...baseline.body, report_context: { ...context, evidence_origin: { sequence: "1" } } } },
  { name: "origin has an unknown field", body: { ...baseline.body, report_context: { ...context, evidence_origin: { process_generation: "1", sequence: "2", extra: true } } } },
  { name: "origin has a numeric sequence", body: { ...baseline.body, report_context: { ...context, evidence_origin: { process_generation: "1", sequence: 2 } } } },
  { name: "retained evidence has malformed UUID", body: { ...baseline.body, report_context: { ...context, retained_evidence_id: "not-a-uuid" } } },
  { name: "Asset has malformed UUID", body: { ...baseline.body, report_context: { ...context, asset_id: "not-a-uuid" } } },
  { name: "observation timing lacks uncertainty", body: { ...baseline.body, report_context: { ...context, observation_times: { position: { observed_at: null } } } } },
  { name: "observation timing lacks its time", body: { ...baseline.body, report_context: { ...context, observation_times: { position: { clock_uncertainty_ms: null } } } } },
  { name: "negative observation uncertainty", body: { ...baseline.body, report_context: { ...context, observation_times: { position: { observed_at: null, clock_uncertainty_ms: -1 } } } } },
  { name: "malformed observation date-time", body: { ...baseline.body, report_context: { ...context, observation_times: { position: { observed_at: "not-a-date", clock_uncertainty_ms: 0 } } } } },
  { name: "observation uncertainty is not coerced", body: { ...baseline.body, report_context: { ...context, observation_times: { position: { observed_at: null, clock_uncertainty_ms: "0" } } } } },
  { name: "observation timing record is not nullable", body: { ...baseline.body, report_context: { ...context, observation_times: { position: null } } } },
  { name: "observation map is optional but not nullable", body: { ...baseline.body, report_context: { ...context, observation_times: null } } },
  { name: "unknown observation timing field", body: { ...baseline.body, report_context: { ...context, observation_times: { position: { observed_at: null, clock_uncertainty_ms: null, extra: true } } } } },
  { name: "negative report uncertainty", body: { ...baseline.body, report_context: { ...context, clock_uncertainty_ms: -1 } } },
  { name: "malformed report date-time", body: { ...baseline.body, report_context: { ...context, generated_at: "not-a-date" } } },
  { name: "unknown evidence kind", body: { ...baseline.body, report_context: { ...context, evidence_kind: "unrecognized" } } },
  { name: "malformed opaque base64url proof", body: { ...baseline.body, report_context: { ...context, process_proof: "a+b=" } } },
  { name: "unknown report-context field", body: { ...baseline.body, report_context: { ...context, received_at: "2026-09-21T10:00:00Z" } } },
  { name: "unknown route payload field", body: { ...baseline.body, extra: true } },
];

const rejected: Array<{ name: string; json: string; media?: string }> = invalidBodies.map(({ name, body }) => ({ name, json: JSON.stringify(body) }));
for (const field of ["process_generation", "sequence"]) {
  for (const value of ["0", "01", "-1", "+1", "1.5", "1e3", "", " 1", "1 ", "1\n", "1\r\n", 1]) {
    rejected.push({ name: `${field} rejects ${JSON.stringify(value)}`, json: JSON.stringify({ ...baseline.body, report_context: { ...context, [field]: value } }) });
  }
}
for (const field of ["generated_at", "clock_uncertainty_ms", "evidence_origin", "retained_evidence_id", "contact_challenge"]) {
  const body = structuredClone(baseline.body);
  Reflect.deleteProperty(body.report_context, field);
  rejected.push({ name: `required nullable ${field} is absent`, json: JSON.stringify(body) });
}
for (const literal of ["NaN", "Infinity", "-Infinity", "1e1000"]) {
  const json = JSON.stringify({ ...baseline.body, position: { latitude: "invalid-number", longitude: 20 } }).replace('"invalid-number"', literal);
  rejected.push({ name: `nonfinite coordinate encoding ${literal}`, json });
}
rejected.push({
  name: "large sequence is a JSON number instead of a decimal string",
  json: JSON.stringify({ ...baseline.body, report_context: { ...context, sequence: "invalid-number" } }).replace('"invalid-number"', "9007199254740993"),
});
rejected.push({ name: "malformed JSON", json: '{"report_context":' });
// Literal duplicate names survive transport; object serialization would erase
// the disagreement between generic schema decoding and typed struct merging.
for (const duplicateName of ['"report_context"', '"report_\\u0063ontext"']) {
  rejected.push({
    name: `duplicate context member ${duplicateName}`,
    json: '{"report_context":{"observation_times":{"movement":{"observed_at":null,"clock_uncertainty_ms":-1}}},' +
      `${duplicateName}:${JSON.stringify(context)},"position":{"latitude":10,"longitude":20}}`,
  });
}
rejected.push({ name: "nested duplicate member", json: JSON.stringify(baseline.body).replace('"latitude":', '"latitude":91,"latitude":') });
for (const key of ['\\ud800', '\\udfff']) {
  rejected.push({
    name: `unpaired surrogate observation name ${key}`,
    json: JSON.stringify({ ...baseline.body, report_context: { ...context, observation_times: {
      "unicode-key": { observed_at: null, clock_uncertainty_ms: null },
    } } }).replace('"unicode-key"', `"${key}"`),
  });
}

// The pinned validator strips parameters before selecting its JSON decoder.
// Malformed parameters must not skip the earlier original-document checks.
const malformedMedia = ["application/json; =x", "application/json; charset=first; charset=second"];
for (const media of malformedMedia) {
  rejected.push({ name: `duplicate context with ${media}`, media,
    json: '{"report_context":{"observation_times":{"movement":{"observed_at":null,"clock_uncertainty_ms":-1}}},' +
      `"report_context":${JSON.stringify(context)},"position":{"latitude":10,"longitude":20}}`,
  });
  rejected.push({ name: `unpaired observation name with ${media}`, media,
    json: JSON.stringify({ ...baseline.body, report_context: { ...context, observation_times: {
      "unicode-key": { observed_at: null, clock_uncertainty_ms: null },
    } } }).replace('"unicode-key"', '"\\ud800"'),
  });
}

for (const mode of ["generated transport", "direct Protocol"]) {
  await withFixture(async ({ baseUrl }) => {
    let injectedJSON: string | undefined;
    let injectedMedia: string | undefined;
    const client = createTransport<paths>({
      baseUrl, headers,
      // Invalid inputs cannot be expressed by generated types. Injection at the
      // transport boundary exercises untrusted wire bytes over the real HTTP
      // handler, without asserting or weakening those types.
      fetch: (request) => {
        const wire = injectedJSON !== undefined && request.method === "PUT" ? new Request(request, { body: injectedJSON }) : request;
        if (injectedMedia !== undefined && request.method === "PUT") wire.headers.set("Content-Type", injectedMedia);
        return fetch(wire, { signal: AbortSignal.timeout(5000) });
      },
    });
    client.use(responseValidation(protocol, { datasetId: dataset, protocolVersion: version }, { maxJSONBytes: 1_048_576 }));
    if (mode === "generated transport") {
      const seed = await client.PUT("/__fixture/report", { params: { header: headers }, body: validBody });
      assert.equal(seed.response.status, 200);
      assert.deepEqual(seed.data, { ...baseline.expected, commit_cursor: "fixture:report:1" });
    } else {
      const seed = await fetch(`${baseUrl}/__fixture/report`, {
        method: "PUT", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(baseline.body), signal: AbortSignal.timeout(5000),
      });
      assert.equal(seed.status, 200);
      assert.deepEqual(await seed.json(), { ...baseline.expected, commit_cursor: "fixture:report:1" });
    }
    for (const scenario of rejected) {
      let errorBody: unknown;
      if (mode === "generated transport") {
        injectedJSON = scenario.json;
        injectedMedia = scenario.media;
        const result = await client.PUT("/__fixture/report", { params: { header: headers }, body: validBody });
        injectedJSON = undefined;
        injectedMedia = undefined;
        assert.equal(result.response.status, 400, scenario.name);
        assert.equal(result.data, undefined);
        errorBody = result.error;
      } else {
        const response = await fetch(`${baseUrl}/__fixture/report`, {
          method: "PUT", headers: { ...headers, "Content-Type": scenario.media ?? "application/json" },
          body: scenario.json, signal: AbortSignal.timeout(5000),
        });
        assert.equal(response.status, 400, scenario.name);
        assert.equal(response.headers.get("Content-Type"), "application/json");
        assert.equal(response.headers.get("Atlas-Dataset-ID"), dataset);
        assert.equal(response.headers.get("Atlas-Protocol-Version"), version);
        errorBody = await response.json();
      }
      assert(validateError(errorBody), scenario.name);
      assert.equal(errorBody.error.code, "invalid_request", scenario.name);
      assert.equal(typeof errorBody.error.message, "string");
      if (mode === "generated transport") {
        const read = await client.GET("/__fixture/report", { params: { header: headers } });
        assert.deepEqual(read.data, baseline.expected, `${scenario.name} preserves stored report`);
      } else {
        const read = await fetch(`${baseUrl}/__fixture/report`, { headers, signal: AbortSignal.timeout(5000) });
        assert.equal(read.status, 200);
        assert.deepEqual(await read.json(), baseline.expected, `${scenario.name} preserves stored report`);
      }
    }
    // Valid payloads retain the pinned validator's existing parameter handling.
    for (const media of malformedMedia) {
      if (mode === "generated transport") {
        injectedMedia = media;
        const accepted = await client.PUT("/__fixture/report", { params: { header: headers }, body: validBody });
        injectedMedia = undefined;
        assert.equal(accepted.response.status, 200, `valid report retains acceptance for ${media}`);
        assert.deepEqual(accepted.data, { ...baseline.expected, commit_cursor: "fixture:report:1" });
      } else {
        const accepted = await fetch(`${baseUrl}/__fixture/report`, { method: "PUT",
          headers: { ...headers, "Content-Type": media }, body: JSON.stringify(validBody), signal: AbortSignal.timeout(5000) });
        assert.equal(accepted.status, 200, `valid report retains acceptance for ${media}`);
        assert.deepEqual(await accepted.json(), { ...baseline.expected, commit_cursor: "fixture:report:1" });
      }
    }
    const pairedName = JSON.stringify({ ...baseline.body, report_context: { ...context, observation_times: {
      "unicode-key": { observed_at: null, clock_uncertainty_ms: null },
    } } }).replace('"unicode-key"', '"\\ud83c\\udf0d"');
    injectedJSON = pairedName;
    const positive = await client.PUT("/__fixture/report", { params: { header: headers }, body: validBody });
    injectedJSON = undefined;
    assert.equal(positive.response.status, 200, "paired surrogate dictionary name is supported");
    const expected = { ...baseline.expected, data: { ...baseline.body, report_context: { ...context,
      observation_times: { "🌍": { observed_at: null, clock_uncertainty_ms: null } },
    } } };
    const positiveRead = await client.GET("/__fixture/report", { params: { header: headers } });
    assert.deepEqual(positiveRead.data, expected, "valid dictionary name survives storage");
  });
  console.log(`PASS ${mode}: ${rejected.length} report rejections preserve prior stored payload`);
}
