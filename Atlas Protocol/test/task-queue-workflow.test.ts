import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {Ajv2020} from 'ajv/dist/2020.js';
import {Decode, Encode, ValidateRequest, ValidateResponse, ValidateFrame, Version} from '../ts/index.js';
import type {components} from '../ts/index.js';

interface Exchange {
 name: string;
 request_schema: string | null;
 request: unknown;
 response_schema: string | null;
 response: unknown;
 status: number;
 query: string;
}
const fixtureRoot = process.env.ATLAS_FIXTURES ?? 'fixtures';
const exchangesData: unknown = JSON.parse(readFileSync(fixtureRoot + '/exchanges.json', 'utf8'));
const validate = new Ajv2020({strict: true}).compile<Exchange[]>({
 type: 'array', items: {
  type: 'object', additionalProperties: false,
  required: ['name', 'request_schema', 'request', 'response_schema', 'response', 'status', 'query'],
  properties: {
   name: {type: 'string'}, request_schema: {type: ['string', 'null']}, request: {},
   response_schema: {type: ['string', 'null']}, response: {}, status: {type: 'integer'}, query: {type: 'string'},
  },
 },
});
assert(validate(exchangesData));
const exchanges = exchangesData;
function exchange(name: string): Exchange {
 const sample = exchanges.find(item => item.name === name);
 assert(sample, `missing exchange ${name}`);
 return sample;
}
const dataset = 'A0B1C2D3-E4F5-4A67-8B90-C1D2E3F4A5B6';
const wire = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function headers() {
 return new Headers({Authorization: 'Bearer ' + 'A'.repeat(43), 'Atlas-Dataset-ID': dataset, 'Atlas-Protocol-Version': Version, 'Content-Type': 'application/json'});
}
function response(value: unknown, status = 200) {
 return {status, headers: headers(), body: new Response(JSON.stringify(value)).body};
}
async function checkedResponse(name: string, value: unknown, status = 200) {
 const checked = await ValidateResponse(name, response(value, status), {datasetID: dataset});
 assert(checked);
 return checked;
}
async function checkedRequest(name: string, path: string, body?: Uint8Array) {
 return ValidateRequest(name, new Request('https://atlas.invalid' + path, {
  method: body ? 'POST' : 'GET', headers: headers(), ...(body ? {body: Buffer.from(body)} : {}),
 }), dataset);
}
const taskA = '00000000-0000-0000-0000-00000000000a';
const taskB = '00000000-0000-0000-0000-00000000000b';
const coreRun = '00000000-0000-0000-0000-000000000002';

test('Asset and assigned-work HTTP responses require complete queue projections', async t => {
 const asset = Decode('GetAssetResponse', wire(exchange('GetAsset').response)).data;
 const page = Decode('GetAssignedTasksResponse', wire(exchange('GetAssignedTasks').response)).data;
 const queue = {asset_id: dataset, revision: '4', task_ids: [], confirmed_revision: null};
 for (const operation of ['GetAsset', 'GetAssignedTasks']) {
  for (const variant of ['complete', 'missing queue', 'missing confirmation', 'duplicate IDs', 'case duplicate IDs']) {
   await t.test(`${operation} ${variant}`, async () => {
    const data: Record<string, unknown> = {...(operation === 'GetAsset' ? asset : page), task_queue: queue};
    if (operation === 'GetAssignedTasks') data.items = [];
    delete data.queue_revision;
    if (variant === 'missing queue') delete data.task_queue;
    if (variant === 'missing confirmation') data.task_queue = {asset_id: dataset, revision: '4', task_ids: []};
    if (variant === 'duplicate IDs') data.task_queue = {...queue, task_ids: [dataset, dataset]};
    if (variant === 'case duplicate IDs') data.task_queue = {...queue, task_ids: [dataset, dataset.toLowerCase()]};
    const validation = ValidateResponse(operation, response({dataset_id: dataset, data}), {datasetID: dataset});
    if (variant === 'complete') await validation;
    else await assert.rejects(validation);
   });
  }
 }
});

test('a fresh assigned-work reader recovers and confirms an edited order across pages', async () => {
 {
  for (const {id, sequence} of [{id: taskA, sequence: '1'}, {id: taskB, sequence: '2'}]) {
   const sample = exchange('CreateTask');
   const create = {...Decode('CreateTaskRequest', wire(sample.request)), request_id: id, task_id: id};
   const checked = await checkedRequest('CreateTask', '/tasks', Encode('CreateTaskRequest', create));
   assert(checked.json);
   assert.equal(Decode('CreateTaskRequest', checked.json).task_id, id);
   const created = Decode('CreateTaskResponse', wire(sample.response));
   created.data.id = id;
   created.data.submission_sequence = sequence;
   const reply = Decode('CreateTaskResponse', await checkedResponse('CreateTask', created, sample.status));
   assert.equal(reply.data.id, id);
   assert.equal(reply.data.submission_sequence, sequence);
  }
  const order = {request_id: '00000000-0000-0000-0000-000000000004', asset_id: dataset, expected_queue_revision: '3', task_ids: [taskB, taskA]};
  await checkedRequest('SetTaskOrder', `/assets/${dataset}/tasks/order`, Encode('SetTaskOrderRequest', order));
  await ValidateResponse('SetTaskOrder', response({dataset_id: dataset, data: {asset_id: dataset, revision: '4', task_ids: [taskB, taskA], confirmed_revision: null}, commit_cursor: 'queue-reordered'}), {datasetID: dataset});
 }

 const bodies = new Map<string, components['schemas']['Task']>();
 const bodyOrder: string[] = [];
 let recovered: components['schemas']['TaskQueue'] | undefined;
 for (const {id, sequence, token} of [{id: taskA, sequence: '1', token: 'after-A'}, {id: taskB, sequence: '2', token: ''}]) {
  const sample = exchange('GetAssignedTasks');
  const base = Decode('GetAssignedTasksResponse', wire(sample.response));
  const task = base.data.items[0];
  assert(task);
  const page = {
   dataset_id: dataset,
   data: {
    items: [{...task, id, submission_sequence: sequence}],
    task_queue: {asset_id: dataset, revision: '4', task_ids: [taskB, taskA], confirmed_revision: null},
    ...(token ? {next_page_token: token} : {}),
   },
  } satisfies components['schemas']['GetAssignedTasksResponse'];
  const queryText = token ? 'page_size=1' : 'page_size=1&queue_revision=4&page_token=after-A';
  const checked = await checkedRequest('GetAssignedTasks', `/assets/${dataset}/tasks?${queryText}`);
  const query = Decode('AssignedTaskQuery', checked.query);
  assert.equal(query.page_size, 1);
  if (!token) {
   assert.equal(query.queue_revision, '4');
   assert.equal(query.page_token, 'after-A');
  }
  const reply = Decode('GetAssignedTasksResponse', await checkedResponse('GetAssignedTasks', page));
  assert.equal(reply.data.items.length, 1);
  assert.equal(reply.data.task_queue.asset_id, dataset);
  assert.equal(reply.data.task_queue.revision, '4');
  assert.equal(reply.data.task_queue.confirmed_revision, null);
  assert.deepEqual(reply.data.task_queue.task_ids, [taskB, taskA]);
  assert.equal(reply.data.next_page_token, token || undefined);
  if (recovered) assert.deepEqual(reply.data.task_queue, recovered);
  else recovered = reply.data.task_queue;
  const body = reply.data.items[0];
  assert(body);
  bodies.set(body.id, body);
  bodyOrder.push(body.id);
 }
 assert(recovered);
 assert.deepEqual(bodyOrder, [taskA, taskB]);
 const execution = recovered.task_ids.map(id => {
  const body = bodies.get(id);
  assert(body, `requested Task ${id} missing from pages`);
  return body;
 });
 assert.deepEqual(execution.map(task => task.id), [taskB, taskA]);
 assert.deepEqual(execution.map(task => task.submission_sequence), ['2', '1']);
 const base = Decode('ConfirmTaskOrderRequest', wire(exchange('ConfirmTaskOrder').request));
 const confirmation = {
  ...base, source: {...base.source, asset_id: recovered.asset_id},
  queue_revision: recovered.revision, task_ids: recovered.task_ids,
 };
 const checked = await checkedRequest('ConfirmTaskOrder', `/assets/${recovered.asset_id}/tasks/order-confirmation`, Encode('ConfirmTaskOrderRequest', confirmation));
 assert(checked.json);
 const submitted = Decode('ConfirmTaskOrderRequest', checked.json);
 assert.equal(submitted.source.asset_id, dataset);
 assert.equal(submitted.queue_revision, '4');
 assert.deepEqual(submitted.task_ids, [taskB, taskA]);
});

test('empty assigned-work pages retain their complete empty queue', async () => {
 const page = {dataset_id: dataset, data: {items: [], task_queue: {asset_id: dataset, revision: '7', task_ids: [], confirmed_revision: null}}};
 const decoded = Decode('GetAssignedTasksResponse', await checkedResponse('GetAssignedTasks', page));
 assert.deepEqual(decoded.data.items, []);
 assert.deepEqual(decoded.data.task_queue, {asset_id: dataset, revision: '7', task_ids: [], confirmed_revision: null});
 const legacy = {dataset_id: dataset, data: {items: [], queue_revision: '7'}};
 await assert.rejects(checkedResponse('GetAssignedTasks', legacy));
 await assert.rejects(checkedResponse('GetAssignedTasks', {...page, data: {...page.data, queue_revision: '7'}}));
});

test('snapshots recover queues and change frames carry adoption-only Asset updates', async () => {
 const base = Decode('GetAssetResponse', wire(exchange('GetAsset').response)).data;
 const asset = {
  ...base, version: '4',
  task_queue: {asset_id: dataset, revision: '4', task_ids: [taskB, taskA], confirmed_revision: null},
 } satisfies components['schemas']['Asset'];
 const snapshot = Decode('ReadSnapshotResponse', wire(exchange('ReadSnapshot').response));
 snapshot.data.items = [asset];
 const loaded = Decode('ReadSnapshotResponse', await checkedResponse('ReadSnapshot', snapshot));
 assert.equal(loaded.data.items.length, 1);
 const before = loaded.data.items[0];
 assert(before && 'entity_type' in before && before.entity_type === 'asset');
 assert.equal(before.id, dataset);
 assert.equal(before.version, '4');
 assert.equal(before.task_queue.revision, '4');
 assert.equal(before.task_queue.confirmed_revision, null);
 assert.deepEqual(before.task_queue.task_ids, [taskB, taskA]);

 const frame = {
  type: 'changes', dataset_id: dataset, protocol_version: Version, core_run_id: coreRun,
  batch: {cursor: 'queue-adopted', changes: [{kind: 'upsert', resource: {...asset, version: '5', task_queue: {...asset.task_queue, confirmed_revision: '4'}}}]},
 } satisfies components['schemas']['ChangesFrame'];
 const encoded = Encode('ChangesFrame', frame);
 ValidateFrame('server', encoded, {datasetID: dataset, coreRunID: coreRun, authenticated: true, subscribed: true});
 const committed = Decode('ChangesFrame', encoded);
 assert.equal(committed.batch.cursor, 'queue-adopted');
 assert.equal(committed.batch.changes.length, 1);
 const change = committed.batch.changes[0];
 assert(change?.kind === 'upsert');
 const after = change.resource;
 assert('entity_type' in after && after.entity_type === 'asset');
 assert.equal(after.id, dataset);
 assert.equal(after.version, '5');
 assert.equal(after.task_queue.revision, '4');
 assert.equal(after.task_queue.confirmed_revision, '4');
 assert.deepEqual(after.task_queue.task_ids, [taskB, taskA]);
});

test('assigned-work queue_changed is a declared 409 refusal', async () => {
 const refusal = {dataset_id: dataset, error: {code: 'queue_changed', message: 'Read the requested queue again', request_id: coreRun}};
 const checked = await checkedResponse('GetAssignedTasks', refusal, 409);
 assert.equal(Decode('Error409', checked).error.code, 'queue_changed');
 await assert.rejects(ValidateResponse('GetAssignedTasks', response(refusal, 400), {datasetID: dataset}));
});
