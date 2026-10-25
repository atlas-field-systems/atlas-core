import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as s from '../../../Atlas Protocol/test/samples.mjs';

const build = pathToFileURL(resolve(process.argv[2]));
const { default: bend } = await import(new URL('driver.mjs', build));
const { default: domain } = await import(new URL('schemas.mjs', build));
const require = createRequire(build);
const { default: Ajv2020 } = await import(pathToFileURL(require.resolve('ajv/dist/2020.js')));

const list = (xs) => xs.reduceRight((tail, head) => ({ $: 'Con', head, tail }), { $: 'Nil' });
function array(xs) {
  const result = [];
  for (; xs.$ === 'Con'; xs = xs.tail) result.push(xs.head);
  assert.equal(xs.$, 'Nil');
  return result;
}
function json(x) {
  if (x === undefined) return { $: 'JMissing' };
  if (x === null) return { $: 'JNull' };
  if (typeof x === 'string') return { $: 'JStr', value: x };
  if (typeof x === 'boolean') return { $: 'JBool', value: x };
  if (typeof x === 'number') return { $: 'JNum', raw: String(x) };
  if (Array.isArray(x)) return { $: 'JArr', items: list(x.map(json)) };
  return { $: 'JObj', members: list(Object.entries(x).map(([key, value]) => ({ $: 'Member', key, value: json(value) }))) };
}
function value(x) {
  switch (x.$) {
    case 'JMissing': return undefined;
    case 'JNull': return null;
    case 'JBool':
    case 'JStr': return x.value;
    case 'JNum': return Number(x.raw);
    case 'JArr': return array(x.items).map(value);
    case 'JObj': return Object.fromEntries(array(x.members).map((m) => [m.key, value(m.value)]));
    default: assert.fail(`Unknown JSON ${x.$}`);
  }
}
let passed = 0;
const test = (name, run) => {
  try { run(); passed++; } catch (error) { error.message = `${name}. ${error.message}`; throw error; }
};
const done = (result) => { assert.equal(result.$, 'Done', JSON.stringify(result)); return result.value; };
const fail = (result, code, issue) => {
  assert.equal(result.$, 'Fail', JSON.stringify(result));
  assert.equal(result.error.code.$, code);
  if (issue) assert.deepEqual(array(result.error.issues).map(({ path, message }) => ({ path, message })), [issue]);
};
const headers = (fields) => json(Object.entries(fields).map(([name, value]) => ({ name, value })));
const auth = () => headers({ Authorization: `Bearer ${'A'.repeat(43)}`, 'Atlas-Dataset-ID': s.id, 'Atlas-Protocol-Version': '0.1.0' });
const routes = JSON.parse(await readFile(new URL('../../../Atlas Protocol/test/routes.json', import.meta.url)));
const catalog = value(bend.catalog());
test('exact unchanged route inventory', () => assert.deepEqual(catalog.map((x) => `${x.operationId} ${x.method} ${x.path}`), routes));
test('all 66 operations represented', () => assert.equal(catalog.length, 66));
const ownNames = array(bend.names());
const ownDefinitions = Object.fromEntries(array(bend.definitions()).map((m) => [m.key, value(m.value)]));
test('definitions match schema and names', () => {
  assert.deepEqual(Object.keys(ownDefinitions), ownNames);
  assert.equal(new Set(ownNames).size, 208);
  for (const name of ownNames) assert.deepEqual(value(bend.schema(name)), ownDefinitions[name]);
  assert.equal(value(bend.schema('Unknown')), undefined);
});
const schemas = { ...Object.fromEntries(array(domain.names()).map((name) => [name, value(domain.schema(name))])), ...ownDefinitions };
function inspect(x) {
  if (!x || typeof x !== 'object') return;
  if (x.$ref) assert(Object.hasOwn(schemas, x.$ref.slice('#/components/schemas/'.length)), x.$ref);
  for (const child of Object.values(x)) inspect(child);
}
test('all references resolve in real domain and exchange registry', () => inspect(schemas));
const ajv = new Ajv2020({ strict: true, strictSchema: false, allErrors: true });
const id = 'urn:atlas:bend:exchanges';
ajv.addSchema({ $id: id, $schema: 'https://json-schema.org/draft/2020-12/schema', components: { schemas } });
const validators = Object.fromEntries(ownNames.map((name) => [name, ajv.getSchema(`${id}#/components/schemas/${name}`)]));
const accepts = (name, x) => assert(validators[name](x), `${name}. ${ajv.errorsText(validators[name].errors)}`);
const refuses = (name, x) => assert.equal(validators[name](x), false, name);
const envelope = (data) => ({ dataset_id: s.id, data, commit_cursor: 'committed' });
const check = (operation, request, data, cursor = 'committed', status = 200, version = '0.1.0') =>
  bend.check(operation, json(request), json({ dataset_id: s.id, data, ...(cursor === null ? {} : { commit_cursor: cursor }) }), status, version);

for (const entry of catalog) {
  const { operationId: name, transport } = entry;
  const [request, data] = s.examples[name];
  test(`${name} request schema`, () => accepts(`Request.${name}`, request));
  test(`${name} unknown request member`, () => refuses(`Request.${name}`, { ...request, extra: 1 }));
  if (transport === 'content') {
    const descriptor = { object_id: request.object_id, ...s.storage, disposition: request.disposition };
    test(`${name} content result schema`, () => accepts(`Response.${name}`, { kind: 'content', status: 200, descriptor }));
    test(`${name} content correlation`, () => done(check(name, request, descriptor)));
    test(`${name} requires request`, () => fail(check(name, undefined, descriptor), 'InvalidHttp'));
    continue;
  }
  if (transport === 'reference') {
    test(`${name} reference result schema`, () => accepts(`Response.${name}`, { kind: 'reference', status: 200, media: 'text/html', document: '<html></html>' }));
    continue;
  }
  test(`${name} raw success schema`, () => accepts(`Success.${name}`, envelope(data)));
  test(`${name} result wrapper schema`, () => accepts(`Response.${name}`, { kind: 'success', status: 200, body: envelope(data) }));
  test(`${name} success correlation`, () => done(check(name, request, data)));
  test(`${name} raw success rejects unknown fields`, () => refuses(`Success.${name}`, { ...envelope(data), extra: true }));
  if (entry.committed) test(`${name} commit cursor required`, () => refuses(`Success.${name}`, { dataset_id: s.id, data }));
}

for (const [name, key, dataKey] of [
  ['GetOperator', 'operator_id', 'operator_id'], ['CreateOperator', 'operator_id', 'operator_id'],
  ['EditOperator', 'operator_id', 'operator_id'], ['GetAsset', 'asset_id', 'id'],
  ['GetAssetStatus', 'asset_id', 'asset_id'], ['SetTaskOrder', 'asset_id', 'id'],
  ['EditObservation', 'observation_id', 'id'], ['GetObservation', 'observation_id', 'id'],
  ['GetTrack', 'track_id', 'id'], ['EditTrack', 'track_id', 'id'],
  ['CreateGeofeature', 'geofeature_id', 'id'], ['GetGeofeature', 'geofeature_id', 'id'],
  ['EditGeofeature', 'geofeature_id', 'id'], ['GetTask', 'task_id', 'task_id'],
  ['GetObject', 'object_id', 'object_id'], ['EditObject', 'object_id', 'object_id'],
]) test(`${name} rejects different result identity`, () => {
  const [request, data] = s.examples[name];
  assert.notEqual(request[key], s.id);
  fail(check(name, request, { ...data, [dataKey]: s.id }), 'InvalidHttp');
});

for (const name of ['ListResources', 'ReadActivity', 'ListApiKeys', 'ListOperators', 'ListAssets', 'ListObservations', 'ListTracks', 'ListGeofeatures', 'ListTasks', 'ListObjects', 'GetAssetObjects', 'GetObservationObjects', 'GetTrackObjects', 'GetGeofeatureObjects', 'GetTaskObjects', 'GetTrackObservations']) {
  const [request, data] = s.examples[name];
  test(`${name} request page size`, () => fail(check(name, { ...request, page_size: 1 }, { ...data, items: [data.items[0], data.items[0]] }), 'InvalidHttp'));
  test(`${name} continuation excludes first page context`, () => done(check(name, { page_token: 'next' }, data)));
}
for (const name of ['GetAssetByAlias', 'GetObservationByAlias', 'GetTrackByAlias', 'GetGeofeatureByAlias']) {
  const [, data] = s.examples[name];
  test(`${name} uses supplied Unicode fold callback`, () => done(check(name, { alias: 'Straße' }, { ...data, alias: 'STRASSE' })));
  test(`${name} refuses different alias`, () => fail(check(name, { alias: 'different' }, data), 'InvalidHttp'));
}
for (const field of ['source_asset_id', 'publisher_subject']) {
  const [request, data] = s.examples.CreateObservation;
  const supplied = field === 'source_asset_id' ? s.assetId : { id: 'subject', lifetime_id: s.id };
  test(`creation refuses invented ${field}`, () => fail(check('CreateObservation', request, { ...data, observation: { ...data.observation, [field]: supplied } }), 'InvalidHttp'));
  test(`creation refuses missing ${field}`, () => fail(check('CreateObservation', { ...request, [field]: supplied }, data), 'InvalidHttp'));
  test(`creation matches supplied ${field}`, () => done(check('CreateObservation', { ...request, [field]: supplied }, { ...data, observation: { ...data.observation, [field]: supplied } })));
}
for (const field of ['request_id', 'task_id', 'asset_id', 'command', 'scheduling', 'inputs']) {
  const [request, data] = s.examples.CreateTask;
  test(`task creation matches ${field}`, () => fail(check('CreateTask', request, { ...data, [field]: field === 'inputs' ? {} : 'different' }), 'InvalidHttp'));
}
for (const field of ['object_id', 'byte_length', 'sha256', 'content_type']) {
  const [request, data] = s.examples.UploadObject;
  test(`upload matches ${field}`, () => fail(check('UploadObject', request, { ...data, [field]: 'different' }), 'InvalidHttp'));
}
for (const name of ['ReportTaskExecution', 'ReportTaskResults', 'ConfirmTaskOrder']) {
  const [request, data] = s.examples[name];
  test(`${name} binds evidence asset`, () => fail(check(name, { evidence: { ...request.evidence, asset_id: s.id } }, data), 'InvalidHttp'));
}
test('authored Asset update needs commit cursor', () => fail(check('UpdateAsset', { ...s.examples.UpdateAsset[0], alias: 'new' }, s.examples.UpdateAsset[1], null), 'InvalidHttp'));
test('evidence-only Asset update may omit commit cursor', () => done(check('UpdateAsset', ...s.examples.UpdateAsset, null)));
test('Asset update evidence presence follows report presence', () => fail(check('UpdateAsset', s.examples.UpdateAsset[0], { asset: s.asset }), 'InvalidHttp'));
test('pending cancellation needs original request ID', () => fail(check('RequestTaskCancellation', s.examples.RequestTaskCancellation[0], { ...s.examples.RequestTaskCancellation[1], cancellation_request_id: s.id }), 'InvalidHttp'));
test('pending cancellation needs commit cursor', () => fail(check('RequestTaskCancellation', ...s.examples.RequestTaskCancellation, null), 'InvalidHttp'));
test('terminal cancellation may omit commit cursor', () => done(check('RequestTaskCancellation', s.examples.RequestTaskCancellation[0], { ...s.task, execution_state: 'completed', cancellation_request_id: null }, null)));
test('readiness 503 is a typed false success', () => done(check('GetReadiness', {}, { ready: false }, null, 503)));
test('readiness status binds ready', () => fail(check('GetReadiness', {}, { ready: true }, null, 503), 'InvalidHttp'));
test('health version binds response header', () => fail(check('GetHealth', {}, s.health, null, 200, 'other'), 'InvalidHttp'));
for (const [name, kind] of [['GetAssetMovementHistory', 'asset'], ['GetObservationMovementHistory', 'observation'], ['GetTrackMovementHistory', 'track']]) {
  const [request, data] = s.examples[name];
  const reading = kind === 'track' ? { track_ids: [request.entity_id] } : { source_entity_kind: kind, source_entity_id: request.entity_id };
  test(`${name} correct first-page source`, () => done(check(name, request, { ...data, readings: [reading] })));
  test(`${name} wrong first-page source`, () => fail(check(name, request, { ...data, readings: [{ ...reading, source_entity_id: s.id, track_ids: [] }] }), 'InvalidHttp'));
  test(`${name} binds query`, () => fail(check(name, request, { ...data, query_id: s.id }), 'InvalidHttp'));
}
for (const key of ['max_message_bytes', 'max_json_values', 'max_changes']) test(`snapshot negotiation ${key}`, () => {
  const [request, data] = s.examples.ReadSnapshot;
  fail(check('ReadSnapshot', { ...request, [key]: data.limits[key] - 1 }, data), 'InvalidHttp');
});
test('replay starts at requested cursor', () => fail(check('ReadChanges', { ...s.examples.ReadChanges[0], from_cursor: 'different' }, s.replay), 'InvalidHttp'));
test('empty replay stays at requested cursor', () => done(check('ReadChanges', { from_cursor: 'start' }, { messages: [], through_cursor: 'start' })));
test('assigned read ID must match', () => fail(check('GetAssignedTasks', { ...s.examples.GetAssignedTasks[0], read_id: s.id }, s.examples.GetAssignedTasks[1]), 'InvalidHttp'));
test('contact process must match', () => fail(check('BeginAssetContact', { ...s.examples.BeginAssetContact[0], process_generation: s.id }, s.examples.BeginAssetContact[1]), 'InvalidHttp'));
test('replacement response process must match', () => fail(check('ReplaceAssetProcess', { ...s.examples.ReplaceAssetProcess[0], process_generation: s.id }, s.examples.ReplaceAssetProcess[1]), 'InvalidHttp'));
for (const name of ['Request.CreateObservation', 'Request.ReportObservation']) test(`${name} binds report identity`, () => {
  const request = { ...s.examples[name.slice(8)][0], report: { ...s.observationReport, entity_id: s.id } };
  fail(bend.refine(name, json(request)), 'InvalidValue');
});
test('UpdateAsset rejects empty content', () => fail(bend.refine('Request.UpdateAsset', json({ asset_id: s.assetId, request_id: s.requestId })), 'InvalidValue'));
test('UpdateAsset authored fields require precondition', () => fail(bend.refine('Request.UpdateAsset', json({ asset_id: s.assetId, request_id: s.requestId, alias: null })), 'InvalidValue'));
test('UpdateAsset report binds asset', () => fail(bend.refine('Request.UpdateAsset', json({ ...s.examples.UpdateAsset[0], report: { ...s.report, entity_id: s.id } })), 'InvalidValue'));
test('moving page order rejects repeated identity', () => fail(bend.refine('Exchange.Page.id', json({ items: [s.asset, s.asset] })), 'InvalidValue'));
test('moving page order follows UTF8 byte order', () => done(bend.refine('Exchange.Page.kind', json({ items: [{ kind: '\ue000' }, { kind: '\u{10000}' }] }))));
test('Observation pair requires matching track', () => fail(bend.refine('Exchange.ObservationResult', json({ observation: s.observation, track: { ...s.track, id: s.id } })), 'InvalidValue'));
test('Observation pair requires matching reported sections', () => fail(bend.refine('Exchange.ObservationResult', json({ observation: s.observation, track: { ...s.track, geometry: {} } })), 'InvalidValue'));

test('request headers accept canonical authorization and context', () => done(bend.request_headers(auth())));
test('duplicate authorization is invalid', () => fail(bend.request_headers(json([{ name: 'Authorization', value: `Bearer ${'A'.repeat(43)}` }, { name: 'AUTHORIZATION', value: `Bearer ${'A'.repeat(43)}` }])), 'InvalidHttp', { path: 'header.Authorization', message: 'invalid' }));
test('missing authorization is fixed HTTP issue', () => fail(bend.request_headers(json([])), 'InvalidHttp', { path: 'header.Authorization', message: 'missing' }));
test('empty Content-Encoding is unsupported', () => fail(bend.request_headers(headers({ 'Content-Encoding': '' })), 'InvalidHttp', { path: 'header.Content-Encoding', message: 'unsupported' }));
for (const media of ['application/json', ' Application/JSON ; CHARSET = "UTF-8" ', 'application/json;charset=utf-8']) test(`media accepts ${media}`, () => assert.equal(done(bend.media(headers({ 'Content-Type': media }))), 'application/json'));
for (const media of ['application/json; charset=latin1', 'application/json;foo=bar', 'application/json; charset=utf-8; charset=utf-8', 'application/ json']) test(`media refuses ${media}`, () => fail(bend.media(headers({ 'Content-Type': media })), 'InvalidHttp', { path: 'media', message: 'invalid' }));
test('media missing has fixed issue', () => fail(bend.media(json([])), 'InvalidHttp', { path: 'media', message: 'missing' }));
for (const raw of ['01', '+1', '1.0', '2', '184467440737095516150']) test(`Content-Length refuses ${raw}`, () => fail(bend.length(headers({ 'Content-Length': raw }), 1), 'InvalidHttp', { path: 'header.Content-Length', message: 'invalid' }));
test('Content-Length exact value accepted', () => done(bend.length(headers({ 'Content-Length': '1' }), 1)));
test('content URL includes exact disposition', () => assert.deepEqual(value(done(bend.content_path(`/objects/${s.id}/content?disposition=inline`))), { object_id: s.id, disposition: 'inline' }));
for (const suffix of ['', '?disposition=inline&extra=1', '?disposition=INLINE', '?disposition=attachment\n']) test(`content URL rejects ${JSON.stringify(suffix)}`, () => fail(bend.content_path(`/objects/${s.id}/content${suffix}`), 'InvalidHttp', { path: 'path', message: 'mismatch' }));
for (const boundary of ['multipart/form-data;boundary=abc', 'MULTIPART/FORM-DATA; boundary="a b"', `multipart/form-data; boundary=${'a'.repeat(70)}`]) test(`multipart accepts ${boundary}`, () => assert.equal(bend.multipart(boundary), true));
for (const boundary of ['multipart/form-data', 'multipart/form-data; boundary=', 'multipart/form-data; boundary="abc "', 'multipart/form-data; boundary=""', `multipart/form-data; boundary=${'a'.repeat(71)}`]) test(`multipart refuses ${boundary}`, () => assert.equal(bend.multipart(boundary), false));
test('correlation accepts valid IDs and ignores duplicates', () => {
  assert.deepEqual(value(bend.correlation(headers({ 'Atlas-Request-ID': s.requestId, 'Atlas-Attempt-ID': s.id }))), { requestId: s.requestId, attemptId: s.id });
  assert.deepEqual(value(bend.correlation(json([{ name: 'Atlas-Request-ID', value: s.id }, { name: 'atlas-request-id', value: s.id }, { name: 'Atlas-Attempt-ID', value: 'bad' }]))), {});
});
test('nested Dataset contexts must match', () => assert.equal(bend.same_dataset(json({ nested: [{ dataset_id: s.assetId }] }), s.id), false));
test('consistent foreign protocol mismatch accepted', () => assert.equal(bend.error_context(json({ error: { code: 'protocol_mismatch', details: { protocol_version: 'foreign' } } }), 'foreign'), true));
test('contradictory protocol mismatch refused', () => assert.equal(bend.error_context(json({ error: { code: 'protocol_mismatch', details: { protocol_version: 'other' } } }), 'foreign'), false));
test('requested whole-message limits lower callback budget', () => assert.deepEqual(value(bend.response_lower('ReadChanges', json({ max_message_bytes: 128, max_json_values: 5, max_changes: 2 }), json({}))), { maxBytes: 128, maxValues: 5, maxDepth: 32, maxChanges: 2, maxGeometryWork: 4194304 }));
test('continuation retains caller lower budget', () => assert.deepEqual(value(bend.response_lower('ReadChanges', json({ page_token: 'next' }), json({ maxBytes: 99 }))), { maxBytes: 99 }));
test('UTF8 preserves BOM and supplementary characters', () => assert.equal(done(bend.text_bytes(list(new TextEncoder().encode('\ufeff😀')))), '\ufeff😀'));
for (const raw of [[0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x82]]) test(`UTF8 rejects ${raw}`, () => fail(bend.text_bytes(list(raw)), 'InvalidUtf8'));
for (const media of ['text/html', 'application/vnd.oai.openapi+json']) test(`reference ${media} preserves raw bytes`, () => {
  const document = media === 'text/html' ? '<!DOCTYPE html>\ufeff😀' : ' { "example": 1 }\n';
  const raw = Array.from(new TextEncoder().encode(document));
  const received = { status: 200, headers: [{ name: 'Content-Type', value: media }], body: raw };
  assert.equal(value(done(bend.reference(json(received), json({ referenceMedia: media }), raw.length))).document, document);
  fail(bend.reference(json(received), json({}), raw.length - 1), 'PayloadTooLarge');
});
test('reference JSON checks duplicate keys', () => fail(bend.reference(json({ status: 200, headers: [{ name: 'Content-Type', value: 'application/vnd.oai.openapi+json' }], body: Array.from(new TextEncoder().encode('{"a":1,"a":2}')) }), json({}), 100), 'InvalidJson'));

const frame = { type: 'progress', dataset_id: s.id, protocol_version: '0.1.0', data: { subscription_id: s.requestId, previous_cursor: 'A', through_cursor: 'B' } };
test('WSS valid context', () => done(bend.check_wss(json(frame), json({ datasetId: s.id, subscriptionId: s.requestId }), false)));
for (const context of [{ datasetId: s.assetId }, { subscriptionId: s.assetId }, { requestId: s.id }]) test(`WSS refuses context ${JSON.stringify(context)}`, () => fail(bend.check_wss(json(frame), json(context), false), 'InvalidValue'));
test('WSS current request ID required when expected', () => done(bend.check_wss(json({ ...frame, request_id: s.id }), json({ requestId: s.id }), false)));
test('WSS foreign ordinary data refused', () => fail(bend.check_wss(json({ ...frame, protocol_version: 'foreign' }), json({}), true), 'InvalidValue'));
const mismatch = { type: 'error', dataset_id: s.id, protocol_version: 'foreign', error: { code: 'protocol_mismatch', message: '', request_id: s.requestId, details: { protocol_version: 'foreign' } } };
test('WSS server reader accepts consistent foreign mismatch', () => done(bend.check_wss(json(mismatch), json({}), true)));
test('WSS writer rejects foreign mismatch', () => fail(bend.check_wss(json(mismatch), json({}), false), 'InvalidValue'));
test('WSS error details bind Dataset', () => fail(bend.check_wss(json({ ...mismatch, protocol_version: '0.1.0', error: { ...mismatch.error, code: 'dataset_mismatch', details: { dataset_id: s.assetId } } }), json({}), true), 'InvalidValue'));
test('WSS error details bind version', () => fail(bend.check_wss(json({ ...mismatch, error: { ...mismatch.error, details: { protocol_version: 'different' } } }), json({}), true), 'InvalidValue'));
test('WSS advertised limits fit external budget', () => fail(bend.check_wss_zero(json({ ...frame, data: { limits: s.limits } }), json({})), 'InvalidValue'));

console.log(`${passed} exchange/schema/transport checks passed. Full parent callback integration remains unrun.`);
