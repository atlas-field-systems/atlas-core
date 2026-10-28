import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readdir, readFile } from 'node:fs/promises';
import { watch, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { once } from 'node:events';
import { readWssServer, writeWssClient, exchanges } from '@atlas/protocol';
import { join } from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { Engine } from '../dist/engine.js';
import { Reads } from '../dist/reads.js';
import { defaults } from '../dist/settings.js';
import { digest } from '../dist/exact.js';
import { publicError, Refusal } from '../dist/fault.js';
import { diskUsage } from '../dist/capacity.js';
import { root, uuid, secret, report, telemetry, fixture } from './helpers.mjs';

const limits = { max_message_bytes: 4194304, max_json_values: 262144, max_changes: 1000 };
async function local(t, temporary = {}) {
  const directory = await mkdtemp(join(root, 'artifacts', 'capture-'));
  const engine = new Engine(directory, { ...defaults, freeDiskBytes: 0, temporary: { ...defaults.temporary, ...temporary } });
  const key = { api_key_id: uuid(), request_id: uuid(), secret: secret() }; engine.provision(key);
  const context = { verifier: digest(key.secret), dataset: engine.store.dataset, protocol: '0.1.0' };
  const call = async (name, request = {}) => (await engine.execute({ name, request }, context)).body.data;
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  return { engine, directory, context, key, call };
}
async function building(engine, kind) {
  const deadline = performance.now() + 5000;
  while (true) {
    const receipt = engine.temporary.receipts(kind).find(receipt => receipt.state === 'building' && receipt.bytes > 32768);
    if (receipt) return receipt;
    assert.ok(performance.now() < deadline, 'Capture did not enter its fixed source view');
    await yieldToLoop();
  }
}
async function historyView(f) {
  const observation = uuid(), publisher = uuid(), origin = { kind: 'publisher', publisher_id: publisher };
  await f.call('CreateObservation', { request_id: uuid(), observation_id: observation, publisher_id: publisher });
  for (let i = 1; i <= 2; i++) await f.call('ReportObservation', { observation_id: observation, publisher_id: publisher,
    report: report(f.engine.store.dataset, observation, origin, i, { telemetry: telemetry(origin, i) }) });
  const health = await f.call('GetHealth');
  const request = { query_id: uuid(), entity_id: observation, allocation_context: health.allocation_context, page_size: 1 };
  return { request, page: await f.call('GetObservationMovementHistory', request) };
}
for (const kind of ['snapshot', 'history']) test(`1024 refused ${kind} allocations leave no receipts, files or database growth without logging`, async t => {
  const f = await local(t);
  const MiB = 1024 * 1024;
  f.engine.settings.storageBytes = 16 * MiB;
  f.engine.settings.reserveBytes = 2 * MiB;
  const observation = uuid(), publisher = uuid(), origin = { kind: 'publisher', publisher_id: publisher };
  await f.call('CreateObservation', { request_id: uuid(), observation_id: observation, publisher_id: publisher,
    report: report(f.engine.store.dataset, observation, origin, 1, { telemetry: telemetry(origin, 1) }) });
  const health = await f.call('GetHealth');
  const name = kind === 'snapshot' ? 'ReadSnapshot' : 'GetObservationMovementHistory';
  const request = () => kind === 'snapshot'
    ? { load_id: uuid(), allocation_context: health.allocation_context, page_size: 100, ...limits }
    : { query_id: uuid(), entity_id: observation, allocation_context: health.allocation_context };
  const readyRequest = request(), ready = await f.call(name, readyRequest);
  const failedRequest = request();
  const quota = kind === 'snapshot' ? 'max_snapshot_bytes' : 'max_history_references_per_view';
  const previousQuota = f.engine.settings.temporary[quota];
  f.engine.settings.temporary[quota] = kind === 'snapshot' ? '0' : 0;
  await assert.rejects(f.call(name, failedRequest), error => error.code === 'resource_limit');
  f.engine.settings.temporary[quota] = previousQuota;
  const expired = f.engine.temporary.reserve('contact', health.allocation_context, uuid(), {}).receipt;
  f.engine.temporary.set({ ...expired, state: 'consumed', deadline: 0 });
  f.engine.store.db.prepare('UPDATE temporary_receipts SET deadline=0 WHERE id=?').run(expired.id);
  const pressure = join(f.directory, 'pressure.bin');
  await writeFile(pressure, Buffer.alloc(f.engine.settings.storageBytes - f.engine.settings.reserveBytes - diskUsage(f.directory).bytes - 32768));
  const filesBefore = await readdir(join(f.directory, 'captures'));
  const receiptsBefore = f.engine.store.db.prepare('SELECT * FROM temporary_receipts ORDER BY id').all();
  const ownersBefore = f.engine.temporary.captureFiles();
  const bytesBefore = diskUsage(f.directory).bytes;
  const databaseBytes = () => ['', '-wal', '-shm'].map(suffix => statSync(f.engine.store.path + suffix).size);
  const databaseBefore = databaseBytes();
  const refused = request();
  const outcomes = [];
  for (let i = 0; i < 1024; i++) {
    try { await f.call(name, i === 0 ? refused : request()); outcomes.push('accepted'); }
    catch (error) { outcomes.push(error.code); }
  }
  assert.deepEqual(new Set(outcomes), new Set(['storage_limit']));
  const receiptsAfter = f.engine.store.db.prepare('SELECT * FROM temporary_receipts ORDER BY id').all();
  t.diagnostic(JSON.stringify({ kind, refusals: outcomes.length, receiptsBefore: receiptsBefore.length, receiptsAfter: receiptsAfter.length,
    bytesBefore, bytesAfter: diskUsage(f.directory).bytes, databaseBefore, databaseAfter: databaseBytes() }));
  assert.equal(receiptsAfter.length, receiptsBefore.length);
  assert.deepEqual(receiptsAfter, receiptsBefore);
  assert.deepEqual(f.engine.temporary.captureFiles(), ownersBefore);
  assert.deepEqual(await readdir(join(f.directory, 'captures')), filesBefore);
  assert.deepEqual(databaseBytes(), databaseBefore);
  assert.equal(diskUsage(f.directory).bytes, bytesBefore);
  assert.ok(bytesBefore + f.engine.settings.reserveBytes <= f.engine.settings.storageBytes);
  assert.deepEqual(await f.call(name, readyRequest), ready);
  await assert.rejects(f.call(name, failedRequest), error => error.code === 'resource_limit');
  await rm(pressure);
  const admitted = await f.call(name, refused);
  assert.ok(kind === 'snapshot' ? admitted.capture_id : admitted.view_id);
  assert.ok(diskUsage(f.directory).bytes + f.engine.settings.reserveBytes <= f.engine.settings.storageBytes);
});
for (const kind of ['snapshot', 'history']) {
  for (const invalidation of ['authority', 'deadline']) test(`${kind} admission rechecks ${invalidation} after waiting without reserving a receipt`, async t => {
    const f = await local(t);
    const administrator = secret();
    if (invalidation === 'authority') f.engine.provision({ api_key_id: uuid(), request_id: uuid(), secret: administrator });
    const entity = uuid();
    await f.call('CreateObservation', { request_id: uuid(), observation_id: entity, publisher_id: uuid() });
    const health = await f.call('GetHealth');
    const request = kind === 'snapshot' ? { load_id: uuid(), allocation_context: health.allocation_context, page_size: 100, ...limits }
      : { query_id: uuid(), entity_id: entity, allocation_context: health.allocation_context };
    const entered = Promise.withResolvers(), resume = Promise.withResolvers();
    const reserve = f.engine.reserveStorage.bind(f.engine);
    f.engine.reserveStorage = async reservation => { entered.resolve(); await resume.promise; return reserve(reservation); };
    const pending = f.call(kind === 'snapshot' ? 'ReadSnapshot' : 'GetObservationMovementHistory', request).catch(error => error);
    await entered.promise;
    try {
      if (invalidation === 'authority') await f.engine.execute({ name: 'RevokeApiKey', request: { request_id: uuid(), api_key_id: f.key.api_key_id } },
        { ...f.context, verifier: digest(administrator) });
      else {
        const expired = performance.now() + 60_001;
        t.mock.method(performance, 'now', () => expired);
      }
    } finally { resume.resolve(); }
    const result = await pending;
    t.mock.restoreAll();
    assert.equal(result.code, invalidation === 'authority' ? 'unauthorized' : 'allocation_expired');
    assert.deepEqual(f.engine.temporary.receipts(kind), []);
    assert.deepEqual(f.engine.temporary.captureFiles(), []);
    assert.equal(diskUsage(f.directory).bytes + f.engine.reads.unwritten <= f.engine.settings.storageBytes, true);
  });
  test(`${kind} batch admission precedes its quota charge and keeps terminal headroom across a wait`, async t => {
    const f = await local(t);
    const entity = uuid(), origin = { kind: 'publisher', publisher_id: uuid() };
    await f.call('CreateObservation', { request_id: uuid(), observation_id: entity, publisher_id: origin.publisher_id,
      report: report(f.engine.store.dataset, entity, origin, 1, { telemetry: telemetry(origin, 1) }) });
    const health = await f.call('GetHealth');
    const request = kind === 'snapshot' ? { load_id: uuid(), allocation_context: health.allocation_context, page_size: 100, ...limits }
      : { query_id: uuid(), entity_id: entity, allocation_context: health.allocation_context };
    const entered = Promise.withResolvers(), resume = Promise.withResolvers();
    const reserve = f.engine.reserveStorage.bind(f.engine);
    let calls = 0;
    f.engine.reserveStorage = async reservation => {
      if (++calls === 2) { entered.resolve(); await resume.promise; }
      return reserve(reservation);
    };
    const name = kind === 'snapshot' ? 'ReadSnapshot' : 'GetObservationMovementHistory';
    const pending = f.call(name, request).catch(error => error);
    await entered.promise;
    const receipt = f.engine.temporary.receipts(kind)[0];
    const unwritten = f.engine.reads.unwritten;
    try {
      assert.equal(receipt.refs, 0, 'The pending batch must not charge references before aggregate admission');
      assert.ok(unwritten > 65536, 'Unwritten storage must retain metadata/outcome headroom after the capture file is created');
      f.engine.settings.storageBytes = diskUsage(f.directory).bytes + f.engine.settings.reserveBytes + unwritten;
      await assert.rejects(f.engine.reserveStorage(admit => admit(65536)), error => error.code === 'storage_limit');
    } finally { resume.resolve(); }
    assert.equal((await pending).code, 'storage_limit');
    assert.equal(f.engine.temporary.peek(receipt.id).state, 'failed');
    assert.equal(f.engine.temporary.peek(receipt.id).refs, 0);
    assert.equal(f.engine.reads.unwritten, 0);
    assert.deepEqual(f.engine.temporary.captureFiles(), []);
    assert.ok(diskUsage(f.directory).bytes + f.engine.settings.reserveBytes <= f.engine.settings.storageBytes);
    await assert.rejects(f.call(name, request), error => error.code === 'storage_limit');
  });
}
test('history selections stream the executed SQL without a native sorter or scanning excluded positions', async t => {
  const f = await local(t, { max_history_references_per_view: 2 });
  const entity = uuid(), origin = { kind: 'publisher', publisher_id: uuid() };
  await f.call('CreateObservation', { request_id: uuid(), observation_id: entity, publisher_id: origin.publisher_id });
  const readingId = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
  const at = n => `2026-10-21T12:00:00.${String(n).padStart(9, '0')}Z`;
  const mixed = [
    [9004, null], [9001, '9999-12-31T23:59:59Z'], [9003, '9999-12-31T23:59:59.1Z'], [9002, null],
    [9006, '2026-10-21T12:00:00.1Z'], [9005, '2026-10-21T12:00:00.100Z'],
  ];
  f.engine.store.transact(null, tx => {
    for (const [n, time] of [...Array.from({ length: 8192 }, (_, n) => [n, at(n)]), ...mixed]) {
      const input = exchanges.ReportObservation.request.schema.parse({ observation_id: entity, publisher_id: origin.publisher_id,
        report: report(f.engine.store.dataset, entity, origin, n + 1, { telemetry: telemetry(origin, n % 90, time, readingId(n)) }, 'history_only') });
      f.engine.entities.reportObservation(tx, input);
    }
  });
  const health = await f.call('GetHealth');
  const plans = [], visited = [];
  const prepare = Database.prototype.prepare;
  Database.prototype.prepare = function (sql) {
    const statement = Reflect.apply(prepare, this, [sql]);
    if (!this.readonly || !/FROM evidence_positions\b/.test(sql)) return statement;
    const iterate = statement.iterate.bind(statement), database = this;
    statement.iterate = function* (...bindings) {
      plans.push(Reflect.apply(prepare, database, [`EXPLAIN QUERY PLAN ${sql}`]).all(...bindings));
      for (const row of iterate(...bindings)) { visited.push(row.identity); yield row; }
    };
    return statement;
  };
  t.after(() => { Database.prototype.prepare = prepare; });
  const query = async selection => {
    visited.length = 0;
    const page = await f.call('GetObservationMovementHistory', { entity_id: entity, query_id: uuid(), allocation_context: health.allocation_context, ...selection });
    await f.call('ReleaseHistoryView', { release_token: page.release_token });
    return page;
  };
  const narrow = await query({ time_groups: ['known'], source_time_from: at(8000), source_time_before: at(8001) });
  assert.deepEqual(narrow.readings.map(r => r.observed_at), [at(8000)]);
  assert.ok(plans.length > 0);
  assert.ok(plans.flat().every(row => !/TEMP B-TREE/.test(row.detail)), JSON.stringify(plans));
  assert.ok(plans.flat().some(row => row.detail.includes('<expr>>?') && row.detail.includes('<expr><?')), JSON.stringify(plans));
  assert.equal(visited.length, 1);
  const ties = await query({ time_groups: ['known'], source_time_from: '2026-10-21T12:00:00.1Z' });
  assert.deepEqual(ties.readings.map(r => [r.source_evidence.reading_id, r.observed_at]), [[readingId(9005), mixed[5][1]], [readingId(9006), mixed[4][1]]]);
  f.engine.settings.temporary.max_history_references_per_view = 4;
  const unknown = await query({ time_groups: ['unknown', 'uncertain'], source_time_from: at(9999), source_time_before: at(10000) });
  assert.deepEqual(unknown.readings.map(r => [r.source_evidence.reading_id, r.time_status]), [[readingId(9001), 'uncertain'], [readingId(9002), 'unknown'], [readingId(9003), 'uncertain'], [readingId(9004), 'unknown']]);
  assert.equal(visited.length, 4);
  f.engine.settings.temporary.max_history_references_per_view = 6;
  const combined = await query({ source_time_from: '2026-10-21T12:00:00.1Z' });
  assert.deepEqual(combined.readings.map(r => r.source_evidence.reading_id), [9005, 9006, 9001, 9002, 9003, 9004].map(readingId));
  assert.deepEqual((await query({ time_groups: [] })).readings, []);
  assert.equal(visited.length, 0);
  assert.ok(plans.flat().every(row => !/TEMP B-TREE/.test(row.detail)), JSON.stringify(plans));
  t.diagnostic(JSON.stringify([...new Set(plans.flat().map(row => row.detail))]));
});
test('single-status history selections seek past the other retained status', async t => {
  const f = await local(t, { max_history_references_per_view: 1 });
  const selections = [];
  for (const [status, observed] of [['unknown', null], ['uncertain', '9999-12-31T23:59:59Z']]) {
    const entity = uuid(), origin = { kind: 'publisher', publisher_id: uuid() };
    await f.call('CreateObservation', { request_id: uuid(), observation_id: entity, publisher_id: origin.publisher_id,
      report: report(f.engine.store.dataset, entity, origin, 1, { telemetry: telemetry(origin, 1, observed) }) });
    const row = f.engine.store.db.prepare('SELECT * FROM evidence_positions WHERE entity=?').get(entity);
    const image = JSON.parse(row.image), prefix = row.identity.slice(0, row.identity.lastIndexOf('/') + 1);
    const insert = f.engine.store.db.prepare('INSERT INTO evidence_positions VALUES(?,?,?,?,?,?)');
    f.engine.store.db.transaction(() => {
      for (let i = 0; i < 8192; i++) {
        const reading = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
        image.source_evidence.reading_id = reading;
        insert.run(prefix + reading, entity, row.source_kind, row.time_key, status, JSON.stringify(image));
      }
    })();
    selections.push({ entity, status: status === 'unknown' ? 'uncertain' : 'unknown' });
  }
  const plans = [], prepare = Database.prototype.prepare;
  Database.prototype.prepare = function (sql) {
    const statement = Reflect.apply(prepare, this, [sql]);
    if (!this.readonly || !/FROM evidence_positions\b/.test(sql)) return statement;
    const iterate = statement.iterate.bind(statement), database = this;
    statement.iterate = function* (...bindings) {
      plans.push(Reflect.apply(prepare, database, [`EXPLAIN QUERY PLAN ${sql}`]).all(...bindings));
      yield* iterate(...bindings);
    };
    return statement;
  };
  t.after(() => { Database.prototype.prepare = prepare; });
  const health = await f.call('GetHealth');
  for (const selection of selections) {
    const page = await f.call('GetObservationMovementHistory', { entity_id: selection.entity, query_id: uuid(),
      allocation_context: health.allocation_context, time_groups: [selection.status] });
    assert.deepEqual(page.readings, []);
    await f.call('ReleaseHistoryView', { release_token: page.release_token });
  }
  assert.equal(plans.length, 2);
  assert.ok(plans.flat().every(row => row.detail.includes('entity=? AND status=?') && !row.detail.includes('TEMP B-TREE')), JSON.stringify(plans));
});
test('failed capture outcome writes release pending admission headroom', async t => {
  const f = await local(t, { max_snapshot_bytes: '0' });
  const health = await f.call('GetHealth');
  f.engine.store.db.exec("CREATE TRIGGER reject_capture_outcome BEFORE UPDATE ON temporary_receipts WHEN NEW.state='failed' BEGIN SELECT RAISE(ABORT,'capture_outcome_write_failed'); END");
  await assert.rejects(f.call('ReadSnapshot', { load_id: uuid(), allocation_context: health.allocation_context, page_size: 1, ...limits }),
    error => error instanceof AggregateError && error.errors[0].code === 'resource_limit' && error.errors.some(cause => cause.message === 'capture_outcome_write_failed'));
  f.engine.store.db.exec('DROP TRIGGER reject_capture_outcome');
  f.engine.settings.storageBytes = diskUsage(f.directory).bytes + f.engine.settings.reserveBytes + 131072;
  const created = await f.call('CreateGeofeature', { request_id: uuid(), geofeature_id: uuid(), geometry: { type: 'Point', coordinates: [0, 0] } });
  assert.equal(created.geometry.type, 'Point');
  assert.equal(f.engine.reads.unwritten, 0);
});
test('failed capture bookkeeping cannot strand default snapshot slots after expiry', async t => {
  const f = await local(t);
  const health = await f.call('GetHealth');
  const directory = join(f.directory, 'captures');
  await writeFile(directory, 'blocked directory');
  f.engine.store.db.exec("CREATE TRIGGER reject_failed_capture BEFORE UPDATE ON temporary_receipts WHEN NEW.state='failed' BEGIN SELECT RAISE(ABORT,'capture_failure_write_rejected'); END");
  for (let i = 0; i < defaults.temporary.max_snapshot_captures_per_key; i++) {
    await assert.rejects(f.call('ReadSnapshot', { load_id: uuid(), allocation_context: health.allocation_context, page_size: 1, ...limits }));
  }
  assert.equal(f.engine.temporary.receipts('snapshot').length, 2);
  assert.deepEqual(f.engine.temporary.captureFiles(), []);
  await rm(directory);
  f.engine.store.db.exec('DROP TRIGGER reject_failed_capture');
  const expired = performance.now() + 60_001;
  t.mock.method(performance, 'now', () => expired);
  try {
    await f.engine.tick();
    const fresh = await f.call('GetHealth');
    const page = await f.call('ReadSnapshot', { load_id: uuid(), allocation_context: fresh.allocation_context, page_size: 1, ...limits });
    assert.equal(f.engine.temporary.receipts('snapshot').length, 1);
    await f.call('ReleaseSnapshot', { release_token: page.release_token });
  } finally { t.mock.restoreAll(); }
});
test('failure receipt rejection still closes capture databases and removes the file', async t => {
  const f = await local(t);
  await f.call('CreateGeofeature', { request_id: uuid(), geofeature_id: uuid(), geometry: { type: 'Point', coordinates: [0, 0] } });
  const health = await f.call('GetHealth'), opened = new Set();
  const exec = Database.prototype.exec;
  t.mock.method(Database.prototype, 'exec', function (sql) {
    const result = Reflect.apply(exec, this, [sql]);
    if (this.name.startsWith(join(f.directory, 'captures') + '/') && sql.startsWith('CREATE TABLE items')) {
      opened.add(this);
      Reflect.apply(exec, this, ["CREATE TRIGGER reject_capture_row BEFORE INSERT ON items BEGIN SELECT RAISE(ABORT,'capture_row_write_rejected'); END"]);
    } else if (this.readonly && this.name === f.engine.store.path && sql === 'BEGIN') opened.add(this);
    return result;
  });
  t.after(() => { for (const database of opened) if (database.open) { if (database.inTransaction) database.exec('ROLLBACK'); database.close(); } });
  f.engine.store.db.exec("CREATE TRIGGER reject_failed_capture BEFORE UPDATE ON temporary_receipts WHEN NEW.state='failed' BEGIN SELECT RAISE(ABORT,'capture_failure_write_rejected'); END");
  const error = await f.call('ReadSnapshot', { load_id: uuid(), allocation_context: health.allocation_context, page_size: 1, ...limits }).catch(error => error);
  f.engine.store.db.exec('DROP TRIGGER reject_failed_capture');
  t.mock.restoreAll();
  assert.equal(opened.size, 2);
  assert.ok([...opened].every(database => !database.open), 'Both real SQLite connections must close despite the failed failure-receipt write');
  assert.deepEqual(await readdir(join(f.directory, 'captures')), []);
  assert.ok(error instanceof AggregateError);
  const messages = value => value instanceof AggregateError ? value.errors.flatMap(messages) : [value.message];
  assert.ok(messages(error).includes('capture_row_write_rejected'));
  assert.ok(messages(error).includes('capture_failure_write_rejected'));
  await f.call('CreateGeofeature', { request_id: uuid(), geofeature_id: uuid(), geometry: { type: 'Point', coordinates: [1, 1] } });
  const checkpoint = f.engine.store.db.pragma('wal_checkpoint(PASSIVE)')[0];
  assert.equal(checkpoint.checkpointed, checkpoint.log);
});
test('maintenance protects an expired capture until its builder finishes', async t => {
  const f = await local(t), health = await f.call('GetHealth');
  const entered = Promise.withResolvers(), resume = Promise.withResolvers();
  const reserve = f.engine.reserveStorage.bind(f.engine);
  let first = true;
  f.engine.reserveStorage = async reservation => {
    const result = await reserve(reservation);
    if (first) { first = false; entered.resolve(); await resume.promise; }
    return result;
  };
  const pending = f.call('ReadSnapshot', { load_id: uuid(), allocation_context: health.allocation_context, page_size: 1, ...limits }).catch(error => error);
  await entered.promise;
  const receipt = f.engine.temporary.receipts('snapshot')[0], expired = performance.now() + 60_001;
  t.mock.method(performance, 'now', () => expired);
  try {
    await f.engine.tick();
    assert.equal(f.engine.temporary.peek(receipt.id).state, 'building');
  } finally { resume.resolve(); }
  assert.equal((await pending).code, 'allocation_expired');
  await f.engine.tick();
  t.mock.restoreAll();
  assert.equal(f.engine.temporary.peek(receipt.id), undefined);
});
test('history expiry makes pages unavailable before unlink and shares reclamation with concurrent release', { timeout: 10000 }, async t => {
  const f = await local(t), { page, request } = await historyView(f);
  assert.ok(page.next_page_token);
  let watcher;
  const duringUnlink = new Promise(resolve => {
    watcher = watch(join(f.directory, 'captures'), (event, file) => {
      if (event !== 'rename' || file !== `${page.view_id}.sqlite`) return;
      watcher.close();
      resolve(Promise.allSettled([
        f.call('GetObservationMovementHistory', { page_token: page.next_page_token }),
        f.call('ReleaseHistoryView', { release_token: page.release_token }),
      ]));
    });
  });
  t.after(() => watcher.close());
  const [expiries, [continuation, release]] = await Promise.all([
    Promise.allSettled([f.engine.reads.expireHistory(), f.engine.reads.expireHistory()]), duringUnlink,
  ]);
  for (const result of [...expiries, release]) assert.equal(result.status, 'fulfilled', String(result.reason));
  assert.equal(continuation.status, 'rejected'); assert.equal(continuation.reason.code, 'allocation_expired');
  await assert.rejects(f.call('GetObservationMovementHistory', request), error => error.code === 'allocation_expired');
  assert.deepEqual(f.engine.temporary.captureFiles(), []);
  assert.deepEqual(await readdir(join(f.directory, 'captures')), []);
  assert.equal(f.engine.store.metrics.capture_expiries + f.engine.store.metrics.capture_releases, 1);
  const fresh = await f.call('GetObservationMovementHistory', { ...request, query_id: uuid(), page_size: 100 });
  assert.equal(fresh.readings.length, 2, 'Expiry must preserve the retained source positions');
});
test('failed pressure expiry retains charges, refuses pages, and can retry cleanup before its deadline', async t => {
  const f = await local(t), { page, request } = await historyView(f);
  const before = f.engine.temporary.peek(page.view_id), storageBytes = f.engine.settings.storageBytes;
  const blocked = join(f.directory, 'captures', `${page.view_id}.sqlite-shm`);
  await mkdir(blocked);
  f.engine.settings.storageBytes = diskUsage(f.directory).bytes + f.engine.settings.reserveBytes + 65536 - 4096;
  const reserve = () => f.engine.reserveStorage(admit => admit(65536));
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(reserve(), error => error instanceof AggregateError && error.errors[0].code === 'storage_limit' &&
      publicError(error.errors[1], f.engine.store.dataset).body.error.code === 'integrity_fault');
    const charged = f.engine.temporary.peek(page.view_id);
    assert.equal(charged.state, 'released'); assert.equal(charged.bytes, before.bytes); assert.equal(charged.refs, before.refs);
    assert.equal(f.engine.temporary.captureFiles()[0].bytes, before.bytes);
  }
  assert.equal((await readdir(join(f.directory, 'captures'))).includes(`${page.view_id}.sqlite`), false);
  await assert.rejects(f.call('GetObservationMovementHistory', { page_token: page.next_page_token }), error => error.code === 'allocation_expired');
  await assert.rejects(f.call('GetObservationMovementHistory', request), error => error.code === 'allocation_expired');
  await assert.rejects(f.call('ReleaseHistoryView', { release_token: page.release_token }), error => publicError(error, f.engine.store.dataset).status === 500);
  await assert.rejects(f.engine.reads.cleanup(), error => publicError(error, f.engine.store.dataset).status === 500);
  assert.ok(f.engine.temporary.peek(page.view_id).bytes > 0, 'Failed release and cleanup must keep their charge');
  await rm(blocked, { recursive: true });
  await Promise.all([f.engine.reads.expireHistory(), f.engine.reads.cleanup(), f.call('ReleaseHistoryView', { release_token: page.release_token })]);
  assert.equal(f.engine.temporary.peek(page.view_id).bytes, 0);
  assert.equal(f.engine.temporary.peek(page.view_id).refs, 0);
  assert.deepEqual(f.engine.temporary.captureFiles(), []);
  assert.equal(f.engine.store.metrics.capture_expiries + f.engine.store.metrics.capture_releases, 1);
  f.engine.settings.storageBytes = storageBytes;
  assert.equal((await f.call('GetObservationMovementHistory', { ...request, query_id: uuid(), page_size: 100 })).readings.length, 2);
});
test('aggregate admission preserves history when reclaiming it cannot admit the request', async t => {
  for (const operation of ['reservation', 'write']) await t.test(operation, async t => {
    const f = await local(t), { page, request } = await historyView(f);
    const receipt = f.engine.temporary.peek(page.view_id);
    f.engine.settings.storageBytes = diskUsage(f.directory).bytes + f.engine.settings.reserveBytes;
    const pending = operation === 'reservation' ? f.engine.reserveStorage(admit => admit(65536))
      : f.call('CreateGeofeature', { request_id: uuid(), geofeature_id: uuid(), geometry: { type: 'Point', coordinates: [0, 0] } });
    await assert.rejects(pending, error => error.code === 'storage_limit');
    assert.deepEqual(f.engine.temporary.peek(page.view_id), receipt);
    assert.equal((await f.call('GetObservationMovementHistory', request)).view_id, page.view_id);
    assert.equal((await f.call('GetObservationMovementHistory', { page_token: page.next_page_token })).readings.length, 1);
    assert.equal(f.engine.store.metrics.capture_expiries, 0);
  });
});
test('malformed capability signatures return allocation_expired over HTTP and valid tokens still work', async t => {
  const f = await fixture(t);
  const ok = response => { assert.equal(response.status, 200, JSON.stringify(response.json)); return response.json.data; };
  for (let i = 0; i < 2; i++) ok(await f.call('CreateGeofeature', { request_id: uuid(), geofeature_id: uuid(), geometry: { type: 'Point', coordinates: [i, i] } }));
  const health = ok(await f.call('GetHealth'));
  const request = { load_id: uuid(), allocation_context: health.allocation_context, page_size: 1, ...limits };
  const snapshot = ok(await f.call('ReadSnapshot', request));
  for (const signature of ['é'.repeat(43), '😀'.repeat(21) + 'a', 'a'.repeat(43), 'a']) {
    const malformed = `x.${signature}`;
    for (const [name, data] of [
      ['ReadSnapshot', { ...request, load_id: uuid(), allocation_context: malformed }],
      ['ReadSnapshot', { page_token: malformed }],
      ['ReleaseSnapshot', { release_token: malformed }],
    ]) {
      const response = await f.call(name, data);
      assert.equal(response.status, 410, JSON.stringify(response.json)); assert.equal(response.json.error.code, 'allocation_expired');
    }
  }
  assert.equal(ok(await f.call('ReadSnapshot', request)).capture_id, snapshot.capture_id);
  const continued = ok(await f.call('ReadSnapshot', { page_token: snapshot.next_page_token }));
  assert.equal(continued.items.length, 1); assert.notEqual(continued.items[0].resource_id, snapshot.items[0].resource_id);
  assert.equal(ok(await f.call('ReleaseSnapshot', { release_token: snapshot.release_token })).released, true);
});
test('retained picture and history captures keep a fixed source view while writes continue', { timeout: 120000 }, async t => {
  const f = await local(t);
  const integrity = path => {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try { assert.equal(db.pragma('integrity_check', { simple: true }), 'ok', path); }
    finally { db.close(); }
  };
  const expected = new Set();
  for (let i = 0; i < 4096; i++) {
    const geofeature_id = uuid(); expected.add(geofeature_id);
    await f.call('CreateGeofeature', { request_id: uuid(), geofeature_id, geometry: { type: 'Point', coordinates: [0, 0] } });
  }
  const health = await f.call('GetHealth');
  let finished = false;
  const capture = f.call('ReadSnapshot', { load_id: uuid(), allocation_context: health.allocation_context, page_size: 128, ...limits }).finally(() => { finished = true; });
  await building(f.engine, 'snapshot');
  const appended = uuid();
  await f.call('CreateGeofeature', { request_id: uuid(), geofeature_id: appended, geometry: { type: 'Point', coordinates: [1, 1] } });
  assert.equal(finished, false, 'A write must complete while the source view remains open');
  let page = await capture; const release = page.release_token, seen = new Set();
  for (;;) {
    for (const item of page.items) { assert.equal(seen.has(item.resource_id), false); seen.add(item.resource_id); }
    if (page.next_page_token === null) break;
    page = await f.call('ReadSnapshot', { page_token: page.next_page_token });
  }
  assert.deepEqual(seen, expected); assert.equal(seen.has(appended), false);
  integrity(join(f.directory, 'captures', `${page.capture_id}.sqlite`));
  await f.call('ReleaseSnapshot', { release_token: release });
  const observation = uuid(), publisher = uuid(), origin = { kind: 'publisher', publisher_id: publisher };
  await f.call('CreateObservation', { request_id: uuid(), observation_id: observation, publisher_id: publisher });
  const positions = new Set();
  for (let i = 0; i < 2048; i++) {
    const position = uuid(); positions.add(position);
    await f.call('ReportObservation', { observation_id: observation, publisher_id: publisher,
      report: report(f.engine.store.dataset, observation, origin, i + 1, { telemetry: telemetry(origin, 0, '2026-10-21T12:00:00Z', position) }) });
  }
  const historyHealth = await f.call('GetHealth');
  finished = false;
  const frozen = f.call('GetObservationMovementHistory', { query_id: uuid(), entity_id: observation, allocation_context: historyHealth.allocation_context, page_size: 128 }).finally(() => { finished = true; });
  await building(f.engine, 'history');
  await f.call('ReportObservation', { observation_id: observation, publisher_id: publisher,
    report: report(f.engine.store.dataset, observation, origin, 2049, { telemetry: telemetry(origin, 1) }) });
  assert.equal(finished, false, 'Reporting must continue while history membership is frozen');
  let history = await frozen; const historyRelease = history.release_token, observed = new Set();
  for (;;) {
    for (const reading of history.readings) { assert.equal(observed.has(reading.source_evidence.reading_id), false); observed.add(reading.source_evidence.reading_id); }
    if (history.next_page_token === null) break;
    history = await f.call('GetObservationMovementHistory', { page_token: history.next_page_token });
  }
  assert.deepEqual(observed, positions);
  integrity(join(f.directory, 'captures', `${history.view_id}.sqlite`));
  await f.call('ReleaseHistoryView', { release_token: historyRelease });
  integrity(f.engine.store.path);
  assert.deepEqual(await readdir(join(f.directory, 'captures')), []);
});
test('concurrent capture reservations respect aggregate bytes and retain failed outcomes', async t => {
  const f = await local(t, { max_snapshot_bytes: '131072', max_total_snapshot_bytes: '65536' });
  for (let i = 0; i < 64; i++) await f.call('CreateGeofeature', { request_id: uuid(), geofeature_id: uuid(), geometry: { type: 'Point', coordinates: [0, 0] } });
  const health = await f.call('GetHealth');
  const requests = Array.from({ length: 2 }, () => ({ load_id: uuid(), allocation_context: health.allocation_context, page_size: 100, ...limits }));
  let maximum = 0, done = false;
  const builds = Promise.allSettled(requests.map(request => f.call('ReadSnapshot', request))).finally(() => { done = true; });
  while (!done) { maximum = Math.max(maximum, f.engine.temporary.captureFiles().reduce((sum, file) => sum + file.bytes, 0)); await yieldToLoop(); }
  const results = await builds;
  assert.ok(maximum <= 65536);
  assert.ok(results.some(result => result.status === 'rejected'));
  const failed = results.findIndex(result => result.status === 'rejected');
  const failures = f.engine.store.metrics.capture_failures;
  await assert.rejects(f.call('ReadSnapshot', requests[failed]), error => error instanceof Refusal && error.code === 'resource_limit');
  assert.equal(f.engine.store.metrics.capture_failures, failures);
  for (const result of results) if (result.status === 'fulfilled') await f.call('ReleaseSnapshot', { release_token: result.value.release_token });
  assert.equal(f.engine.temporary.captureFiles().length, 0);
  const h = await local(t, { max_total_history_references: 6 });
  const observation = uuid(), publisher = uuid(), origin = { kind: 'publisher', publisher_id: publisher };
  await h.call('CreateObservation', { request_id: uuid(), observation_id: observation, publisher_id: publisher });
  for (let i = 1; i <= 4; i++) await h.call('ReportObservation', { observation_id: observation, publisher_id: publisher,
    report: report(h.engine.store.dataset, observation, origin, i, { telemetry: telemetry(origin, 0) }) });
  const historyHealth = await h.call('GetHealth');
  const histories = await Promise.allSettled(Array.from({ length: 2 }, () => h.call('GetObservationMovementHistory', { query_id: uuid(), entity_id: observation, allocation_context: historyHealth.allocation_context })));
  assert.equal(histories.filter(result => result.status === 'rejected' && result.reason.code === 'resource_limit').length, 1);
  assert.equal(histories.filter(result => result.status === 'fulfilled' && result.value.readings.length === 4).length, 1);
  assert.ok(h.engine.temporary.captureFiles().reduce((sum, file) => sum + file.refs, 0) <= 6);
});
test('preparation failures end their receipts and cleanup failures preserve both errors and charges', async t => {
  const f = await local(t);
  const health = await f.call('GetHealth');
  const request = { load_id: uuid(), allocation_context: health.allocation_context, page_size: 100, ...limits };
  await writeFile(join(f.directory, 'captures'), 'blocked directory');
  await assert.rejects(f.call('ReadSnapshot', request), error => publicError(error, f.engine.store.dataset).body.error.code === 'integrity_fault');
  const first = f.engine.temporary.receipts('snapshot')[0]; assert.equal(first.state, 'failed'); assert.equal(first.bytes, 0);
  await rm(join(f.directory, 'captures'));
  await assert.rejects(f.call('ReadSnapshot', request), error => error.code === 'integrity_fault');
  await assert.rejects(f.call('ReadSnapshot', { ...request, page_size: 1 }), error => error.code === 'allocation_conflict');
  await f.call('CreateGeofeature', { request_id: uuid(), geofeature_id: uuid(), geometry: { type: 'Point', coordinates: [0, 0] } });
  const directory = join(f.directory, 'cleanup-failure');
  let broken;
  const reads = new Reads(f.engine.store, f.engine.entities, f.engine.identity, f.engine.tasks, f.engine.objects, f.engine.temporary, directory, async reservation => {
    const receipt = f.engine.temporary.receipts('snapshot').find(receipt => receipt.state === 'building');
    if (!receipt) return f.engine.reserveStorage(reservation);
    broken = join(directory, `${receipt.id}.sqlite-shm`); await mkdir(broken);
    throw new Refusal('storage_limit');
  });
  const failedRequest = { ...request, load_id: uuid() };
  const initial = reads.snapshot(failedRequest, f.context.verifier).catch(error => error);
  const failedDeadline = performance.now() + 5000;
  while (f.engine.temporary.receipts('snapshot').find(receipt => receipt.request === failedRequest.load_id)?.state !== 'failed') { assert.ok(performance.now() < failedDeadline); await yieldToLoop(); }
  const retry = reads.snapshot(failedRequest, f.context.verifier).catch(error => error);
  for (const error of await Promise.all([initial, retry])) {
    assert.ok(error instanceof AggregateError && error.errors[0].code === 'storage_limit', 'Concurrent exact retries must wait for the same recorded cleanup outcome');
    assert.equal(publicError(new AggregateError([error, new Refusal('integrity_fault')]), f.engine.store.dataset).status, 507);
  }
  const charged = f.engine.temporary.receipts('snapshot').find(receipt => receipt.request === failedRequest.load_id);
  assert.equal(charged.state, 'failed'); assert.ok(charged.bytes > 0);
  const facts = JSON.parse(charged.data); assert.equal(facts.failure.body.error.code, 'storage_limit'); assert.equal(facts.cleanup_failure.body.error.code, 'integrity_fault');
  assert.equal(f.engine.temporary.captureFiles().length, 1);
  await assert.rejects(reads.snapshot(failedRequest, f.context.verifier), error => error instanceof AggregateError && error.errors[0].code === 'storage_limit');
  await rm(broken, { recursive: true }); await reads.close();
  assert.equal(f.engine.temporary.peek(charged.id).bytes, 0);
  assert.deepEqual(JSON.parse(f.engine.temporary.peek(charged.id).data), facts);
});
for (const transport of ['HTTP', 'WSS']) test(`worker capture failures preserve primary ${transport} errors, safe cleanup diagnostics and retry charges`, { timeout: 30000 }, async t => {
  // Run the native driver unchanged, then inject real filesystem faults before the next reservation.
  const preload = `
    import Database from ${JSON.stringify(import.meta.resolve('better-sqlite3'))};
    import { mkdirSync, writeFileSync, truncateSync } from 'node:fs';
    import { dirname, join } from 'node:path';
    import { workerData } from 'node:worker_threads';
    if (workerData?.directory) {
      const pragma = Database.prototype.pragma;
      Database.prototype.pragma = function (...args) {
        const result = Reflect.apply(pragma, this, args);
        if (this.readonly || dirname(this.name) !== join(workerData.directory, 'captures')) return result;
        Database.prototype.pragma = pragma;
        mkdirSync(this.name + '-shm');
        const pressure = join(workerData.directory, 'private-pressure-sentinel.bin');
        writeFileSync(pressure, 'pressure');
        truncateSync(pressure, workerData.settings.storageBytes);
        return result;
      };
    }
  `;
  if (process.env.ATLAS_CAPTURE_FAULT !== '1') {
    const env = { ...process.env, ATLAS_CAPTURE_FAULT: '1' };
    delete env.NODE_TEST_CONTEXT;
    try {
      const { stdout } = await promisify(execFile)(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, '--test', '--test-reporter=tap',
        `--test-name-pattern=^worker capture failures preserve primary ${transport} errors`, fileURLToPath(import.meta.url)],
      { cwd: root, env, signal: t.signal });
      assert.match(stdout, /^# tests 1$/m);
      assert.match(stdout, /^# pass 1$/m);
    } catch (error) { throw new Error(`${error.stdout ?? ''}${error.stderr ?? ''}`, { cause: error }); }
    return;
  }
  const cleanup = [];
  let directory, pressure;
  t.after(async () => {
    if (directory) for (const file of await readdir(join(directory, 'captures'), { withFileTypes: true })) {
      if (file.isDirectory() && /^[0-9a-f-]{36}\.sqlite-shm$/.test(file.name)) await rm(join(directory, 'captures', file.name), { recursive: true });
    }
    if (pressure) await rm(pressure, { force: true });
    for (const close of cleanup.reverse()) await close();
  });
  const f = await fixture({ after: fn => cleanup.push(fn) }, { storageBytes: 64 * 1024 * 1024, objectBytes: 16 * 1024 * 1024, reserveBytes: 1024 * 1024 });
  directory = f.directory;
  pressure = join(directory, 'private-pressure-sentinel.bin');
  const ok = response => { assert.equal(response.status, 200, JSON.stringify(response.json)); return response.json.data; };
  for (let i = 0; i < 256; i++) ok(await f.call('CreateGeofeature', { request_id: uuid(), geofeature_id: uuid(),
    geometry: { type: 'Point', coordinates: [0, 0] }, description: { name: 'Retained', description: 'x'.repeat(4096) } }));
  const health = ok(await f.call('GetHealth'));
  const request = { load_id: uuid(), allocation_context: health.allocation_context, page_size: 100, ...limits };
  let snapshot = async () => {
    const response = await f.call('ReadSnapshot', request);
    assert.equal(response.status, 507, JSON.stringify({ status: response.status, error: response.json.error }));
    return response.json.error;
  };
  if (transport === 'WSS') {
    const socket = new WebSocket(f.address.replace('https:', 'wss:') + '/changes', { ca: f.ca });
    cleanup.push(() => socket.terminate());
    await once(socket, 'open', { signal: AbortSignal.timeout(10000) });
    const control = async frame => {
      const response = once(socket, 'message', { signal: AbortSignal.timeout(10000) });
      socket.send(writeWssClient({ ...frame, dataset_id: f.core.dataset, protocol_version: '0.1.0' }), { binary: false });
      const [bytes] = await response;
      return readWssServer(bytes, { datasetId: f.core.dataset, requestId: frame.request_id });
    };
    assert.equal((await control({ type: 'authenticate', request_id: uuid(), api_key: f.apiKey })).type, 'authenticated');
    snapshot = async () => {
      const response = await control({ type: 'read_snapshot', request_id: uuid(), data: request });
      assert.equal(response.type, 'error', JSON.stringify({ type: response.type, error: response.error }));
      return response.error;
    };
  }
  const failures = [];
  f.core.rpc.worker.on('message', message => { if (message.type === 'refusal') failures.push(message); });
  const initial = await snapshot();
  assert.equal(initial.code, 'storage_limit'); assert.equal('details' in initial, false);
  const db = new Database(join(f.directory, 'core.sqlite'), { readonly: true });
  let charged;
  try {
    charged = db.prepare('SELECT * FROM temporary_receipts WHERE request=?').get(request.load_id);
    assert.equal(charged.state, 'failed'); assert.ok(charged.bytes > 0);
    const facts = JSON.parse(charged.data);
    assert.equal(facts.failure.body.error.code, 'storage_limit'); assert.equal(facts.cleanup_failure.body.error.code, 'integrity_fault');
    const retry = await snapshot();
    assert.equal(retry.code, 'storage_limit'); assert.equal('details' in retry, false);
    assert.deepEqual(db.prepare('SELECT * FROM temporary_receipts WHERE request=?').get(request.load_id), charged);
    assert.equal(db.prepare('SELECT bytes FROM temporary_files WHERE id=?').get(charged.id).bytes, charged.bytes);
  } finally { db.close(); }
  const broken = join(directory, 'captures', `${charged.id}.sqlite-shm`);
  assert.ok((await readdir(join(directory, 'captures'), { withFileTypes: true })).some(file => file.name === `${charged.id}.sqlite-shm` && file.isDirectory()));
  for (const failure of failures) {
    assert.deepEqual(failure.causes.map(cause => cause.body.error.code), ['storage_limit', 'integrity_fault']);
    assert.deepEqual(Object.keys(failure).sort(), ['causes', 'error', 'id', 'type']);
  }
  assert.equal(failures.length, 2);
  assert.ok(!JSON.stringify(failures).includes(f.directory)); assert.ok(!JSON.stringify(failures).includes(f.apiKey));
  await rm(broken, { recursive: true }); await rm(pressure); await f.core.close();
  let logs = '';
  for (const name of await readdir(join(f.directory, 'logs'))) logs += await readFile(join(f.directory, 'logs', name), 'utf8');
  const events = logs.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.filter(event => event.event === 'primary_failure' && event.code === 'storage_limit').length >= 2);
  assert.ok(events.filter(event => event.event === 'cleanup_failure' && event.code === 'integrity_fault').length >= 2);
  assert.ok(!logs.includes(f.directory)); assert.ok(!logs.includes(f.apiKey)); assert.ok(!logs.includes('ERR_FS_EISDIR'));
});
test('release persists successful reclamation before revocation refuses its response', async t => {
  const f = await local(t);
  const health = await f.call('GetHealth');
  const snapshot = await f.call('ReadSnapshot', { load_id: uuid(), allocation_context: health.allocation_context, page_size: 100, ...limits });
  let changed;
  const reclaimed = new Promise(resolve => { changed = resolve; });
  const watcher = watch(join(f.directory, 'captures'), (event, file) => {
    if (event !== 'rename' || file !== `${snapshot.capture_id}.sqlite`) return;
    watcher.close(); f.engine.store.transact(null, tx => f.engine.identity.revoke(tx, f.key.api_key_id)); changed();
  });
  t.after(() => watcher.close());
  const result = f.call('ReleaseSnapshot', { release_token: snapshot.release_token });
  await assert.rejects(result, error => error.code === 'unauthorized'); await reclaimed;
  const receipt = f.engine.temporary.peek(snapshot.capture_id);
  assert.equal(receipt.state, 'released'); assert.equal(receipt.bytes, 0); assert.equal(receipt.refs, 0);
  assert.deepEqual(f.engine.temporary.captureFiles(), []);
  f.engine.store.db.prepare('UPDATE temporary_receipts SET deadline=0 WHERE id=?').run(snapshot.capture_id);
  await f.engine.reads.cleanup(); assert.equal(f.engine.temporary.peek(snapshot.capture_id), undefined);
});
