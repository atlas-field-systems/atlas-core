import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {Decode, ValidateFrame, ValidateRequest} from '../ts/index.js';
import type {components} from '../ts/index.js';

type Ring = components['schemas']['Coordinate'][];
const dataset = 'A0B1C2D3-E4F5-4A67-8B90-C1D2E3F4A5B6', coreRun = '00000000-0000-0000-0000-000000000002';
const wire = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function maximumRing(): Ring {
 const ring: Ring = [];
 for (let i = 0; i < 512; i++) ring.push([i / 4, 0]);
 for (let i = 510; i >= 0; i--) ring.push([i / 4, 1]);
 ring.push([0, 0]);
 assert.equal(ring.length, 1024);
 return ring;
}
function sawtooth(rotated = false, tiny = false): Ring {
 const ring: Ring = [];
 for (let k = 0; k < 255; k++) {
  const b = 2 * k;
  ring.push([b, 0], [b + 1, 0], [b + 201, 1], [b + 202, 1]);
 }
 ring.push([510, 0], [510, -1], [0, -1], [0, 0]);
 const scaled = ring.reverse().map(([x, y]): components['schemas']['Coordinate'] => rotated ? [(x - y) / 8, (x + y) / 8] : [x / 8, y / 8]);
 if (tiny) scaled[1] = [Number.MIN_VALUE, -0.125];
 return scaled;
}
function serpentine(tiny = false): Ring {
 const ring: Ring = [], d = 2 ** -46;
 for (let k = 0; k < 510; k += 2) ring.push([0, k * d], [64, 64 + k * d], [64, 64 + (k + 1) * d], [0, (k + 1) * d]);
 ring.push([0, 1], [-1, 1], [-1, tiny ? Number.MIN_VALUE : 0], [0, 0]);
 return ring;
}
function boundaries(coordinates: Ring[]) {
 const geometry = {type: 'Polygon', coordinates};
 const root = wire(geometry);
 const description = {name: 'Area'}, type = {kind: 'search_area'} as const;
 const request = JSON.stringify({request_id: coreRun, geofeature_id: dataset, description, type, geometry});
 const frame = wire({type: 'changes', dataset_id: dataset, core_run_id: coreRun, protocol_version: '0.1.0', batch: {
  cursor: 'cursor-H', changes: [dataset, coreRun].map(id => ({kind: 'upsert', resource: {
   id, version: '1', edit_revision: '1', alias: null, entity_type: 'geofeature', geometry_revision: '1', description, type, geometry,
  }})),
 }});
 return [
  {name: 'PolygonGeometry', check: () => assert.deepEqual(Decode('PolygonGeometry', root), geometry)},
  {name: 'Geometry', check: () => assert.deepEqual(Decode('Geometry', root), geometry)},
  {name: 'ValidateRequest', check: () => ValidateRequest('CreateGeofeature', new Request('https://atlas.invalid/geofeatures', {
   method: 'POST', headers: {'Authorization': 'Bearer ' + 'A'.repeat(43), 'Atlas-Dataset-ID': dataset, 'Atlas-Protocol-Version': '0.1.0', 'Content-Type': 'application/json'}, body: request,
  }), dataset)},
  {name: 'ValidateFrame', check: () => ValidateFrame('server', frame, {datasetID: dataset, coreRunID: coreRun, authenticated: true, subscribed: true})},
 ];
}

if (process.argv.includes('--geometry-workload')) {
 Decode('Position', wire({latitude: 0, longitude: 0}));
 const checks = boundaries([maximumRing()]);
 const start = performance.now(), cpuStart = process.cpuUsage();
 let accepted = 0;
 for (let repeat = 0; repeat < 6; repeat++) for (const boundary of checks) {
  await boundary.check();
  accepted++;
 }
 for (const ring of [sawtooth(), sawtooth(true), sawtooth(false, true), serpentine(), serpentine(true)]) {
  assert.equal(ring.length, 1024);
  for (const boundary of boundaries([ring])) { await boundary.check(); accepted++; }
 }
 assert.equal(accepted, 44);
 console.log(JSON.stringify({accepted, vertices: 1024, elapsedMS: performance.now() - start, cpu: process.cpuUsage(cpuStart)}));
} else {
 test('maximum collinear-rich polygons finish through synchronous and HTTP boundaries', () => {
  // A separate process can interrupt synchronous geometry work that blocks the test event loop.
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--geometry-workload'], {encoding: 'utf8', timeout: 30_000});
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /"accepted":44/);
 });

 test('geometry boundaries retain exact topology and refusal categories', async t => {
  const ring = maximumRing(), tooMany: Ring = [[0, 0], [0.125, 0], ...ring.slice(1)];
  const touch = serpentine(); touch[3] = [0, 0];
  const cases: {name: string; rings: Ring[]; code?: string}[] = [
   {name: 'exact thin triangle', rings: [[[0, 0], [1, 1], [2, 2.0000000000000004], [0, 0]]]},
   {name: 'subnormal triangle', rings: [[[0, 0], [Number.MIN_VALUE, 0], [0, Number.MIN_VALUE], [0, 0]]]},
   {name: 'crossing', rings: [[[0, 0], [4, 4], [0, 4], [3, 0], [0, 0]]], code: 'invalid_geometry'},
   {name: 'touch', rings: [[[0, 0], [4, 0], [4, 4], [2, 0], [0, 4], [0, 0]]], code: 'invalid_geometry'},
   {name: 'serpentine touch', rings: [touch], code: 'invalid_geometry'},
   {name: 'overlap', rings: [[[0, 0], [4, 0], [2, 0], [4, 4], [0, 4], [0, 0]]], code: 'invalid_geometry'},
   {name: 'clockwise', rings: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]], code: 'invalid_geometry'},
   {name: '1025 entries', rings: [tooMany], code: 'geometry_limit_exceeded'},
   {name: 'holes', rings: [ring, ring], code: 'unsupported_geometry'},
  ];
  for (const sample of cases) for (const boundary of boundaries(sample.rings)) await t.test(sample.name + '/' + boundary.name, async () => {
   if (sample.code) await assert.rejects(async () => boundary.check(), new RegExp('^Error: ' + sample.code + '$'));
   else await boundary.check();
  });
 });
}
