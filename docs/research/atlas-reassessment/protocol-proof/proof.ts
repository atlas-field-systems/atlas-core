import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Ajv, type ValidateFunction } from "ajv";
import { fullFormats } from "ajv-formats/dist/formats.js";
import createClient, { type Middleware } from "openapi-fetch";
import protocol from "./protocol.json" with { type: "json" };
import fixtures from "./fixtures.json" with { type: "json" };
import type { components, paths } from "./generated/protocol.js";
import type { components as OlderComponents, paths as OlderPaths } from "./generated/older-client.js";
import olderProtocol from "./older-client.json" with { type: "json" };

const ajv = new Ajv({ strict: true, allErrors: true });
for (const [name, format] of Object.entries(fullFormats)) ajv.addFormat(name, format);
// These fields are metadata containers. oneOf and each variant's single-value
// enum enforce the tag, so ignoring discriminator does not weaken validation.
for (const keyword of ["components", "paths", "discriminator", "x-atlas-command"]) {
  ajv.addKeyword({ keyword });
}
ajv.addSchema({ $id: "atlas", components: protocol.components, paths: protocol.paths });
function validator<Name extends keyof components["schemas"]>(name: Name) {
  return ajv.compile<components["schemas"][Name]>({
    $ref: `atlas#/components/schemas/${name}`,
  });
}
const validEntity = validator("Entity");
const validPatch = validator("EntityPatch");
const validEntityResponse = validator("EntityResponse");
const validResponseContext = validator("ResponseContext");
const validCommand = validator("Command");
const validError = validator("Error");
const validEvent = validator("ChangeEvent");
const validDispatch = validator("PluginDispatch");
const validReport = validator("TaskReport");
const validReportContext = validator("ReportContext");

const responseValidators = new Map<string, ValidateFunction>();
const responseMediaTypes = new Map<string, Set<string>>();
function pointer(value: string) { return value.replaceAll("~", "~0").replaceAll("/", "~1"); }
const runtimePaths: Record<string, Record<string, { responses: Record<string, { content: Record<string, unknown> }> }>> = protocol.paths;
for (const [path, pathItem] of Object.entries(runtimePaths)) {
  for (const [method, operation] of Object.entries(pathItem)) {
    for (const [status, response] of Object.entries(operation.responses)) {
      responseMediaTypes.set(`${method.toUpperCase()} ${path} ${status}`, new Set(Object.keys(response.content)));
      if (!("application/json" in response.content)) continue;
      const ref = `atlas#/paths/${pointer(path)}/${method}/responses/${status}/content/application~1json/schema`;
      responseValidators.set(`${method.toUpperCase()} ${path} ${status}`, ajv.compile({ $ref: ref }));
    }
  }
}
const dataset = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const currentVersion = protocol.info.version;
const headers = { "Atlas-Dataset-ID": dataset, "Atlas-Protocol-Version": currentVersion };
const params = { header: headers };

function responseValidation(expectedVersion: string): Middleware {
  return {
    async onResponse({ response, schemaPath, request }) {
      if (response.headers.get("Atlas-Dataset-ID") !== dataset) throw new Error("invalid response Dataset");
      if (response.headers.get("Atlas-Protocol-Version") !== expectedVersion) throw new Error("invalid response Protocol");
      const key = `${request.method} ${schemaPath} ${response.status}`;
      const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      if (!responseMediaTypes.get(key)?.has(mediaType)) throw new Error("undeclared response status or content type");
      const validate = responseValidators.get(key);
      if (validate) {
        const data: unknown = await response.clone().json();
        if (!validate(data)) throw new Error("invalid response shape");
        if (response.ok && (!validResponseContext(data) || data.dataset_id !== dataset)) throw new Error("invalid response Dataset body");
        if (!response.ok && validError(data) && data.dataset_id !== undefined && data.dataset_id !== dataset) throw new Error("invalid error Dataset body");
      }
      return response;
    },
  };
}

// Runtime expectations below come from hand-authored fixtures, not generated
// types. The server and SQLite/file boundaries are real within this experiment.
const child = spawn("./.proof-server", [], { stdio: ["ignore", "pipe", "inherit"] });
const exited = once(child, "exit");
let baseUrl = "";
const ready = new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("proof server readiness timeout")), 10_000);
  child.once("error", (error) => { clearTimeout(timer); reject(error); });
  child.once("exit", () => { clearTimeout(timer); reject(new Error("proof server exited before readiness")); });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data: string) => {
    const match = /^ready (http:\/\/\S+) sqlite=(\S+)/u.exec(data);
    if (match?.[1]) { clearTimeout(timer); console.log(data.trim()); resolve(match[1]); }
  });
});
let checks = 0;
function pass(name: string) { checks++; console.log(`PASS ${name}`); }
async function reset() {
  const response = await fetch(`${baseUrl}/__fixture/reset`, { method: "POST", headers });
  assert.equal(response.status, 204);
}
async function raw(path: string, method: string, body?: unknown, overrides?: Record<string, string>) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...headers, "Content-Type": "application/json", ...overrides },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
try {
  baseUrl = await ready;
  const client = createClient<paths>({ baseUrl, headers });
  client.use(responseValidation(currentVersion));
  for (const candidate of fixtures.valid_entities) assert(validEntity(candidate));
  for (const candidate of fixtures.invalid_entities) assert(!validEntity(candidate));
  pass("Entity variant schemas accept valid and reject invalid fixtures");
  for (const scenario of fixtures.patches) {
    assert(validPatch(scenario.patch), scenario.name);
    await reset();
    const direct = await raw("/entity", "PATCH", scenario.patch);
    assert.equal(direct.status, 200, scenario.name);
    const directValue: unknown = await direct.json();
    assert(validEntityResponse(directValue));
    assert.deepEqual(directValue.data, scenario.expected, `${scenario.name} direct Protocol`);
    await reset();
    const result = await client.PATCH("/entity", { params, body: scenario.patch });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.data?.data, scenario.expected, `${scenario.name} generated client`);
    assert.equal(result.data?.dataset_id, dataset);
    assert.equal(result.data?.commit_cursor, "fixture:commit:1");
    const stored = await client.GET("/entity", { params });
    assert.deepEqual(stored.data?.data, scenario.expected, `${scenario.name} persisted SQLite value`);
    pass(scenario.name);
  }
  const sequence = fixtures.cleared_component_sequence;
  for (const mode of ["direct", "generated"]) {
    await reset();
    async function patchEntity(body: components["schemas"]["EntityPatch"]) {
      if (mode === "direct") {
        const response = await raw("/entity", "PATCH", body);
        const value: unknown = await response.json();
        return { status: response.status, value };
      }
      const response = await client.PATCH("/entity", { params, body });
      return { status: response.response.status, value: response.data ?? response.error };
    }
    const cleared = await patchEntity(sequence.clear);
    assert.equal(cleared.status, 200); assert(validEntityResponse(cleared.value));
    assert.deepEqual(cleared.value.data, sequence.expected_cleared);
    for (const patch of sequence.incomplete) {
      const rejected = await patchEntity(patch);
      assert.equal(rejected.status, 400); assert(validError(rejected.value));
      assert.equal(rejected.value.error.code, "invalid_request");
      assert.deepEqual((await client.GET("/entity", { params })).data?.data, sequence.expected_cleared);
    }
    const recreated = await patchEntity(sequence.recreate);
    assert.equal(recreated.status, 200); assert(validEntityResponse(recreated.value));
    assert.deepEqual(recreated.value.data, sequence.expected_recreated);
    assert.deepEqual((await client.GET("/entity", { params })).data?.data, sequence.expected_recreated);
  }
  await reset();
  pass("cleared component rejects incomplete patches atomically and accepts complete recreation in both paths");
  for (const scenario of fixtures.invalid_requests) {
    const validate = scenario.path === "/entity" ? validPatch : scenario.path === "/command" ? validCommand : validReport;
    assert(!validate(scenario.body), `${scenario.name} SDK input validation`);
    await reset();
    const response = await raw(scenario.path, scenario.method, scenario.body);
    assert.equal(response.status, 400, scenario.name);
    const error: unknown = await response.json();
    assert(validError(error)); assert.equal(error.error.code, "invalid_request");
    const stored = await client.GET("/entity", { params });
    assert.deepEqual(stored.data?.data, fixtures.asset, `${scenario.name} no write effect`);
    pass(scenario.name);
  }
  const malformed = await fetch(`${baseUrl}/entity`, { method: "PATCH", headers: { ...headers, "Content-Type": "application/json" }, body: "{" });
  assert.equal(malformed.status, 400); pass("malformed JSON rejected before mutation");
  for (const command of fixtures.valid_commands) {
    assert(validCommand(command));
    const response = await client.POST("/command", { params, body: command });
    assert.deepEqual(response.data?.data, command); pass(`Command ${command.command} actual wire round trip`);
  }
  for (const scenario of fixtures.valid_reports) {
    const report = scenario.body;
    assert(validReport(report), scenario.name);
    assert.deepEqual((await client.POST("/report", { params, body: report })).data?.data, report);
    pass(`${scenario.name} actual wire round trip`);
  }
  const contextFixture = fixtures.valid_reports[0];
  assert(contextFixture);
  for (const observation_times of fixtures.valid_observation_times) {
    assert(validReportContext({ ...contextFixture.body.context, observation_times }));
  }
  for (const observation_times of fixtures.invalid_observation_times) {
    assert(!validReportContext({ ...contextFixture.body.context, observation_times }));
  }
  pass("optional observation timing map accepts known and unknown timing and rejects malformed records");

  const binaryString = String.fromCharCode(...fixtures.bytes);
  const upload = await client.PUT("/object", {
    params, body: binaryString, bodySerializer: (body) => Uint8Array.from(body, (character) => character.charCodeAt(0)),
    headers: { "Content-Type": "application/octet-stream" },
  });
  assert.deepEqual(upload.data?.data, fixtures.object);
  const download = await client.GET("/object/content", { params, parseAs: "arrayBuffer" });
  assert(download.data); assert.deepEqual([...new Uint8Array(download.data)], fixtures.bytes);
  assert.equal(download.response.headers.get("content-length"), "7");
  pass("binary upload metadata and file download preserve non-text bytes");
  const wrongMediaType = await raw("/object", "PUT", "not binary");
  assert.equal(wrongMediaType.status, 400); pass("streaming binding rejects a media type absent from Protocol");

  for (const version of fixtures.unsupported_versions) {
    const response = await raw("/entity", "PATCH", { alias: "must not save" }, { "Atlas-Protocol-Version": version });
    assert.equal(response.status, 426);
    const error: unknown = await response.json(); assert(validError(error)); assert.equal(error.error.code, "unsupported_protocol");
  }
  assert.deepEqual((await client.GET("/entity", { params })).data?.data, fixtures.asset);
  pass("unsupported Protocol versions rejected without write effects");
  const mismatch = await raw("/entity", "PATCH", { alias: "must not save" }, { "Atlas-Dataset-ID": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
  assert.equal(mismatch.status, 409); assert.deepEqual((await client.GET("/entity", { params })).data?.data, fixtures.asset);
  pass("obsolete Dataset rejected without write effects");
  const oldVersion = fixtures.old_client_request.version;
  const oldClient = createClient<OlderPaths>({ baseUrl, headers: { ...headers, "Atlas-Protocol-Version": oldVersion } });
  ajv.addSchema({ $id: "atlas-older", components: olderProtocol.components });
  const validateOlderAsset = ajv.compile<OlderComponents["schemas"]["Response"]>({ $ref: "atlas-older#/components/schemas/Response" });
  oldClient.use({ async onResponse({ response }) {
    assert.equal(response.headers.get("Atlas-Protocol-Version"), olderProtocol.info.version);
    assert.equal(response.headers.get("Atlas-Dataset-ID"), dataset);
    const value: unknown = await response.clone().json();
    if (!validateOlderAsset(value)) throw new Error("invalid older response");
    assert.equal(value.dataset_id, dataset);
    return response;
  } });
  const oldResponse = await oldClient.GET("/entity", { params: { header: { ...headers, "Atlas-Protocol-Version": oldVersion } } });
  assert.equal(oldResponse.response.status, 200); assert.deepEqual(oldResponse.data?.data, fixtures.asset);
  const { battery_percent, ...olderShape } = fixtures.asset;
  assert.equal(battery_percent, 85); assert(validEntity(olderShape));
  pass("independently generated older client accepts newly added optional field; absent optional field remains valid");
  for (const fault of ["shape", "json", "enum", "media", "dataset", "dataset_body", "version"]) {
    const faultClient = createClient<paths>({ baseUrl, headers, fetch: (request) => {
      const url = new URL(request.url); url.searchParams.set("fault", fault);
      return fetch(new Request(url, request));
    } });
    faultClient.use(responseValidation(currentVersion));
    await assert.rejects(() => faultClient.GET("/entity", { params }));
    pass(`malformed successful response ${fault} rejected by SDK boundary`);
  }
  const cursorFaultClient = createClient<paths>({ baseUrl, headers, fetch: (request) => {
    const url = new URL(request.url); url.searchParams.set("fault", "cursor");
    return fetch(new Request(url, request));
  } });
  cursorFaultClient.use(responseValidation(currentVersion));
  const commandFixture = fixtures.valid_commands[0];
  assert(commandFixture); assert(validCommand(commandFixture));
  const reportFixture = contextFixture.body;
  assert(validReport(reportFixture));
  for (const mutation of [
    { name: "Entity patch", send: () => cursorFaultClient.PATCH("/entity", { params, body: {} }) },
    { name: "Command", send: () => cursorFaultClient.POST("/command", { params, body: commandFixture }) },
    { name: "report", send: () => cursorFaultClient.POST("/report", { params, body: reportFixture }) },
    { name: "Object upload", send: () => cursorFaultClient.PUT("/object", {
      params, body: binaryString, bodySerializer: (body) => Uint8Array.from(body, (character) => character.charCodeAt(0)),
      headers: { "Content-Type": "application/octet-stream" },
    }) },
  ]) {
    await assert.rejects(mutation.send, /invalid response shape/u);
    pass(`${mutation.name} response without required commit cursor rejected`);
  }
  for (const fault of ["error_dataset_header", "error_version_header"]) {
    const faultClient = createClient<paths>({ baseUrl, headers, fetch: (request) => {
      const url = new URL(request.url); url.searchParams.set("fault", fault);
      return fetch(new Request(url, request));
    } });
    faultClient.use(responseValidation(currentVersion));
    await assert.rejects(() => faultClient.GET("/entity", { params }), /invalid response (Dataset|Protocol)/u);
    pass(`${fault} missing from JSON error rejected`);
  }

  assert(validEvent(fixtures.valid_event)); assert(!validEvent(fixtures.invalid_event));
  assert(validDispatch(fixtures.valid_dispatch)); assert(!validDispatch(fixtures.invalid_dispatch));
  pass("non-HTTP event and private dispatch reuse canonical Entity/Position schemas");
  const catalog = Object.entries(protocol.components.schemas).flatMap(([schemaName, schema]) =>
    "x-atlas-command" in schema ? [{ schemaName, ...schema["x-atlas-command"] }] : []);
  assert.deepEqual(catalog.map((command) => command.name), ["move_to", "pause"]);
  for (const command of catalog) {
    const validate = ajv.compile({ $ref: `atlas#/components/schemas/${command.schemaName}` });
    const example = fixtures.valid_commands.find((item) => item.command === command.name);
    assert(example); assert(validate(example));
  }
  pass("local Command Catalog derives metadata directly from Protocol");
  console.log(`${checks} checks passed`);
} finally {
  child.kill("SIGTERM");
  const [code, signal] = await exited;
  assert.equal(code, 0, `proof server termination: ${signal}`);
}
