import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { Engine } from '../dist/engine.js';
import { Reads } from '../dist/reads.js';
import { defaults } from '../dist/settings.js';
import { digest } from '../dist/exact.js';
import { publicError, Refusal } from '../dist/fault.js';
import { root, uuid, secret, report, telemetry } from './helpers.mjs';

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
test('retained picture and history captures keep a fixed source view while writes continue', { timeout: 120000 }, async t => {
  const f = await local(t);
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
  await f.call('ReleaseHistoryView', { release_token: historyRelease });
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
  const directory = join(f.directory, 'cleanup-failure');
  let broken;
  const reads = new Reads(f.engine.store, f.engine.entities, f.engine.identity, f.engine.tasks, f.engine.objects, f.engine.temporary, directory, async () => {
    const receipt = f.engine.temporary.receipts('snapshot').find(receipt => receipt.state === 'building'); assert.ok(receipt);
    broken = join(directory, `${receipt.id}.sqlite`); await mkdir(broken);
    throw new Refusal('storage_limit');
  });
  const failedRequest = { ...request, load_id: uuid() };
  await assert.rejects(reads.snapshot(failedRequest, f.context.verifier), error => error instanceof AggregateError && error.errors[0].code === 'storage_limit');
  const charged = f.engine.temporary.receipts('snapshot').find(receipt => receipt.request === failedRequest.load_id);
  assert.equal(charged.state, 'failed'); assert.ok(charged.bytes > 0);
  const facts = JSON.parse(charged.data); assert.equal(facts.failure.body.error.code, 'storage_limit'); assert.equal(facts.cleanup_failure.body.error.code, 'integrity_fault');
  assert.equal(f.engine.temporary.captureFiles().length, 1);
  await assert.rejects(reads.snapshot(failedRequest, f.context.verifier), error => error instanceof AggregateError && error.errors[0].code === 'storage_limit');
  await rm(broken, { recursive: true }); await reads.close();
  assert.equal(f.engine.temporary.peek(charged.id).bytes, 0);
  assert.deepEqual(JSON.parse(f.engine.temporary.peek(charged.id).data), facts);
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
  f.engine.temporary.expire(); assert.equal(f.engine.temporary.peek(snapshot.capture_id), undefined);
});
