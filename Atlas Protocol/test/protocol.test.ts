import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp, open, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {Ajv2020} from 'ajv/dist/2020.js';
import {Decode, Encode, Version, Catalog, isSchemaName, DefaultLimits, ValidateRequest, ValidateResponse, ValidateFrame, CheckContent, PluginNumberText} from '../ts/index.js';
import type {ResponseContext, FrameContext, components, operations} from '../ts/index.js';
interface Fixture {name: string; schema: string; valid: boolean; value?: unknown; raw?: string; hex?: string; error?: string}
interface Exchange {name: string; request_schema: string | null; request: unknown; response_schema: string | null; response: unknown; status: number; query: string}
interface Manifest {case_names: string[]; exchange_names: string[]; valid: number; invalid: number}
const fixtureRoot = process.env.ATLAS_FIXTURES ?? 'fixtures';
const ajv = new Ajv2020({strict: true});
const fixtureValidator = ajv.compile<Fixture[]>({type: 'array', items: {type: 'object', additionalProperties: false, required: ['name', 'schema', 'valid'], properties: {name: {type: 'string'}, schema: {type: 'string'}, valid: {type: 'boolean'}, value: {}, raw: {type: 'string'}, hex: {type: 'string'}, error: {type: 'string'}}}});
const exchangeValidator = ajv.compile<Exchange[]>({type: 'array', items: {type: 'object', additionalProperties: false, required: ['name', 'request_schema', 'request', 'response_schema', 'response', 'status', 'query'], properties: {name: {type: 'string'}, request_schema: {type: ['string', 'null']}, request: {}, response_schema: {type: ['string', 'null']}, response: {}, status: {type: 'integer'}, query: {type: 'string'}}}});
const manifestValidator = ajv.compile<Manifest>({type: 'object', additionalProperties: false, required: ['case_names', 'exchange_names', 'valid', 'invalid'], properties: {case_names: {type: 'array', items: {type: 'string'}, uniqueItems: true}, exchange_names: {type: 'array', items: {type: 'string'}, uniqueItems: true}, valid: {type: 'integer'}, invalid: {type: 'integer'}}});
const casesData: unknown = JSON.parse(readFileSync(fixtureRoot + '/cases.json', 'utf8'));
const exchangesData: unknown = JSON.parse(readFileSync(fixtureRoot + '/exchanges.json', 'utf8'));
const manifestData: unknown = JSON.parse(readFileSync(fixtureRoot + '/manifest.json', 'utf8'));
assert(fixtureValidator(casesData)); assert(exchangeValidator(exchangesData)); assert(manifestValidator(manifestData));
const cases = casesData, exchanges = exchangesData, manifest = manifestData;
const wire = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const dataset = 'A0B1C2D3-E4F5-4A67-8B90-C1D2E3F4A5B6', coreRun = '00000000-0000-0000-0000-000000000002';
const handshakeKey = 'dGhlIHNhbXBsZSBub25jZQ==';
function headers() {return new Headers({'Authorization': 'Bearer ' + 'A'.repeat(43), 'Atlas-Dataset-ID': dataset, 'Atlas-Protocol-Version': Version, 'Content-Type': 'application/json'});}
const inventory = readFileSync(fixtureRoot + '/inventory.tsv', 'utf8').trim().split('\n').map(line => line.split('\t'));
function request(sample: Exchange) {
 const record = inventory.find(row => row[0] === sample.name); assert(record); const [, method, pattern] = record; assert(method && pattern);
 const path = pattern.replace(/\{([^}]+)\}/g, (_, key: string) => key === 'alias' ? 'Camera-A' : dataset);
 const url = 'https://atlas.invalid' + path + (sample.query ? '?' + sample.query : '');
 const h = headers(); let body = sample.request_schema ? wire(sample.request) : undefined;
 if (sample.name === 'UploadObject') {h.set('Content-Type', 'application/octet-stream'); h.set('Atlas-Object-Descriptor', Buffer.from(wire(sample.request)).toString('base64url')); body = wire('unused');}
 if (sample.name === 'GetHealth') {h.delete('Atlas-Dataset-ID'); h.delete('Atlas-Protocol-Version');}
 if (sample.name === 'SubscribeChanges') {h.delete('Authorization'); h.delete('Atlas-Dataset-ID'); h.delete('Atlas-Protocol-Version'); h.set('Upgrade', 'websocket'); h.set('Connection', 'Upgrade'); h.set('Sec-WebSocket-Version', '13'); h.set('Sec-WebSocket-Key', handshakeKey);}
 if (sample.name === 'UploadObject') return new Request(url, {method, headers: h, body: 'abc'});
 return new Request(url, {method, headers: h, ...(body ? {body: Buffer.from(body)} : {})});
}
function response(sample: Exchange) {
 const h = headers(); let body = sample.response_schema ? JSON.stringify(sample.response) : '';
 if (sample.name === 'ReadObjectContent') {body = 'abc'; h.set('Content-Type', 'text/plain'); h.set('Content-Length', '3'); h.set('Content-Disposition', 'attachment'); h.set('Content-Digest', 'sha-256=:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=:');}
 if (sample.name === 'GetReferenceDocument') {body = readFileSync('openapi.json', 'utf8'); h.set('Content-Type', 'application/vnd.oai.openapi+json');}
 if (sample.name === 'SubscribeChanges') {h.set('Upgrade', 'websocket'); h.set('Connection', 'Upgrade'); h.set('Sec-WebSocket-Accept', 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');}
 return {status: sample.status, headers: h, body: new Response(body).body};
}

test('shared independent fixtures execute generated types and both validation boundaries', async t => {
 let valid = 0, invalid = 0; const names: string[] = [];
 for (const sample of cases) {names.push(sample.name); await t.test(sample.name, () => {
  assert(isSchemaName(sample.schema)); const name = sample.schema;
  const raw = sample.hex ? Buffer.from(sample.hex, 'hex') : sample.raw !== undefined ? new TextEncoder().encode(sample.raw) : wire(sample.value);
  if (sample.valid) {
   valid++; const value = Decode(name, raw), encoded = Encode(name, value), result = Decode(name, encoded);
   const expectedWire = sample.name === 'Plugin raw numeric spelling' ? sample.raw : JSON.stringify(sample.value);
   assert.equal(new TextDecoder().decode(encoded), expectedWire); assert.deepEqual(value, result);
  } else {invalid++; if (sample.error) assert.throws(() => Decode(name, raw), new RegExp(sample.error)); else assert.throws(() => Decode(name, raw));}
 });}
 assert.equal(valid, 276); assert.equal(invalid, 287); assert.equal(valid, manifest.valid); assert.equal(invalid, manifest.invalid); assert.deepEqual(names, manifest.case_names); assert.equal(new Set(names).size, names.length);
});

test('every HTTP message validates status, media, context, request and reply', async t => {
 const names: string[] = [];
 const ctx: ResponseContext = {datasetID: dataset, webSocketKey: handshakeKey, disposition: 'attachment'};
 for (const sample of exchanges) {names.push(sample.name); await t.test(sample.name, async () => {
  await ValidateRequest(sample.name, request(sample), dataset);
  await ValidateResponse(sample.name, response(sample), ctx);
  if (sample.name !== 'SubscribeChanges') { const mixed = request(sample); mixed.headers.set('Authorization', 'bEaReR ' + 'A'.repeat(43)); await ValidateRequest(sample.name, mixed, dataset); }
  const req = request(sample), url = new URL(req.url); url.search = '?unsupported_filter=true';
  const badQuery = new Request(url, req); await assert.rejects(ValidateRequest(sample.name, badQuery, dataset));
  const noAuth = request(sample); if (sample.name === 'SubscribeChanges') noAuth.headers.set('Sec-WebSocket-Key', 'invalid'); else noAuth.headers.delete('Authorization');
  await assert.rejects(ValidateRequest(sample.name, noAuth, dataset));
  const noContext = response(sample); noContext.headers.delete('Atlas-Dataset-ID'); await assert.rejects(ValidateResponse(sample.name, noContext, ctx));
  const badStatus = response(sample); badStatus.status = 299; await assert.rejects(ValidateResponse(sample.name, badStatus, ctx));
 });}
 assert.equal(names.length, 67); assert.deepEqual(names, manifest.exchange_names); assert.equal(new Set(names).size, 67); assert.deepEqual([...names].sort(), inventory.map(x => x[0]).sort());
});

test('declared refusal statuses use their real error schemas', async () => {
 let count = 0;
 for (const sample of cases) if (sample.name.startsWith('HTTP error ')) {
  count++; await ValidateResponse('GetAsset', {status: Number(sample.name.slice(11)), headers: headers(), body: new Response(JSON.stringify(sample.value)).body}, {datasetID: dataset});
 }
 assert.equal(count, 13);
 const h = headers(); h.set('Atlas-Protocol-Version', '0.2.0');
 await ValidateResponse('GetAsset', {status: 409, headers: h, body: new Response(JSON.stringify({dataset_id: dataset, error: {code: 'protocol_mismatch', message: 'Exact version required', request_id: coreRun, details: {expected_protocol_version: '0.2.0', actual_protocol_version: '0.1.0'}}})).body}, {datasetID: dataset});
});

test('ordinary error contracts require only actual Dataset and version headers', async () => {
 const ordinary: operations['GetAsset']['responses'][401]['headers'] = {'Atlas-Dataset-ID': dataset, 'Atlas-Protocol-Version': Version};
 assert.deepEqual(Object.keys(ordinary).sort(), ['Atlas-Dataset-ID', 'Atlas-Protocol-Version']);
 for (const sample of cases) if (sample.name.startsWith('HTTP error ')) {
  for (const operation of ['GetAsset', 'SubscribeChanges']) for (const missing of ['', 'Atlas-Dataset-ID', 'Atlas-Protocol-Version']) {
   const h = headers(); if (missing) h.delete(missing);
   const validation = ValidateResponse(operation, {status: Number(sample.name.slice(11)), headers: h, body: new Response(JSON.stringify(sample.value)).body}, {datasetID: dataset});
   if (missing) await assert.rejects(validation); else await validation;
  }
 }
});

test('Plugin null and optional payloads retain their generated presence states', async () => {
 assert.equal(Decode('PluginPayload', Encode('PluginPayload', null)), null);
 const sample = exchanges.find(x => x.name === 'CreateOperation'); assert(sample);
 const invocation = {...Decode('CreateOperationRequest', wire(sample.request)), input: null};
 assert.deepEqual(Decode('CreateOperationRequest', Encode('CreateOperationRequest', invocation)), invocation);
 const req = new Request(request(sample), {body: JSON.stringify(invocation)});
 await ValidateRequest('CreateOperation', req, dataset);
 const base: components['schemas']['Operation'] = {id: dataset, version: '1', plugin_id: dataset, release: 'independent', capability: 'null-result', input: null, state: 'completed', object_ids: []};
 for (const fields of [{}, {output: null, known_effects: null}, {output: {precise: 1.2345678901234567}, known_effects: [null, false, 0, '']}]) {
  const operation = {...base, ...fields, recovered_outcome: {state: 'completed', observed_at: null, object_ids: [], ...fields}} satisfies components['schemas']['Operation'];
  const out = Decode('Operation', Encode('Operation', operation));
  assert.equal(JSON.stringify(out), JSON.stringify(operation)); assert.equal(Object.hasOwn(out, 'output'), Object.hasOwn(fields, 'output')); assert.equal(Object.hasOwn(out, 'known_effects'), Object.hasOwn(fields, 'known_effects'));
 }
});

test('Tracks with geometry cross complete snapshot and committed frame boundaries', () => {
 for (const sample of cases) if (sample.name.startsWith('commit Track geometry ') || sample.name.startsWith('commit refuses Track geometry ')) {
  const validate = () => ValidateFrame('server', wire(sample.value), {datasetID: dataset, coreRunID: coreRun, authenticated: true, subscribed: true});
  if (sample.valid) validate(); else assert.throws(validate, new RegExp(sample.error ?? ''));
 }
});

test('null geometry refuses at root and nested boundaries', () => {
 for (const name of ['Geometry', 'PointGeometry', 'LineGeometry', 'PolygonGeometry'] as const) assert.throws(() => Decode(name, wire(null)), /^Error: invalid_geometry$/);
 assert.throws(() => Decode('GeometryObservation', wire({geometry: null, observed_at: null})), /^Error: invalid_geometry$/);
 Decode('GeometryObservation', wire({geometry: {type: 'Point', coordinates: [0, 90]}, observed_at: null}));
});

test('concrete geometry retains the exact vertex refusal category', () => {
 for (const count of [1024, 1025]) for (const name of ['LineGeometry', 'Geometry'] as const) {
  const data = wire({type: 'LineString', coordinates: Array.from({length: count}, () => [0, 0])});
  if (count === 1024) Decode(name, data); else assert.throws(() => Decode(name, data), /^Error: geometry_limit_exceeded$/);
 }
});

test('downloads compare media case while preserving descriptor facts and checking bytes', async () => {
 const stored = exchanges.find(sample => sample.name === 'GetObject'); assert(stored);
 const original = {...Decode('GetObjectResponse', wire(stored.response)).data, content_type: 'Text/Plain'};
 const object = Decode('Object', Encode('Object', original));
 const digest = 'sha-256=:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=:';
 for (const [kind, body, length, hash, valid] of [
  ['Text/Plain', 'abc', '3', digest, true],
  ['text/plain', 'abc', '3', digest, true],
  ['TEXT/PLAIN; charset=UTF-8', 'abc', '3', digest, true],
  ['image/png', 'abc', '3', digest, false],
  ['Text/Plain', 'abd', '3', digest, false],
  ['Text/Plain', 'ab', '3', digest, false],
  ['Text/Plain', 'abcd', '3', digest, false],
  ['Text/Plain', 'abc', '4', digest, false],
  ['Text/Plain', 'abc', '3', 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:', false],
 ] satisfies [string, string, string, string, boolean][]) {
  const h = headers(); h.set('Content-Type', kind); h.set('Content-Length', length); h.set('Content-Digest', hash); h.set('Content-Disposition', 'attachment');
  const result = ValidateResponse('ReadObjectContent', {status: 200, headers: h, body: new Response(body).body}, {datasetID: dataset, object, disposition: 'attachment'});
  if (valid) await result; else await assert.rejects(result);
 }
 assert.equal(object.content_type, 'Text/Plain'); assert.deepEqual(Decode('Object', Encode('Object', object)), original);
});

test('consumer facts retain exact spelling, times, precision, null and absence', () => {
 const sample = exchanges.find(x => x.name === 'GetAsset'); assert(sample);
 const asset = Decode('GetAssetResponse', wire(sample.response)).data;
 assert.equal(asset.id, dataset); assert.equal(asset.version, '18446744073709551615');
 const section = asset.telemetry; assert(section?.state === 'reported'); assert(section.result.state === 'value');
 const value = section.result.value; assert(value.position);
 assert.equal(value.position.latitude, 51.5074123456789); assert.equal(value.position.longitude, -0.1278123456789);
 assert.equal(value.observed_at, '2026-10-18T01:02:03.123400000+05:30'); assert.equal(value.position_observed_at, '2026-10-18T01:02:01+05:30'); assert.equal(value.altitude_observed_at, null); assert(!Object.hasOwn(value, 'airspeed'));
 const typed: components['schemas']['Telemetry'] = {position: null, altitude: null, ground_speed: null, observed_at: null};
 assert.deepEqual(Decode('Telemetry', Encode('Telemetry', typed)), typed);
 const unknownUndefined = {latitude: 0, longitude: 0, unexpected: undefined};
 assert.throws(() => Encode('Position', unknownUndefined));
 const nan = {...typed, ground_speed: Number.NaN}; assert.throws(() => Encode('Telemetry', nan));
 Reflect.deleteProperty(typed, 'position'); assert.throws(() => Encode('Telemetry', typed));
 assert.throws(() => Encode('Name', '\ud800'));
 for (const entry of Catalog()) for (const sample of cases.filter(x => ['queued move', 'pause', 'resume'].includes(x.name))) {
  const command = sample.name === 'queued move' ? 'move_to' : sample.name;
  if (command === entry.command) Decode(entry.schema, wire(sample.value)); else assert.throws(() => Decode(entry.schema, wire(sample.value)));
 }
 assert.equal(Version, '0.1.0'); assert.deepEqual(Catalog().map(x => x.command), ['move_to', 'pause', 'resume']); assert.notEqual(Catalog(), Catalog());
});

test('raw allocation, work and file admission limits', async () => {
 assert.throws(() => Decode('PluginPayload', wire('12345678'), {...DefaultLimits(), maxJSONBytes: 8}));
 assert.throws(() => Decode('PluginPayload', wire([[[0]]]), {...DefaultLimits(), maxDepth: 2}));
 assert.throws(() => Decode('PluginPayload', wire([0, 0, 0]), {...DefaultLimits(), maxValues: 3}));
 const content: unknown = JSON.parse(readFileSync(fixtureRoot + '/content.json', 'utf8'));
 const validate = ajv.compile<{descriptor: unknown}>({type: 'object', required: ['descriptor'], properties: {descriptor: {}}}); assert(validate(content));
 const descriptor = Decode('UploadObjectDescriptor', wire(content.descriptor));
 async function* stream(s: string) {for (const c of s) yield new TextEncoder().encode(c);}
 await CheckContent(descriptor, stream('abc'));
 for (const bad of ['ab', 'abcd', 'abd']) await assert.rejects(CheckContent(descriptor, stream(bad)));
 await assert.rejects(CheckContent({...descriptor, byte_length: '2000000001'}, stream('')), /payload_too_large/);
 await assert.rejects(CheckContent({...descriptor, byte_length: '100000000'}, stream('')), /integrity_fault/);
 const ws = exchanges.find(x => x.name === 'SubscribeChanges'); assert(ws); const bad = response(ws); bad.headers.set('Sec-WebSocket-Accept', 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=');
 await assert.rejects(ValidateResponse('SubscribeChanges', bad, {datasetID: dataset, webSocketKey: handshakeKey}));
});

test('WebSocket authentication and release stay separate from data subscription', () => {
 const validate = ajv.compile<{schema: string; value: unknown}[]>({type: 'array', items: {type: 'object', required: ['schema', 'value'], properties: {schema: {type: 'string'}, value: {}}}});
 const frames: unknown = JSON.parse(readFileSync(fixtureRoot + '/frames.json', 'utf8')); assert(validate(frames)); assert.equal(frames.length, 11);
 for (const sample of frames) {
  const direction = ['AuthenticateFrame', 'SubscribeChangesFrame', 'ReleaseSnapshotFrame'].includes(sample.schema) ? 'client' : 'server';
  const ctx: FrameContext = {datasetID: dataset, coreRunID: coreRun, authenticated: sample.schema !== 'AuthenticateFrame', subscribed: true};
  ValidateFrame(direction, wire(sample.value), ctx);
  if (sample.schema === 'ReleaseSnapshotFrame') ValidateFrame(direction, wire(sample.value), {...ctx, subscribed: false});
  if (sample.schema !== 'SyncErrorFrame') assert.throws(() => ValidateFrame(direction, wire(sample.value), {...ctx, datasetID: coreRun}));
  if (sample.schema === 'ChangesFrame') assert.throws(() => ValidateFrame(direction, wire(sample.value), {...ctx, authenticated: false}));
 }
});

test('release UUID identity folds case and preserves source spelling', () => {
 for (const run of [dataset, dataset.toLowerCase(), coreRun]) {
  const frame = {type: 'release_snapshot', dataset_id: dataset, protocol_version: Version, core_run_id: dataset,
   request: {request_id: coreRun, snapshot_id: dataset, load_id: coreRun, core_run_id: run}} satisfies components['schemas']['ReleaseSnapshotFrame'];
  const encoded = Encode('ReleaseSnapshotFrame', frame);
  const validate = () => ValidateFrame('client', encoded, {datasetID: dataset, coreRunID: dataset.toLowerCase(), authenticated: true, subscribed: false});
  if (run === coreRun) assert.throws(validate, /release Core run mismatch/); else validate();
  assert.deepEqual(Decode('ReleaseSnapshotFrame', encoded), frame);
 }
});

test('reserve UUID uniqueness folds case and preserves distinct IDs', () => {
 for (const id of [dataset, dataset.toLowerCase(), (dataset.slice(0, -1) + '7').toLowerCase()]) {
  const power = {external_power: null, observed_at: null, reserves: [
   {id: dataset, kind: 'fuel', remaining_percent: null, observed_at: null},
   {id, kind: 'fuel', remaining_percent: null, observed_at: null},
  ]} satisfies components['schemas']['Power'];
  if (id.toLowerCase() === dataset.toLowerCase()) assert.throws(() => Decode('Power', wire(power)), /duplicate id/);
  else assert.deepEqual(Decode('Power', Encode('Power', power)), power);
 }
});

test('API keys agree across frame schemas, connection frames, credentials and HTTP', async t => {
 for (const [name, secret, valid] of [
  ['minimum', 'A'.repeat(43), true], ['alphabet', 'aZ09_-'.repeat(21) + '-_', true],
  ['too short', 'A'.repeat(42), false], ['too long', 'A'.repeat(129), false],
  ['plus', '+'.repeat(43), false], ['slash', '/'.repeat(43), false],
  ['padding', 'A'.repeat(42) + '=', false], ['space', 'A'.repeat(42) + ' A', false],
 ] satisfies [string, string, boolean][]) await t.test(name, async () => {
  const frame = {type: 'authenticate', dataset_id: dataset, protocol_version: Version, api_key: secret};
  const checks = [() => Decode('AuthenticateFrame', wire(frame)),
   () => ValidateFrame('client', wire(frame), {datasetID: dataset, coreRunID: '', authenticated: false, subscribed: false}),
   () => Decode('CredentialFacts', wire({key_id: coreRun, secret}))];
  for (const check of checks) {if (valid) check(); else assert.throws(check);}
  const h = headers(); h.set('Authorization', 'bEaReR ' + secret);
  const result = ValidateRequest('GetAsset', new Request('https://atlas.invalid/assets/' + dataset, {headers: h}), dataset);
  if (valid) await result; else await assert.rejects(result, /unauthenticated/);
 });
});

test('MIME header parsing accepts ordinary spelling and rejects malformed values', async t => {
 const data: unknown = JSON.parse(readFileSync(fixtureRoot + '/http-headers.json', 'utf8'));
 const validate = ajv.compile<{name: string; operation: string; media: string; disposition: string; mode: '' | 'inline' | 'attachment'; valid: boolean}[]>({type: 'array', items: {type: 'object', additionalProperties: false, required: ['name', 'operation', 'media', 'disposition', 'mode', 'valid'], properties: {name: {type: 'string'}, operation: {type: 'string'}, media: {type: 'string'}, disposition: {type: 'string'}, mode: {enum: ['', 'inline', 'attachment']}, valid: {type: 'boolean'}}}});
 assert(validate(data));
 for (const sample of data) await t.test(sample.name, async () => {
  const exchange = exchanges.find(x => x.name === sample.operation); assert(exchange);
  const result = response(exchange); result.headers.set('Content-Type', sample.media);
  if (sample.operation === 'ReadObjectContent') result.headers.set('Content-Disposition', sample.disposition);
  const ctx: ResponseContext = {datasetID: dataset, ...(sample.mode ? {disposition: sample.mode} : {})};
  const checked = ValidateResponse(sample.operation, result, ctx);
  if (sample.valid) await checked; else await assert.rejects(checked);
 });
});

test('caller-owned file staging preserves verified uploads and downloads', async t => {
 const uploaded = exchanges.find(x => x.name === 'UploadObject'), stored = exchanges.find(x => x.name === 'GetObject'); assert(uploaded && stored);
 const descriptor = Decode('UploadObjectDescriptor', wire(uploaded.request)), object = Decode('GetObjectResponse', wire(stored.response)).data;
 assert.equal(descriptor.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'); assert.equal(object.sha256, descriptor.sha256);
 for (const direction of ['upload', 'download']) for (const content of ['abc', 'ab', 'abd']) await t.test(direction + '/' + content, async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-protocol-staging-'));
  try {
   const sourcePath = join(root, 'source'), stagePath = join(root, 'staging'), finalPath = join(root, 'verified');
   await writeFile(sourcePath, content);
   const source = await open(sourcePath, 'r');
   try {
    const staged = await open(stagePath, 'wx');
    try {
     const fileStream = new ReadableStream<Uint8Array>({async pull(controller) {
      const chunk = new Uint8Array(2), {bytesRead} = await source.read(chunk);
      if (bytesRead) controller.enqueue(chunk.subarray(0, bytesRead)); else controller.close();
     }});
     const body = fileStream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, controller) {await staged.writeFile(chunk); controller.enqueue(chunk);},
      async flush() {await staged.close();},
     }));
     let verified: Promise<unknown>;
     if (direction === 'upload') {
      const h = headers(); h.set('Content-Type', 'application/octet-stream'); h.set('Atlas-Object-Descriptor', Buffer.from(Encode('UploadObjectDescriptor', descriptor)).toString('base64url'));
      const init = {method: 'POST', headers: h, body, duplex: 'half'} satisfies RequestInit & {duplex: 'half'};
      verified = ValidateRequest('UploadObject', new Request('https://atlas.invalid/objects', init), dataset).then(result => assert.deepEqual(result.upload, descriptor));
     } else {
      const h = headers(); h.set('Content-Type', 'text/plain'); h.set('Content-Length', '3'); h.set('Content-Digest', 'sha-256=:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=:'); h.set('Content-Disposition', 'attachment');
      verified = ValidateResponse('ReadObjectContent', {status: 200, headers: h, body}, {datasetID: dataset, object, disposition: 'attachment'});
     }
     if (content === 'abc') await verified; else await assert.rejects(verified, /integrity_fault/);
    } finally {await staged.close();}
   } finally {await source.close();}
   if (content === 'abc') {await rename(stagePath, finalPath); assert.equal(await readFile(finalPath, 'utf8'), 'abc');}
   else await assert.rejects(stat(finalPath), {code: 'ENOENT'});
  } finally {await rm(root, {recursive: true, force: true});}
 });
});


test('Plugin numeric source survives public Decode and Encode', () => {
 for (const token of ['1.0', '-0', '1e-400', '9007199254740993', '12345678901234567890', '0.10000000000000001']) {
  const wire = new TextEncoder().encode(token);
  assert.equal(new TextDecoder().decode(Encode('PluginPayload', Decode('PluginPayload', wire))), token);
 }
});
test('typed integers refuse fractions hidden by double rounding', () => {
 for (const token of ['100.0000000000000000001', '1e-400']) assert.throws(() => Decode('ErrorDetails', new TextEncoder().encode('{"retry_after_seconds":' + token + '}')));
});


test('exact integers reach typed query consumers and generated unions', async () => {
 for (const token of ['100', '100.0', '1e2', '1e+2', '1000e-1', '1.00e2']) {
  const raw = new TextEncoder().encode('{"page_size":' + token + '}');
  assert.equal(Decode('EntityListQuery', raw).page_size, 100);
  const checked = await ValidateRequest('ListAssets', new Request('https://atlas.invalid/assets?page_size=' + encodeURIComponent(token), {headers: headers()}), dataset);
  assert.equal(Decode('EntityListQuery', checked.query).page_size, 100);
 }
 for (const token of ['100.0000000000000000001', '1e-400', '0.1', '1001', '-0', '0e' + '9'.repeat(1000), '1e1000000000']) {
  assert.throws(() => Decode('EntityListQuery', new TextEncoder().encode('{"page_size":' + token + '}')));
  await assert.rejects(ValidateRequest('ListAssets', new Request('https://atlas.invalid/assets?page_size=' + encodeURIComponent(token), {headers: headers()}), dataset));
 }
 for (const [token, expected] of [['0', 0], ['-0', -0], ['0e' + '9'.repeat(10000), 0], ['-0.00e-' + '9'.repeat(10000), -0], ['9007199254740991', 9007199254740991], ['9.007199254740991e15', 9007199254740991]] as const) {
  assert.equal(Decode('ErrorDetails', new TextEncoder().encode('{"retry_after_seconds":' + token + '}')).retry_after_seconds, expected);
 }
 for (const token of ['9007199254740992', '9007199254740993', '1e20', '1e1000000000', '1e-400', '100.0000000000000000001', '-1']) assert.throws(() => Decode('ErrorDetails', new TextEncoder().encode('{"retry_after_seconds":' + token + '}')));
 const challenge = '{"challenge_id":"' + dataset + '","request_id":"' + dataset + '","dataset_id":"' + dataset + '","asset_id":"' + dataset + '","process_generation":"' + dataset + '","core_run_id":"' + coreRun + '","issued_at":"2026-10-18T00:00:00Z","expires_at":"2026-10-18T00:00:10Z","expires_in_seconds":';
 for (const token of ['10.0', '1e1']) assert.equal(Decode('ContactChallenge', new TextEncoder().encode(challenge + token + '}')).expires_in_seconds, 10);
 assert.throws(() => Decode('ContactChallenge', new TextEncoder().encode(challenge + '10.0000000000000000001}')));
 const frame = Decode('ServerFrame', new TextEncoder().encode('{"type":"error","dataset_id":"' + dataset + '","core_run_id":"' + coreRun + '","protocol_version":"0.1.0","response":{"error":{"code":"resource_limit","message":"busy","request_id":"' + coreRun + '","details":{"retry_after_seconds":1e2}}}}'));
 assert(frame.type === 'error'); assert.equal(frame.response.error.details?.retry_after_seconds, 100);
});

function pluginObject(value: unknown): asserts value is Record<string, unknown> {
 assert(typeof value === 'object' && value !== null && !Array.isArray(value));
}

test('uniform Plugin atoms preserve source at every declared payload location', () => {
 const bytes = (raw: string) => new TextEncoder().encode(raw);
 const chars = (raw: Uint8Array) => new TextDecoder().decode(raw);
 for (const token of ['1', '42', '1.0', '-0', '1e-400', '9007199254740993', '12345678901234567890', '0.10000000000000001', '1.00000000000000001', '9.007199254740993e15', '1e308']) {
  const root = Decode('PluginPayload', bytes(token));
  assert.equal(typeof root, 'object'); assert(Object.isFrozen(root)); assert.equal(PluginNumberText(root), token);
  assert.equal(chars(Encode('PluginPayload', root)), token);
  const payload = '{ "10" : [' + token + ',42], "2": ' + token + ', "page_size": 100.0000000000000000001, "retry_after_seconds": 1e-400 }';
  const request = Decode('CreateOperationRequest', bytes('{"request_id":"' + coreRun + '","operation_id":"' + coreRun + '","plugin_id":"' + coreRun + '","release":"r1","capability":"probe","input":' + payload + '}'));
  pluginObject(request.input); assert.equal(PluginNumberText(request.input['2']), token);
  assert(Array.isArray(request.input['10'])); assert.equal(PluginNumberText(request.input['10'][0]), token); assert.equal(PluginNumberText(request.input['10'][1]), '42');
  assert.equal(PluginNumberText(request.input.page_size), '100.0000000000000000001'); assert.equal(PluginNumberText(request.input.retry_after_seconds), '1e-400');
  const forwarded = chars(Encode('CreateOperationRequest', request)); assert(forwarded.includes('"2":' + token)); assert(forwarded.includes('"10":[' + token + ',42]'));
  const recovery = '{"state":"completed","observed_at":null,"object_ids":[],"output":' + payload + ',"known_effects":[' + token + ',null]}';
  const recovered = Decode('RecoveredOutcome', bytes(recovery));
  pluginObject(recovered.output); assert.equal(PluginNumberText(recovered.output['2']), token);
  assert(chars(Encode('RecoveredOutcome', recovered)).includes('"known_effects":[' + token + ',null]'));
  const base = '{"id":"' + coreRun + '","version":"1","plugin_id":"' + coreRun + '","release":"r1","capability":"probe","input":' + payload + ',"state":"interrupted","object_ids":[],"recovered_outcome":' + recovery;
  for (const tail of ['}', ',"known_effects":null}', ',"output":' + payload + ',"known_effects":[' + token + ',null]}']) {
   const op = Decode('Operation', bytes(base + tail)), wire = Encode('Operation', op), again = Decode('Operation', wire);
   assert.deepEqual(again, op); assert.equal(Object.hasOwn(op, 'output'), tail.includes('"output"')); assert.equal(Object.hasOwn(op, 'known_effects'), tail.includes('"known_effects"'));
   if (tail === ',"known_effects":null}') assert.equal(op.known_effects, null);
   pluginObject(again.input); assert.equal(PluginNumberText(again.input['2']), token); assert(chars(wire).includes('"2":' + token));
  }
 }
 assert.equal(PluginNumberText(1), undefined); assert.equal(PluginNumberText(null), undefined); assert.equal(PluginNumberText({rawJSON: '1'}), undefined);
 assert.equal(chars(Encode('PluginPayload', {rawJSON: '1'})), '{"rawJSON":"1"}');
 let calls = 0;
 const accessor = Object.defineProperty({}, 'rawJSON', {enumerable: true, get() {calls++; return '1';}});
 assert.equal(PluginNumberText(accessor), undefined);
 assert.throws(() => Encode('PluginPayload', accessor), /JSON accessor/);
 assert.throws(() => Encode('PluginPayload', {toJSON() {calls++; return 1;}}), /unsupported JSON value/);
 assert.equal(calls, 0);
 const exact = Decode('PluginPayload', bytes('1.0')), copy = Decode('PluginPayload', Encode('PluginPayload', exact));
 assert.equal(PluginNumberText(copy), '1.0'); assert.throws(() => structuredClone(exact), {name: 'DataCloneError'});
 const rounded = Decode('PluginPayload', Encode('PluginPayload', Number('9007199254740993')));
 assert.equal(PluginNumberText(rounded), '9007199254740992');
});

test('canonical numeric size, atom accounting, and existing refusals share limits', () => {
 const bytes = (raw: string) => new TextEncoder().encode(raw);
 for (const raw of ['{"field":"📍","retry_after_seconds":1e15}', '{"retry_after_seconds":1e15}', '{"retry_after_seconds":1e15,"required_limits":{"max_changes":100.0,"max_batch_bytes":"1"}}']) {
  const size = bytes(raw).byteLength + 12 - (raw.includes('100.0') ? 2 : 0);
  assert.throws(() => Decode('ErrorDetails', bytes(raw), {...DefaultLimits(), maxJSONBytes: size - 1}), /payload_too_large/);
  Decode('ErrorDetails', bytes(raw), {...DefaultLimits(), maxJSONBytes: size});
 }
 for (const token of ['0.1', '1e308']) {
  const value = Decode('Altitude', bytes('{"metres":' + token + ',"reference":"wgs84_ellipsoid"}'));
  assert.equal(value.metres, Number(token)); Encode('Altitude', value);
 }
 for (const raw of ['1e309', '{"x":1,"\\u0078":2}', '"\\ud800"', '1 2']) assert.throws(() => Decode('PluginPayload', bytes(raw)));
 assert.throws(() => Decode('PluginPayload', Uint8Array.of(255)));
 const raw = '[9007199254740993,9007199254740993]', value = Decode('PluginPayload', bytes(raw));
 assert.equal(new TextDecoder().decode(Encode('PluginPayload', value, {...DefaultLimits(), maxValues: 3, maxDepth: 1, maxJSONBytes: raw.length})), raw);
 assert.throws(() => Encode('PluginPayload', value, {...DefaultLimits(), maxValues: 2}));
 assert.throws(() => Encode('PluginPayload', value, {...DefaultLimits(), maxJSONBytes: raw.length - 1}));
 assert.throws(() => Decode('PluginPayload', bytes('[[1]]'), {...DefaultLimits(), maxDepth: 1}));
 for (const [raw, maxValues, valid] of [['[1,42]', 3, true], ['[1,42]', 2, false], ['{"a":1,"b":42}', 5, true], ['{"a":1,"b":42}', 4, false]] as const) {
  const check = () => Decode('PluginPayload', bytes(raw), {...DefaultLimits(), maxValues}); if (valid) check(); else assert.throws(check);
 }
 const outcome = Decode('RecoveredOutcome', bytes('{"state":"completed","observed_at":null,"object_ids":[],"output":[1,42],"known_effects":[1,42]}'));
 assert.throws(() => Encode('RecoveredOutcome', outcome, {...DefaultLimits(), maxValues: 10}));
});

test('unsupported numeric runtime features fail at module load', () => {
 const target = new URL('../ts/index.js', import.meta.url).href;
 for (const setup of ["JSON.rawJSON = undefined;", "JSON.isRawJSON = undefined;", "JSON.rawJSON = text => Object.freeze({rawJSON: text});", "JSON.isRawJSON = () => false;", "const native = JSON.parse; JSON.parse = (text, reviver) => native(text, reviver ? function(key, value) {return reviver.call(this, key, value);} : undefined);"]) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', setup + 'await import(' + JSON.stringify(target) + ');'], {encoding: 'utf8'});
  assert.ifError(result.error); assert.equal(result.signal, null); assert.notEqual(result.status, 0); assert.match(result.stderr, /Atlas requires/);
 }
});
