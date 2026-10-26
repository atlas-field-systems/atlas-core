import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, registration } from './helpers.mjs';
import { uuid } from './helpers.mjs';
import { writeFile, rm, readdir, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Diagnostics, faultFrames } from '../dist/diagnostics.js';
import { setTimeout as delay } from 'node:timers/promises';
const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.data; };
test('queried-back embedded engine durability, bounded IPC admission and explicit worker loss', async t => {
  const f = await fixture(t);
  const engine = await f.core.rpc.call('inspect', {}, 0, true);
  assert.equal(engine.version, '3.53.4'); assert.equal(engine.journal, 'wal'); assert.equal(engine.synchronous, 2);
  const request = registration(); ok(await f.call('RegisterAsset', request));
  await f.core.rpc.call('tick', {}, 0, true);
  const checkpoint = (await f.core.rpc.call('inspect', {}, 0, true)).metrics;
  assert.ok(checkpoint.checkpoints > 0); assert.ok(checkpoint.wal_bytes > 0);
  assert.ok(checkpoint.wal_frames >= checkpoint.checkpointed_frames); assert.equal(checkpoint.checkpoint_busy, 0);
  await assert.rejects(f.core.rpc.exchange('GetAsset', { asset_id: request.asset_id }, { verifier: '0'.repeat(64) }, f.settings.workerQueueBytes + 1), error => error.code === 'resource_limit');
  assert.equal(ok(await f.call('GetAsset', { asset_id: request.asset_id })).id, request.asset_id);
  await f.core.rpc.worker.terminate();
  const health = await f.call('GetHealth'); assert.equal(health.status, 503); assert.equal(health.bytes.length, 0);
  await f.restart();
  assert.equal(ok(await f.call('GetAsset', { asset_id: request.asset_id })).id, request.asset_id);
});
test('real aggregate pressure refuses ordinary growth and preserves reserved cancellation and reads', async t => {
  const f = await fixture(t, { storageBytes: 32 * 1024 * 1024, objectBytes: 16 * 1024 * 1024, reserveBytes: 1024 * 1024 });
  const a = ok(await f.call('RegisterAsset', registration())).asset;
  const task = ok(await f.call('CreateTask', { request_id: uuid(), task_id: uuid(), asset_id: a.id, command: 'pause', scheduling: 'immediate', inputs: {} }));
  await writeFile(join(f.directory, 'pressure.bin'), Buffer.alloc(29 * 1024 * 1024));
  assert.equal((await f.call('RegisterAsset', registration())).json.error.code, 'storage_limit');
  assert.equal(ok(await f.call('RequestTaskCancellation', { task_id: task.task_id, request_id: uuid() })).execution_state, 'pending');
  assert.equal(ok(await f.call('GetReadiness')).ready, true);
  await rm(join(f.directory, 'pressure.bin'));
  ok(await f.call('RegisterAsset', registration()));
});
test('draining readiness is an authenticated 503 success and ordinary work stops', async t => {
  const f = await fixture(t);
  await f.core.rpc.call('drain', {}, 0, true);
  const response = await f.call('GetReadiness'); assert.equal(response.status, 503); assert.deepEqual(response.json.data, { ready: false });
  assert.equal((await f.call('GetHealth')).json.data.healthy, false);
  assert.equal((await f.call('RegisterAsset', registration())).json.error.code, 'resource_limit');
});
test('diagnostic floods rotate within budget, expose loss and isolate a failed sink from requests', async t => {
  const f = await fixture(t);
  const directory = join(f.directory, 'bounded-diagnostics');
  const diagnostic = new Diagnostics(directory, 65_536, 'DEBUG');
  const sentinel = 'secret-and-private-payload.bin';
  for (let i = 0; i < 10_000; i++) diagnostic.emit({ severity: 'WARN', component: 'runtime', event: 'pressure_test', count: i });
  diagnostic.emit({ severity: 'ERROR', component: 'runtime', event: 'safe_fault', ...faultFrames(new Error(sentinel)) });
  assert.ok(diagnostic.inspect().queuedBytes <= 1_048_576);
  assert.ok(diagnostic.inspect().dropped > 0);
  await diagnostic.close();
  let bytes = 0;
  const files = await readdir(directory); assert.ok(files.length <= 8);
  for (const name of files) {
    bytes += (await stat(join(directory, name))).size;
    const lines = await readFile(join(directory, name), 'utf8'); assert.ok(!lines.includes(sentinel));
    for (const line of lines.trim().split('\n')) assert.ok(JSON.parse(line).event);
  }
  assert.ok(bytes <= 32_768);
  await f.core.close();
  const blocked = join(f.directory, 'logs'); await rm(blocked, { recursive: true }); await writeFile(blocked, 'regular file');
  await f.restart();
  assert.equal(ok(await f.call('GetHealth')).healthy, true);
  for (let i = 0; f.core.diagnostics.inspect().sinkFailures === 0 && i < 100; i++) await delay(10);
  assert.ok(f.core.diagnostics.inspect().sinkFailures > 0);
  assert.equal(ok(await f.call('GetHealth')).healthy, true);
});
