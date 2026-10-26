import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, registration, report, telemetry, root, secret } from './helpers.mjs';
import { uuid } from './helpers.mjs';
import { writeFile, rm, readdir, stat, readFile, mkdtemp } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { defaults } from '../dist/settings.js';
import { join } from 'node:path';
import { Diagnostics, faultFrames } from '../dist/diagnostics.js';
import { setTimeout as delay } from 'node:timers/promises';
import { storageUsage } from '../dist/server.js';
import { digest } from '../dist/exact.js';
const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.data; };
test('worker commits through a parent stall and bounds unacknowledged pages with required headroom', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(root, 'artifacts', 'reply-permits-'));
  const settings = { ...defaults, freeDiskBytes: 0, workerQueueCount: 40, workerQueueBytes: 1_048_576,
    resourceImageBytes: 65536, limits: { ...defaults.limits, max_message_bytes: 212992 } };
  const worker = new Worker(new URL('../dist/worker.js', import.meta.url), { workerData: { directory, accountingRoot: directory, settings }, stdout: true, stderr: true });
  worker.stdout.resume(); worker.stderr.resume();
  t.after(async () => { await worker.terminate(); await rm(directory, { recursive: true, force: true }); });
  let ready;
  const started = new Promise((resolve, reject) => { ready = resolve; worker.once('error', reject); });
  const pending = new Map(), received = [];
  worker.on('message', message => {
    if (message.type === 'ready') { ready(message); return; }
    received.push(message);
    const resolve = pending.get(message.id); assert.ok(resolve, 'Every response has a waiting caller');
    pending.delete(message.id); resolve(message);
  });
  let serial = 0;
  function send(kind, data, reserved = false) {
    const id = ++serial;
    const response = new Promise(resolve => pending.set(id, resolve));
    worker.postMessage({ id, kind, data, reserved, enqueuedAtNs: process.hrtime.bigint() });
    return { id, response };
  }
  const ack = message => worker.postMessage({ type: 'received', id: message.id });
  const state = await started, credential = secret(), apiKey = uuid();
  ack(await send('provision', { request_id: uuid(), api_key_id: apiKey, secret: credential }, true).response);
  const administrator = secret();
  ack(await send('provision', { request_id: uuid(), api_key_id: uuid(), secret: administrator }, true).response);
  const context = { verifier: digest(credential), dataset: state.dataset, protocol: '0.1.0' };
  const exchange = (name, request, reserved = false) => send('exchange', { operation: { name, request }, context }, reserved);
  const writes = Array.from({ length: 32 }, () => exchange('CreateGeofeature', { request_id: uuid(), geofeature_id: uuid(),
    geometry: { type: 'Point', coordinates: [0, 0] }, description: { name: 'Retained', description: 'x'.repeat(4096) } }));
  const db = new Database(join(directory, 'core.sqlite'), { readonly: true });
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let committed = 0;
  try {
    const deadline = Date.now() + 5000;
    while (committed < writes.length && Date.now() < deadline) {
      Atomics.wait(pause, 0, 0, 20);
      committed = db.prepare('SELECT count(*) AS count FROM entity_geofeatures').get().count;
    }
  } finally { db.close(); }
  assert.equal(committed, writes.length, 'All admitted writes commit while the parent processes no replies or acknowledgments');
  for (const reply of await Promise.all(writes.map(write => write.response))) { assert.equal(reply.type, 'reply', JSON.stringify(reply)); ack(reply); }
  const pages = Array.from({ length: 12 }, () => exchange('ListGeofeatures', { page_size: 100 }));
  await pages[0].response;
  await delay(100);
  const held = received.filter(reply => pages.some(page => page.id === reply.id));
  assert.ok(held.length > 1 && held.length < pages.length, 'Several complete pages fit, and excess pages wait for acknowledgment');
  assert.ok(held.reduce((bytes, reply) => bytes + Buffer.byteLength(JSON.stringify(reply)), 0) <= settings.limits.max_message_bytes * 3,
    'Unacknowledged ordinary replies stay within the three-page byte allowance');
  const health = await exchange('GetHealth', {}, true).response;
  assert.equal(health.type, 'reply'); assert.equal(health.value.response.body.data.healthy, true); ack(health);
  for (const page of pages) {
    const reply = await page.response; assert.equal(reply.type, 'reply', JSON.stringify(reply));
    assert.equal(reply.value.response.body.data.items.length, writes.length); ack(reply);
  }
  const tiny = Array.from({ length: 36 }, () => send('authorize', { context, discovery: false }));
  const heldTiny = await Promise.all(tiny.map(call => call.response));
  for (const reply of heldTiny) assert.equal(reply.type, 'reply');
  const blocked = exchange('CreateGeofeature', { request_id: uuid(), geofeature_id: uuid(), geometry: { type: 'Point', coordinates: [0, 0] } });
  const required = await send('exchange', { operation: { name: 'RevokeApiKey', request: { request_id: uuid(), api_key_id: apiKey } },
    context: { ...context, verifier: digest(administrator) } }, true).response;
  assert.equal(required.type, 'reply');
  assert.equal(received.some(reply => reply.id === blocked.id), false, 'Ordinary reply count saturation preserves required admission');
  for (const reply of heldTiny) ack(reply);
  ack(required);
  const revoked = await blocked.response;
  assert.equal(revoked.type, 'refusal'); assert.equal(revoked.error.body.error.code, 'unauthorized', 'Authority is rechecked after a response-permit wait'); ack(revoked);
});
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
  const usage = await storageUsage(f.directory);
  await writeFile(join(f.directory, 'pressure.bin'), Buffer.alloc(f.settings.storageBytes - f.settings.reserveBytes - usage.bytes - 32768));
  assert.equal((await f.call('RegisterAsset', registration())).json.error.code, 'storage_limit');
  assert.equal(ok(await f.call('RequestTaskCancellation', { task_id: task.task_id, request_id: uuid() })).execution_state, 'pending');
  assert.equal(ok(await f.call('GetReadiness')).ready, true);
  await rm(join(f.directory, 'pressure.bin'));
  ok(await f.call('RegisterAsset', registration()));
});
test('all Task evidence preserves ordinary headroom, exact retries bypass new admission, and terminal writes obey the ceiling', async t => {
  const f = await fixture(t, { storageBytes: 16 * 1024 * 1024, objectBytes: 4 * 1024 * 1024, reserveBytes: 2 * 1024 * 1024 });
  const request = registration(); const registered = await f.call('RegisterAsset', request); const asset = ok(registered).asset;
  const taskRequest = { request_id: uuid(), task_id: uuid(), asset_id: asset.id, command: 'pause', scheduling: 'immediate', inputs: {} };
  const taskResponse = await f.call('CreateTask', taskRequest); const task = ok(taskResponse);
  const origin = { kind: 'asset_process', process_generation: asset.process_generation };
  const evidence = (sequence, payload) => ({ dataset_id: f.core.dataset, asset_id: asset.id, origin, report_id: uuid(), sequence: String(sequence), generated_at: null, payload });
  const progress = { evidence: evidence(1, { task_id: task.task_id, event: 'state', state: 'acknowledged' }) };
  ok(await f.call('ReportTaskExecution', progress));
  const results = { evidence: evidence(1, { task_id: task.task_id, declarations: [{ object_id: uuid(), required: true }] }) };
  ok(await f.call('ReportTaskResults', results));
  const adoption = { evidence: evidence(1, { queue_revision: '0' }) }; ok(await f.call('ConfirmTaskOrder', adoption));
  const assigned = { asset_id: asset.id, process_generation: asset.process_generation, read_id: uuid() }; const instructions = ok(await f.call('GetAssignedTasks', assigned));
  const publisher = uuid(), observation = uuid(), publisherOrigin = { kind: 'publisher', publisher_id: publisher };
  ok(await f.call('CreateObservation', { request_id: uuid(), observation_id: observation, publisher_id: publisher }));
  const observationReport = { observation_id: observation, publisher_id: publisher, report: report(f.core.dataset, observation, publisherOrigin, 1, { telemetry: telemetry(publisherOrigin, 1) }) };
  ok(await f.call('ReportObservation', observationReport));
  const pressure = join(f.directory, 'pressure.bin');
  async function fill(required) {
    await rm(pressure, { force: true });
    const usage = await storageUsage(f.directory);
    await writeFile(pressure, Buffer.alloc(f.settings.storageBytes - (required ? 0 : f.settings.reserveBytes) - usage.bytes - 32768));
  }
  await fill(false);
  const replay = await f.call('RegisterAsset', request); assert.equal(ok(replay).asset.id, asset.id); assert.equal(replay.json.commit_cursor, registered.json.commit_cursor);
  assert.equal((await f.call('RegisterAsset', { ...request, alias: 'different' })).json.error.code, 'identity_conflict');
  assert.equal(ok(await f.call('CreateTask', taskRequest)).task_id, task.task_id);
  assert.equal(ok(await f.call('ReportTaskExecution', progress)).evidence_disposition, 'duplicate');
  assert.equal(ok(await f.call('ReportTaskResults', results)).evidence_disposition, 'duplicate');
  assert.equal(ok(await f.call('ConfirmTaskOrder', adoption)).evidence_disposition, 'duplicate');
  assert.deepEqual(ok(await f.call('GetAssignedTasks', assigned)), instructions);
  assert.equal(ok(await f.call('ReportObservation', observationReport)).evidence_disposition, 'duplicate');
  assert.equal((await f.call('ReportTaskExecution', { evidence: evidence(2, { task_id: task.task_id, event: 'state', state: 'in_progress' }) })).json.error.code, 'storage_limit');
  assert.equal((await f.call('ReportTaskResults', { evidence: evidence(2, { task_id: task.task_id, declarations: [{ object_id: uuid(), required: false }] }) })).json.error.code, 'storage_limit');
  assert.equal((await f.call('ConfirmTaskOrder', { evidence: evidence(2, { queue_revision: '0' }) })).json.error.code, 'storage_limit');
  assert.equal((await f.call('GetAssignedTasks', { ...assigned, read_id: uuid() })).json.error.code, 'storage_limit');
  const terminal = { evidence: evidence(2, { task_id: task.task_id, event: 'state', state: 'failed', reason: 'cannot_execute' }) };
  assert.equal(ok(await f.call('ReportTaskExecution', terminal)).task.execution_state, 'failed');
  await fill(true);
  assert.equal((await f.call('ReportTaskExecution', { evidence: evidence(3, terminal.evidence.payload) })).json.error.code, 'storage_limit');
  assert.equal(ok(await f.call('ReportTaskExecution', terminal)).evidence_disposition, 'duplicate');
  await rm(pressure);
  assert.equal((await f.call('ReportTaskExecution', { evidence: evidence(3, terminal.evidence.payload) })).status, 200);
});
test('tiny HTTP requests coexist and required exchanges fit the reserved IPC capacity', async t => {
  const f = await fixture(t);
  const asset = ok(await f.call('RegisterAsset', registration())).asset;
  const task = ok(await f.call('CreateTask', { request_id: uuid(), task_id: uuid(), asset_id: asset.id, command: 'pause', scheduling: 'immediate', inputs: {} }));
  const reads = await Promise.all(Array.from({ length: 32 }, () => f.call('ListAssets', {})));
  for (const response of reads) assert.equal(ok(response).items[0].id, asset.id);
  const context = { verifier: digest(f.apiKey), dataset: f.core.dataset, protocol: '0.1.0' };
  const pending = [];
  for (let i = 0; i < 15; i++) pending.push(f.core.rpc.exchange('ListAssets', {}, context, 1_048_576).catch(error => error));
  const outcome = f.core.rpc.exchange('RequestTaskCancellation', { task_id: task.task_id, request_id: uuid() }, context, 4096);
  const terminal = f.core.rpc.exchange('ReportTaskExecution', { evidence: { dataset_id: f.core.dataset, asset_id: asset.id,
    origin: { kind: 'asset_process', process_generation: asset.process_generation }, report_id: uuid(), sequence: '1', generated_at: null,
    payload: { task_id: task.task_id, event: 'state', state: 'failed', reason: 'cannot_execute' } } }, context, 8192);
  for (const response of await Promise.all([outcome, terminal])) assert.equal(response.kind, 'success');
  await Promise.all(pending);
  await f.core.close();
  assert.equal(f.core.rpc.usage.operations, 0); assert.equal(f.core.rpc.usage.bytes, 0);
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
