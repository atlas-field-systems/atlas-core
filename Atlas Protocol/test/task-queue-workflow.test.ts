import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {Ajv2020} from 'ajv/dist/2020.js';
import {Decode, ValidateResponse, Version} from '../ts/index.js';

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
