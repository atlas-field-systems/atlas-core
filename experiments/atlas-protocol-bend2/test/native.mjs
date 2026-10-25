import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const binary = fileURLToPath(new URL('../dist/atlas-protocol', import.meta.url));
const corpusDirectory = new URL('../../../Atlas%20Protocol/test/fixtures/', import.meta.url);
const temporary = mkdtempSync(join(tmpdir(), 'atlas-bend-native-'));
const decoder = new TextDecoder('utf-8', { fatal: true });
let nextFile = 0;

function file(bytes) {
  const path = join(temporary, `${nextFile++}.json`);
  writeFileSync(path, bytes);
  return path;
}

const jsonFile = (value) => file(JSON.stringify(value));

function invoke(...args) {
  const result = spawnSync(binary, args, { maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null, 'native process terminated by a signal');
  assert.ok([0, 1, 2].includes(result.status), `unexpected native exit ${result.status}`);
  return result;
}

function accepted(...args) {
  const result = invoke(...args);
  assert.equal(result.status, 0, decoder.decode(result.stderr));
  assert.equal(result.stderr.length, 0, 'accepted command wrote stderr');
  assert.equal(result.stdout.at(-1), 10, 'accepted command omitted its newline');
  return result.stdout.subarray(0, -1);
}

function rejection(result, code) {
  assert.equal(result.status, 1, 'expected rejection');
  assert.equal(result.stdout.length, 0, 'rejection wrote stdout');
  assert.ok(result.stderr.length <= 16 * 1024, 'unbounded error output');
  const error = JSON.parse(decoder.decode(result.stderr));
  assert.deepEqual(Object.keys(error).sort(), ['code', 'issues']);
  assert.equal(typeof error.code, 'string');
  assert.ok(Array.isArray(error.issues));
  if (code !== undefined) assert.equal(error.code, code);
  return error;
}

const value = (...args) => JSON.parse(decoder.decode(accepted(...args)));

function pointer(object, path) {
  return path.split('/').slice(1)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((current, key) => current?.[key], object);
}

function cliChecks() {
  assert.match(decoder.decode(accepted('help')), /http-response OPERATION DESCRIPTOR_FILE/);
  for (const args of [[], ['unknown'], ['read'], ['write', 'Integer'], ['check'],
    ['catalog', 'extra'], ['schemas', 'extra'], ['reference', 'extra'], ['help', 'extra'],
    ['wss-client'], ['wss-server', 'a', 'b', 'c'], ['http-request', 'GetHealth'],
    ['http-response', 'GetHealth', 'a', 'b', 'c']]) {
    const result = invoke(...args);
    assert.equal(result.status, 2, `usage ${args.join(' ')}`);
    assert.equal(result.stdout.length, 0);
  }
  const input = file('null');
  assert.equal(value('check', input), null);
  const unicode = file('"Crème 東京 😀"');
  for (const command of ['read', 'write'])
    assert.equal(decoder.decode(accepted(command, 'Opaque', unicode)), '"Crème 東京 😀"');
  rejection(invoke('read', 'Description', unicode), 'invalid_value');
  rejection(invoke('check', join(temporary, 'missing')), 'invalid_value');
  rejection(invoke('check', temporary), 'invalid_value');
  rejection(invoke('check', file(Buffer.from([0xff]))), 'invalid_utf8');
  rejection(invoke('check', file('{"same":1,"same":2}')), 'invalid_json');
  rejection(invoke('check', input, 'unknown-boundary'), 'invalid_value');
  rejection(invoke('check', input, 'http_request', jsonFile({ maxBytes: 0 })), 'payload_too_large');
  rejection(invoke('check', input, 'http_request', jsonFile({ maxBytes: -1 })), 'invalid_budget');
  rejection(invoke('check', input, 'http_request', file('{')), 'invalid_json');
  rejection(invoke('wss-client', input, file('{')), 'invalid_json');
  rejection(invoke('http-request', 'GetHealth', file('{')), 'invalid_json');
  const large = file('');
  truncateSync(large, 4 * 1024 * 1024 + 1);
  for (const boundary of ['http_request', 'http_response', 'wss_control', 'wss_data'])
    rejection(invoke('check', large, boundary), 'payload_too_large');
  rejection(invoke('check', input, 'http_request', large), 'payload_too_large');
  truncateSync(large, 24 * 1024 * 1024 + 1);
  rejection(invoke('http-request', 'GetHealth', large), 'payload_too_large');
  rejection(invoke('http-response', 'GetHealth', large), 'payload_too_large');
  const depth = file('['.repeat(65) + '0' + ']'.repeat(65));
  rejection(invoke('http-request', 'GetHealth', depth), 'resource_limit');
}

const schemaNames = {
  OrdinaryInteger: 'Integer',
  TypedFloat: 'Float',
  Counter: 'Counter',
  Position: 'Position',
  Integer: 'Integer',
  Timestamp: 'Timestamp',
  Attitude: 'Attitude',
  Gimbal: 'Gimbal',
  NewUuid: 'NewId',
  AssetReport: 'AssetReport',
  ObservationReport: 'ObservationReport',
  AssetDescription: 'AssetDescription',
  AssetType: 'AssetType',
  Capabilities: 'Capabilities',
  CreateTask: 'CreateTask',
  Geometry: 'Geometry',
  StatusReadResult: 'ReadSection.status',
  ReportTaskExecution: 'ReportTaskExecution',
  ConfirmTaskOrder: 'ConfirmTaskOrder',
  SynchronizationMessage: 'ServerFrame',
};

function fixtureCheck(fixture) {
  const input = file(fixture.raw_bytes === undefined
    ? Buffer.from(fixture.raw_json, 'utf8') : Buffer.from(fixture.raw_bytes));
  const boundary = fixture.boundary === 'synchronization_message'
    ? 'wss_data' : (fixture.boundary ?? 'http_request');
  const parsing = fixture.scope === 'parsing_budget_only';
  const schema = schemaNames[fixture.schema_name];
  assert.ok(parsing || schema, `unmapped fixture schema ${fixture.schema_name}`);
  const args = parsing ? ['check', input, boundary] : ['read', schema, input, boundary];
  const result = invoke(...args);
  if (fixture.expected === 'reject') {
    rejection(result, fixture.error_code);
    return;
  }
  assert.equal(fixture.expected, 'accept');
  assert.equal(result.status, 0, decoder.decode(result.stderr));
  assert.equal(result.stderr.length, 0);
  assert.equal(result.stdout.at(-1), 10);
  const canonicalRead = result.stdout.subarray(0, -1);
  const parsed = JSON.parse(decoder.decode(canonicalRead));
  if (parsing) {
    assert.equal(parsed, null);
    return;
  }
  const encoded = accepted('write', schema, file(canonicalRead), boundary);
  const written = JSON.parse(decoder.decode(encoded));
  assert.deepEqual(written, parsed, 'writer changed the validated value');
  if (fixture.canonical_json !== undefined)
    assert.equal(decoder.decode(encoded), fixture.canonical_json, 'canonical_json differs');
  if (fixture.retained_json !== undefined)
    assert.deepEqual(written, JSON.parse(fixture.retained_json), 'retained_json differs');
  for (const [path, expected] of Object.entries(fixture.retained_fields ?? {}))
    assert.deepEqual(pointer(parsed, path), expected, `retained field differs ${path}`);
  for (const path of fixture.absent_fields ?? [])
    assert.equal(pointer(parsed, path), undefined, `absent field present ${path}`);
  if (fixture.qualification?.includes('bounded_geometry_work')) {
    const exhausted = jsonFile({ maxGeometryWork: 0 });
    rejection(invoke(...args, exhausted), 'resource_limit');
  }
}

function protocolChecks() {
  const catalog = value('catalog');
  assert.equal(catalog.length, 66, 'exchange inventory');
  assert.equal(new Set(catalog.map((entry) => entry.operationId)).size, 66);
  for (const name of ['GetHealth', 'GetTask', 'ReadObjectContent'])
    assert.ok(catalog.some((entry) => entry.operationId === name), `missing operation ${name}`);
  const schemas = value('schemas');
  for (const name of ['Integer', 'Geometry', 'AssetReport', 'ClientFrame', 'ServerFrame'])
    assert.ok(schemas.includes(name), `missing schema ${name}`);
  const reference = value('reference');
  assert.equal(reference.openapi, '3.1.0');
  assert.equal(reference.info.version, '0.1.0');

  const dataset = '11111111-1111-4111-8111-111111111111';
  const request = '22222222-2222-4222-8222-222222222222';
  const other = '33333333-3333-4333-8333-333333333333';
  const client = { type: 'authenticate', dataset_id: dataset, protocol_version: '0.1.0',
    request_id: request, api_key: 'A'.repeat(43) };
  const clientFile = jsonFile(client);
  assert.deepEqual(value('wss-client', clientFile, jsonFile({ datasetId: dataset, requestId: request })), client);
  rejection(invoke('wss-client', jsonFile({ ...client, api_key: 'native-test-secret' })), 'invalid_value');
  rejection(invoke('wss-client', clientFile, jsonFile({ datasetId: other })), 'invalid_value');
  const server = { type: 'error', dataset_id: dataset, protocol_version: '0.1.0',
    error: { code: 'invalid_request', message: 'Invalid request', request_id: request }, request_id: request };
  const serverFile = jsonFile(server);
  assert.deepEqual(value('wss-server', serverFile, jsonFile({ requestId: request })), server);
  rejection(invoke('wss-server', serverFile, jsonFile({ requestId: other })), 'invalid_value');

  const requestDescriptor = { method: 'GET', path: '/health',
    headers: [{ name: 'Authorization', value: `Bearer ${'A'.repeat(43)}` }] };
  assert.deepEqual(value('http-request', 'GetHealth', jsonFile(requestDescriptor)), {});
  rejection(invoke('http-request', 'GetHealth', jsonFile({ ...requestDescriptor,
    headers: [{ name: 'Authorization', value: 'Bearer native-test-secret' }] })), 'invalid_http');
  rejection(invoke('http-request', 'GetHealth', jsonFile({ ...requestDescriptor, method: 'POST' })), 'invalid_http');
  const response = { status: 200,
    headers: [{ name: 'Atlas-Dataset-ID', value: dataset },
      { name: 'Atlas-Protocol-Version', value: '0.1.0' },
      { name: 'Content-Type', value: 'application/json' }],
    body: Array.from(Buffer.from(JSON.stringify({ dataset_id: dataset, data: { ready: true } }))) };
  const received = value('http-response', 'GetReadiness', jsonFile(response), jsonFile({ datasetId: dataset }));
  assert.equal(received.kind, 'success');
  assert.equal(received.body.data.ready, true);
  rejection(invoke('http-response', 'GetReadiness', jsonFile(response), jsonFile({ datasetId: other })), 'invalid_http');
}

try {
  cliChecks();
  console.log('Native CLI argument, file, byte, and limit checks passed.');
  if (process.argv.includes('--cli-only')) {
    console.log('Protocol integration was not run.');
  } else {
    const cases = ['acceptance.json', 'independent-cases.json']
      .flatMap((name) => JSON.parse(readFileSync(new URL(name, corpusDirectory), 'utf8')).cases);
    assert.equal(cases.length, 166, 'unchanged independent corpus inventory');
    let failures = 0;
    for (const fixture of cases) {
      try {
        fixtureCheck(fixture);
      } catch (error) {
        failures++;
        console.error(`${fixture.id}: ${error.message}`);
      }
    }
    assert.equal(failures, 0, `${failures} native fixture failures`);
    console.log('All 166 original fixtures passed through the native executable.');
    protocolChecks();
    console.log('Native HTTP, WSS, UTF-8, schema, reference, and 66-exchange checks passed.');
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
