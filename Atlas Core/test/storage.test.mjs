import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, registration, report, telemetry, root, secret } from './helpers.mjs';
import { uuid } from './helpers.mjs';
import { writeFile, rm, readdir, stat, statfs, readFile, mkdtemp, mkdir } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { defaults } from '../dist/settings.js';
import { join } from 'node:path';
import { Diagnostics, faultFrames } from '../dist/diagnostics.js';
import { setTimeout as delay } from 'node:timers/promises';
import { storageUsage } from '../dist/server.js';
import { digest } from '../dist/exact.js';
import { currentWriter } from '../dist/ownership.js';
import { DatabaseWorker } from '../dist/rpc.js';
import { diskUsage } from '../dist/capacity.js';
import { Store } from '../dist/database.js';
import { Engine } from '../dist/engine.js';
import { exchanges, PROTOCOL_VERSION } from '@atlas/protocol';
const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.data; };
test('assigned retries stay read-only at the ceiling and new reads admit bounded cleanup', async t => {
  await mkdir(join(root, 'artifacts'), { recursive: true });
  const directory = await mkdtemp(join(root, 'artifacts', 'assigned-cleanup-'));
  const settings = { ...defaults, freeDiskBytes: 0, storageBytes: 64 * 1024 * 1024, objectBytes: 16 * 1024 * 1024, reserveBytes: 1024 * 1024 };
  const engine = new Engine(directory, settings);
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  const key = secret(); engine.provision({ api_key_id: uuid(), request_id: uuid(), secret: key });
  const context = { verifier: digest(key), dataset: engine.store.dataset, protocol: PROTOCOL_VERSION };
  const call = async (name, request) => (await engine.execute({ name, request: exchanges[name].request.schema.parse(request) }, context)).body;
  const { data: { asset } } = await call('RegisterAsset', registration());
  for (let i = 0; i < 100; i++) await call('CreateTask', { task_id: uuid(), request_id: uuid(), asset_id: asset.id, command: 'move_to', scheduling: 'queued', inputs: { target: { kind: 'position', position: { latitude: 0, longitude: 0 } } } });
  const request = { asset_id: asset.id, process_generation: asset.process_generation, read_id: uuid(), page_size: 1 };
  for (let i = 0; i < 200; i++) await call('GetAssignedTasks', { ...request, read_id: uuid() });
  const live = await call('GetAssignedTasks', request);
  assert.ok(live.data.next_page_token);
  // Set up expired persisted contexts without extending the existing real-expiry workflow.
  engine.store.db.prepare('UPDATE task_instruction_lifetime SET deadline=0 WHERE read_id<>?').run(request.read_id);
  engine.store.db.pragma('wal_checkpoint(TRUNCATE)');
  const pressure = join(directory, 'pressure.bin');
  await writeFile(pressure, Buffer.alloc(settings.storageBytes - diskUsage(directory).bytes - 4096));
  const before = diskUsage(directory).bytes, cursor = engine.store.cursor();
  assert.deepEqual(await call('GetAssignedTasks', request), live);
  await call('GetAssignedTasks', { page_token: live.data.next_page_token });
  assert.equal(diskUsage(directory).bytes, before);
  assert.equal(engine.store.db.prepare('SELECT count(*) AS count FROM task_instructions').get().count, 201);
  await assert.rejects(call('GetAssignedTasks', { ...request, read_id: uuid() }), error => error.code === 'storage_limit');
  assert.equal(engine.store.db.prepare('SELECT count(*) AS count FROM task_instructions').get().count, 201);
  assert.ok(diskUsage(directory).bytes <= settings.storageBytes);
  await rm(pressure);
  await call('GetAssignedTasks', { ...request, read_id: uuid() });
  const remaining = engine.store.db.prepare('SELECT count(*) AS count FROM task_instruction_lifetime WHERE deadline=0').get().count;
  assert.ok(remaining > 0 && remaining < 200, 'An admitted read reclaims a bounded part of the backlog');
  for (let i = 0; i < 20; i++) await call('GetAssignedTasks', { ...request, read_id: uuid() });
  assert.equal(engine.store.db.prepare('SELECT count(*) AS count FROM task_instruction_lifetime WHERE deadline=0').get().count, 0);
  assert.equal(engine.store.cursor(), cursor);
});
test('replay bytes and whole-commit boundaries survive rollback, restart and Reset', async t => {
  const directory = await mkdtemp(join(root, 'artifacts', 'replay-accounting-'));
  const path = join(directory, 'core.sqlite'), settings = { ...defaults };
  let store = new Store(path, settings);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const baseline = store.cursor();
  const changes = [uuid(), uuid()].map(resource_id => ({ kind: 'delete', resource_kind: 'geofeature', resource_id, version: '1' }));
  const first = store.transact(null, tx => { for (const change of changes) tx.change(change); }).cursor;
  const batch = { type: 'change_batch', data: { previous_cursor: baseline, commit_cursor: first, changes } };
  assert.deepEqual([...store.messages(baseline, first)], [batch]);
  const batchBytes = Buffer.byteLength(JSON.stringify(batch));
  assert.equal(store.meta('replay_bytes'), String(batchBytes));
  const progress = () => store.transact(null, tx => tx.remember('test', uuid(), {})).cursor;
  const second = progress();
  const message = { type: 'progress', data: { previous_cursor: first, through_cursor: second } };
  const progressBytes = Buffer.byteLength(JSON.stringify(message));
  settings.replayBytes = batchBytes + progressBytes;
  assert.equal(store.meta('replay_bytes'), String(settings.replayBytes));
  assert.deepEqual([...store.messages(baseline, second)], [batch, message]);
  const before = { total: store.meta('replay_bytes'), earliest: store.earliest(), cursor: store.cursor() };
  assert.throws(store.db.transaction(() => { progress(); throw new Error('abort after pruning'); }), /abort after pruning/);
  assert.deepEqual({ total: store.meta('replay_bytes'), earliest: store.earliest(), cursor: store.cursor() }, before);
  assert.deepEqual([...store.messages(baseline, second)], [batch, message]);
  const third = progress();
  assert.equal(store.earliest(), first, 'Prune the entire two-change commit');
  assert.throws(() => [...store.messages(baseline, third)], error => error.code === 'cursor_expired');
  assert.deepEqual([...store.messages(first, third)], [message, { type: 'progress', data: { previous_cursor: second, through_cursor: third } }]);
  assert.equal(store.meta('replay_bytes'), String(2 * progressBytes));
  store.close(); store = new Store(path, settings);
  assert.equal(store.meta('replay_bytes'), String(2 * progressBytes));
  assert.equal(store.earliest(), first);
  // A previous binary can leave the derived total missing or stale. Rows remain authoritative.
  for (const total of [undefined, '1']) {
    if (total === undefined) store.db.prepare("DELETE FROM core_meta WHERE key='replay_bytes'").run();
    else store.setMeta('replay_bytes', total);
    store.close(); store = new Store(path, settings);
    assert.equal(store.meta('replay_bytes'), String(2 * progressBytes));
    assert.equal([...store.messages(first, third)].length, 2);
  }
  for (const hard of [false, true]) {
    const dataset = uuid(), action = uuid(), cursor = store.cursor(), total = store.meta('replay_bytes');
    assert.throws(store.db.transaction(() => { store.resetMetadata(dataset, action, hard); throw new Error('abort Reset'); }), /abort Reset/);
    assert.equal(store.meta('replay_bytes'), total); assert.equal(store.cursor(), cursor);
    store.db.transaction(() => store.resetMetadata(dataset, action, hard))();
    assert.equal(store.meta('replay_bytes'), '0');
    store.close(); store = new Store(path, settings);
    assert.equal(store.dataset, dataset); assert.equal(store.sequence, '0');
    assert.deepEqual([...store.messages(store.cursor(), store.cursor())], []);
    progress(); assert.equal(store.meta('replay_bytes'), String(progressBytes));
  }
});
test('replay age expiry and zero-byte retention remove complete commits with exact totals', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-28T00:00:00Z') });
  const directory = await mkdtemp(join(root, 'artifacts', 'replay-expiry-'));
  const settings = { ...defaults, replayMilliseconds: 1000 }, store = new Store(join(directory, 'core.sqlite'), settings);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const baseline = store.cursor(), progress = () => store.transact(null, tx => tx.remember('test', uuid(), {})).cursor;
  const first = progress(), bytes = Buffer.byteLength(JSON.stringify([...store.messages(baseline, first)][0]));
  t.mock.timers.tick(1000); progress();
  assert.equal(store.earliest(), baseline); assert.equal(store.meta('replay_bytes'), String(2 * bytes));
  t.mock.timers.tick(1); const third = progress();
  assert.equal(store.earliest(), first); assert.equal(store.meta('replay_bytes'), String(2 * bytes));
  assert.equal([...store.messages(first, third)].length, 2);
  settings.replayBytes = 0;
  const fourth = progress();
  assert.equal(store.earliest(), fourth); assert.equal(store.meta('replay_bytes'), '0');
  assert.deepEqual([...store.messages(fourth, fourth)], []);
  assert.throws(() => [...store.messages(third, fourth)], error => error.code === 'cursor_expired');
});
test('upload descriptor admission preserves ordinary headroom when content adds no reservation', async t => {
  for (const contentBytes of [0, 7]) await t.test(`${contentBytes} content bytes already reserved`, async t => {
    const directory = await mkdtemp(join(root, 'artifacts', 'descriptor-admission-'));
    const settings = { ...defaults, freeDiskBytes: 0, storageBytes: 32 * 1_048_576, objectBytes: 16 * 1_048_576, reserveBytes: 1_048_576 };
    const rpc = new DatabaseWorker(directory, settings, undefined, directory);
    t.after(async () => { await rpc.close(); await rm(directory, { recursive: true, force: true }); });
    const { dataset } = await rpc.ready, credential = secret();
    await rpc.call('provision', { request_id: uuid(), api_key_id: uuid(), secret: credential }, 1024, true);
    const context = { verifier: digest(credential), dataset, protocol: '0.3.0' }, attempt = uuid();
    const owner = await currentWriter();
    await rpc.call('prepare-upload', { context, attempt, owner }, 1024);
    if (contentBytes > 0) await rpc.call('reserve-upload', { context, attempt, bytes: contentBytes, written: 0 }, 512);
    const before = await rpc.call('attempt', attempt, 128);
    const descriptor = { request_id: uuid(), object_id: uuid(), byte_length: String(contentBytes), sha256: 'a'.repeat(64),
      content_type: 'application/octet-stream', metadata: { associations: [], description: '\u0000'.repeat(4096) } };
    const headroom = 4096, pressure = join(directory, 'pressure.bin');
    await writeFile(pressure, Buffer.alloc(settings.storageBytes - settings.reserveBytes - diskUsage(directory).bytes - contentBytes - headroom));
    const usage = diskUsage(directory).bytes;
    await assert.rejects(rpc.call('describe-upload', { context, attempt, descriptor }, 32_768), error => error.code === 'storage_limit');
    assert.deepEqual(await rpc.call('attempt', attempt, 128), before, 'A refusal must preserve the attempt and its original reservations');
    assert.ok(diskUsage(directory).bytes - usage <= headroom, 'Descriptor admission must not consume reserved control capacity');
    await rm(pressure);
    await rpc.call('describe-upload', { context, attempt, descriptor }, 32_768);
    const accepted = await rpc.call('attempt', attempt, 128);
    assert.deepEqual(JSON.parse(accepted.descriptor), descriptor);
    assert.equal(accepted.bytes, contentBytes);
    await rpc.call('abandon', attempt, 128); await rpc.call('reclaim', attempt, 128);
    assert.equal((await rpc.call('attempt', attempt, 128)).bytes, 0);
  });
});
test('Object quota refusal preserves history with ample storage and with aggregate pressure', async t => {
  for (const kind of ['prepare-upload', 'describe-upload', 'reserve-upload']) for (const pressure of [false, true]) await t.test(`${kind}, pressure=${pressure}`, async t => {
    const MiB = 1_048_576;
    const directory = await mkdtemp(join(root, 'artifacts', 'quota-history-')), captures = join(directory, 'captures');
    await mkdir(captures);
    const settings = { ...defaults, freeDiskBytes: 0, storageBytes: 32 * MiB, objectBytes: MiB, reserveBytes: MiB };
    const rpc = new DatabaseWorker(directory, settings, undefined, captures);
    t.after(async () => { await rpc.close(); await rm(directory, { recursive: true, force: true }); });
    const { dataset } = await rpc.ready, credential = secret();
    await rpc.call('provision', { request_id: uuid(), api_key_id: uuid(), secret: credential }, 1024, true);
    const context = { verifier: digest(credential), dataset, protocol: '0.3.0' };
    const call = async (name, request = {}) => {
      const response = await rpc.exchange(name, request, context, 1024);
      assert.equal(response.kind, 'success', JSON.stringify(response)); return response.body.data;
    };
    const asset = (await call('RegisterAsset', registration())).asset;
    const health = await call('GetHealth');
    const request = { query_id: uuid(), entity_id: asset.id, allocation_context: health.allocation_context };
    const history = await call('GetAssetMovementHistory', request);
    const attempt = uuid(), owner = await currentWriter();
    const descriptor = { request_id: uuid(), object_id: uuid(), byte_length: String(2 * MiB), sha256: 'a'.repeat(64),
      content_type: 'application/octet-stream', metadata: { associations: [] } };
    if (kind !== 'prepare-upload') await rpc.call('prepare-upload', { context, attempt, owner }, 1024);
    const db = new Database(join(directory, 'core.sqlite'), { readonly: true });
    t.after(() => db.close());
    const receipt = () => db.prepare('SELECT state,bytes,refs FROM temporary_receipts WHERE id=?').get(history.view_id);
    const before = receipt(); assert.ok(before.bytes > 8192);
    const file = join(captures, 'pressure.bin');
    if (pressure) {
      const admission = 2 * MiB + (kind === 'prepare-upload' ? 32768 : 0);
      await writeFile(file, Buffer.alloc(settings.storageBytes - settings.reserveBytes - before.bytes - admission + 4096));
      const pressured = await storageUsage(captures);
      const shortage = pressured.bytes + admission + settings.reserveBytes - settings.storageBytes;
      assert.ok(shortage > 0 && shortage < before.bytes, 'Aggregate admission alone could succeed by expiring history');
    }
    const data = kind === 'prepare-upload' ? { context, attempt, owner, descriptor }
      : kind === 'describe-upload' ? { context, attempt, descriptor } : { context, attempt, bytes: 2 * MiB, written: 0 };
    await assert.rejects(rpc.call(kind, data, 1024), error => error.code === 'storage_limit');
    assert.deepEqual(receipt(), before, 'An Object quota failure must not invalidate or reclaim the history view');
    assert.equal((await stat(join(captures, `${history.view_id}.sqlite`))).size, before.bytes);
    assert.equal((await call('GetAssetMovementHistory', request)).view_id, history.view_id);
    if (pressure) await rm(file);
    if (kind !== 'prepare-upload') {
      assert.equal((await rpc.call('attempt', attempt, 128)).bytes, 0);
      await rpc.call('abandon', attempt, 128); await rpc.call('reclaim', attempt, 128);
    }
  });
});
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
  const context = { verifier: digest(credential), dataset: state.dataset, protocol: '0.3.0' };
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
test('upload reservations released by one acknowledgment retain aggregate headroom and fresh deltas', { timeout: 45000 }, async t => {
  for (const kind of ['prepare-upload', 'describe-upload', 'reserve-upload', 'fresh-delta', 'object-quota', 'history-expiry', 'free-disk']) await t.test(kind, async t => {
    const directory = await mkdtemp(join(root, 'artifacts', 'upload-permits-'));
    const accountingRoot = join(directory, kind === 'history-expiry' ? 'captures' : 'accounting');
    await mkdir(accountingRoot);
    const MiB = 1_048_576;
    const settings = { ...defaults, freeDiskBytes: 0, workerQueueCount: 4096, workerQueueBytes: MiB, maxUploads: 8,
      storageBytes: (kind === 'object-quota' ? 64 : 12) * MiB, objectBytes: (kind === 'object-quota' ? 6 : 12) * MiB, reserveBytes: 4 * MiB,
      resourceImageBytes: 65536, limits: { ...defaults.limits, max_message_bytes: 212992 } };
    const declaredBytes = (kind === 'free-disk' ? 1536 : 5) * MiB;
    if (kind === 'free-disk') {
      const disk = await statfs(accountingRoot, { bigint: true });
      settings.freeDiskBytes = Number(disk.bavail * disk.bsize) - 2048 * MiB;
      assert.ok(settings.freeDiskBytes > 0);
      settings.storageBytes = 8192 * MiB; settings.objectBytes = 4096 * MiB;
    }
    const worker = new Worker(new URL('../dist/worker.js', import.meta.url), { workerData: { directory, accountingRoot, settings }, stdout: true, stderr: true });
    worker.stdout.resume(); worker.stderr.resume();
    t.after(async () => { await worker.terminate(); await rm(directory, { recursive: true, force: true }); });
    let ready;
    const started = new Promise((resolve, reject) => { ready = resolve; worker.once('error', reject); });
    const pending = new Map(), held = new Map();
    worker.on('message', message => {
      if (message.type === 'ready') { ready(message); return; }
      held.set(message.id, message);
      const resolve = pending.get(message.id); assert.ok(resolve); pending.delete(message.id); resolve(message);
    });
    let serial = 0;
    const send = (kind, data, reserved = false) => {
      const id = ++serial, response = new Promise(resolve => pending.set(id, resolve));
      worker.postMessage({ id, kind, data, reserved, enqueuedAtNs: process.hrtime.bigint() });
      return { id, response };
    };
    const ack = message => { held.delete(message.id); worker.postMessage({ type: 'received', id: message.id }); };
    const consume = async call => { const reply = await call.response; ack(reply); return reply; };
    const state = await started, credential = secret(), key = uuid(), administrator = secret();
    assert.equal((await consume(send('provision', { request_id: uuid(), api_key_id: key, secret: credential }, true))).type, 'reply');
    assert.equal((await consume(send('provision', { request_id: uuid(), api_key_id: uuid(), secret: administrator }, true))).type, 'reply');
    const context = { verifier: digest(credential), dataset: state.dataset, protocol: '0.3.0' };
    const exchange = (name, request, reserved = false) => send('exchange', { operation: { name, request }, context }, reserved);
    for (let i = 0; i < 3; i++) assert.equal((await consume(exchange('CreateGeofeature', { request_id: uuid(), geofeature_id: uuid(),
      geometry: { type: 'Point', coordinates: [0, 0] }, description: { name: 'Retained', description: 'x'.repeat(4096) } }))).type, 'reply');
    const owner = await currentWriter(), attempts = [uuid(), uuid()];
    const descriptors = attempts.map(() => ({ request_id: uuid(), object_id: uuid(), byte_length: String(declaredBytes), sha256: 'a'.repeat(64),
      content_type: 'application/octet-stream', metadata: { associations: [] } }));
    if (kind !== 'prepare-upload') for (const attempt of attempts) assert.equal((await consume(send('prepare-upload', { context, attempt, owner }))).type, 'reply');
    let expiredView;
    if (kind === 'history-expiry') {
      const asset = registration(); assert.equal((await consume(exchange('RegisterAsset', asset))).type, 'reply');
      const health = await consume(exchange('GetHealth', {}, true)); assert.equal(health.type, 'reply');
      const history = await consume(exchange('GetAssetMovementHistory', { query_id: uuid(), entity_id: asset.asset_id,
        allocation_context: health.value.response.body.data.allocation_context, page_size: 100 }));
      assert.equal(history.type, 'reply', JSON.stringify(history)); expiredView = history.value.response.body.data.view_id;
      const captureBytes = (await stat(join(accountingRoot, `${expiredView}.sqlite`))).size;
      assert.ok(captureBytes > 4096);
      await writeFile(join(accountingRoot, 'pressure.bin'), Buffer.alloc(settings.storageBytes - settings.reserveBytes - captureBytes - declaredBytes + 4096));
    }
    async function fillReplies() {
      const medium = await exchange('ListGeofeatures', { page_size: 3 }).response;
      assert.equal(medium.type, 'reply');
      for (;;) {
        const call = send('authorize', { context, discovery: false });
        const barrier = await send('authorize', { context, discovery: false }, true).response;
        assert.equal(barrier.type, 'reply');
        const reply = held.get(call.id);
        if (reply === undefined) return { medium, waiting: call };
        assert.equal(reply.type, 'reply');
      }
    }
    const filled = await fillReplies();
    const upload = (index, bytes = declaredBytes) => kind === 'prepare-upload'
      ? send('prepare-upload', { context, attempt: attempts[index], owner, descriptor: descriptors[index] })
      : kind === 'describe-upload' ? send('describe-upload', { context, attempt: attempts[index], descriptor: descriptors[index] })
        : send('reserve-upload', { context, attempt: attempts[index], bytes, written: 0 });
    const calls = kind === 'fresh-delta' ? [upload(0), upload(0, 6 * MiB)] : [upload(0), upload(1)];
    await delay(50);
    for (const call of calls) assert.equal(held.has(call.id), false, 'Both reservations wait for the same acknowledgment');
    if (kind === 'prepare-upload') for (const reply of [...held.values()]) ack(reply);
    else ack(filled.medium);
    const replies = await Promise.all(calls.map(consume));
    assert.equal((await filled.waiting.response).type, 'reply');
    if (kind === 'fresh-delta') assert.deepEqual(replies.map(reply => reply.type), ['reply', 'reply']);
    else assert.deepEqual(replies.map(reply => reply.type === 'reply' ? 'reply' : reply.error.body.error.code).sort(), ['reply', 'storage_limit']);
    for (const reply of [...held.values()]) ack(reply);
    const db = new Database(join(directory, 'core.sqlite'), { readonly: true });
    t.after(() => db.close());
    const charges = () => db.prepare("SELECT id,bytes FROM object_attempts WHERE state<>'reclaimed' ORDER BY id").all();
    const retained = charges().reduce((sum, attempt) => sum + attempt.bytes, 0);
    assert.equal(retained, kind === 'fresh-delta' ? 6 * MiB : declaredBytes);
    assert.ok(retained + settings.reserveBytes <= settings.storageBytes);
    assert.ok(retained <= settings.objectBytes);
    const disk = await statfs(accountingRoot, { bigint: true });
    assert.ok(retained + settings.freeDiskBytes <= Number(disk.bavail * disk.bsize));
    if (expiredView !== undefined) {
      assert.deepEqual(db.prepare('SELECT state,bytes FROM temporary_receipts WHERE id=?').get(expiredView), { state: 'released', bytes: 0 });
      assert.equal((await readdir(accountingRoot)).some(file => file.startsWith(expiredView)), false, 'Storage admission reclaims the real history file before retrying');
    }
    if (kind !== 'fresh-delta') {
      const winner = replies.findIndex(reply => reply.type === 'reply'), loser = 1 - winner;
      const before = charges();
      const retry = await consume(upload(loser)); assert.equal(retry.type, 'refusal'); assert.equal(retry.error.body.error.code, 'storage_limit');
      assert.deepEqual(charges(), before, 'A refused retry retains the exact charges');
      assert.equal((await consume(send('abandon', attempts[winner]))).type, 'reply');
      assert.equal((await consume(send('reclaim', attempts[winner]))).type, 'reply');
      assert.equal((await consume(upload(loser))).type, 'reply', 'Reclaimed capacity admits the refused upload');
      assert.equal(charges().reduce((sum, attempt) => sum + attempt.bytes, 0), declaredBytes);
    }
    const blockedFill = await fillReplies();
    const beforeRevocation = charges();
    const blockedAttempt = db.prepare("SELECT id,bytes FROM object_attempts WHERE state='active' ORDER BY id LIMIT 1").get();
    const blocked = send('reserve-upload', { context, attempt: blockedAttempt.id, bytes: blockedAttempt.bytes + 1, written: 0 });
    const revoked = await consume(send('exchange', { operation: { name: 'RevokeApiKey', request: { request_id: uuid(), api_key_id: key } },
      context: { ...context, verifier: digest(administrator) } }, true));
    assert.equal(revoked.type, 'reply'); assert.equal(held.has(blocked.id), false);
    ack(blockedFill.medium);
    const denied = await consume(blocked); assert.equal(denied.type, 'refusal'); assert.equal(denied.error.body.error.code, 'unauthorized');
    assert.deepEqual(charges(), beforeRevocation, 'Revocation during a permit wait retains the exact charges');
  });
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
  const refusedAssigned = { ...assigned, read_id: uuid() };
  assert.equal((await f.call('GetAssignedTasks', refusedAssigned)).json.error.code, 'storage_limit');
  const terminal = { evidence: evidence(2, { task_id: task.task_id, event: 'state', state: 'failed', reason: 'cannot_execute' }) };
  assert.equal(ok(await f.call('ReportTaskExecution', terminal)).task.execution_state, 'failed');
  await fill(true);
  assert.equal((await f.call('ReportTaskExecution', { evidence: evidence(3, terminal.evidence.payload) })).json.error.code, 'storage_limit');
  assert.equal(ok(await f.call('ReportTaskExecution', terminal)).evidence_disposition, 'duplicate');
  await rm(pressure);
  assert.equal((await f.call('ReportTaskExecution', { evidence: evidence(3, terminal.evidence.payload) })).status, 200);
  assert.equal(ok(await f.call('GetAssignedTasks', { ...refusedAssigned, page_size: 20 })).read_id, refusedAssigned.read_id,
    'Refused assigned reads must roll back both the live context and durable identity receipt');
});
test('tiny HTTP requests coexist and required exchanges fit the reserved IPC capacity', async t => {
  const f = await fixture(t);
  const asset = ok(await f.call('RegisterAsset', registration())).asset;
  const task = ok(await f.call('CreateTask', { request_id: uuid(), task_id: uuid(), asset_id: asset.id, command: 'pause', scheduling: 'immediate', inputs: {} }));
  const reads = await Promise.all(Array.from({ length: 32 }, () => f.call('ListAssets', {})));
  for (const response of reads) assert.equal(ok(response).items[0].id, asset.id);
  const context = { verifier: digest(f.apiKey), dataset: f.core.dataset, protocol: '0.3.0' };
  const pending = [];
  for (let i = 0; i < 15; i++) pending.push(f.core.rpc.exchange('ListAssets', {}, context, 1_048_576).catch(error => error));
  const outcome = f.core.rpc.exchange('RequestTaskCancellation', { task_id: task.task_id, request_id: uuid() }, context, 4096);
  const terminal = f.core.rpc.exchange('ReportTaskExecution', { evidence: { dataset_id: f.core.dataset, asset_id: asset.id,
    origin: { kind: 'asset_process', process_generation: asset.process_generation }, report_id: uuid(), sequence: '1', generated_at: null,
    payload: { task_id: task.task_id, event: 'state', state: 'failed', reason: 'cannot_execute' } } }, context, 8192);
  for (const response of await Promise.all([outcome, terminal])) assert.equal(response.kind, 'success');
  for (const response of await Promise.all(pending)) {
    if (response.kind === 'success') assert.equal(response.body.data.items[0].id, asset.id);
    else assert.equal(response.code, 'resource_limit');
  }
  assert.equal(ok(await f.call('GetTask', { task_id: task.task_id })).execution_state, 'failed');
  const idleDeadline = performance.now() + 2000;
  while (f.core.rpc.usage.operations > 0 && performance.now() < idleDeadline) await delay(10);
  assert.equal(f.core.rpc.available, true, 'Queue accounting is checked on the live worker');
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
