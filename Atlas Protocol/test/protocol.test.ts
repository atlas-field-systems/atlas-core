import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {Ajv2020} from 'ajv/dist/2020.js';
import {Decode, Encode, Version, Catalog, isSchemaName, DefaultLimits, ValidateRequest, ValidateResponse, ValidateFrame, CheckContent} from '../ts/index.js';
import type {ResponseContext, FrameContext, components} from '../ts/index.js';
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
   assert.deepEqual(result, sample.value); assert.deepEqual(value, result);
  } else {invalid++; if (sample.error) assert.throws(() => Decode(name, raw), new RegExp(sample.error)); else assert.throws(() => Decode(name, raw));}
 });}
 assert.equal(valid, 234); assert.equal(invalid, 239); assert.equal(valid, manifest.valid); assert.equal(invalid, manifest.invalid); assert.deepEqual(names, manifest.case_names); assert.equal(new Set(names).size, names.length);
});

test('every HTTP message validates status, media, context, request and reply', async t => {
 const names: string[] = [];
 const ctx: ResponseContext = {datasetID: dataset, webSocketKey: handshakeKey, disposition: 'attachment'};
 for (const sample of exchanges) {names.push(sample.name); await t.test(sample.name, async () => {
  await ValidateRequest(sample.name, request(sample), dataset);
  await ValidateResponse(sample.name, response(sample), ctx);
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
