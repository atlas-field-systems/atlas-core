import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../dist/engine.js';
import { fixture, uuid, registration } from './helpers.mjs';
const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.data; };
test('ended assigned polls reclaim full contexts and retain compact identity protection until Reset', async t => {
  const f = await fixture(t), asset = ok(await f.call('RegisterAsset', registration())).asset;
  const requests = [], snapshots = [];
  let cleanupReads = 0;
  for (const queued of [0, 20]) {
    for (let i = 0; i < queued; i++) ok(await f.call('CreateTask', { task_id: uuid(), request_id: uuid(), asset_id: asset.id,
      command: 'move_to', scheduling: 'queued', inputs: { target: { kind: 'position', position: { latitude: i, longitude: 0 } } } }));
    for (let i = 0; i < 8; i++) {
      const request = { asset_id: asset.id, process_generation: asset.process_generation, read_id: uuid(), page_size: 2 };
      const read = ok(await f.call('GetAssignedTasks', request));
      assert.equal(read.task_queue.requested_task_ids.length, queued);
      assert.deepEqual(ok(await f.call('GetAssignedTasks', request)), read);
      if (read.next_page_token) {
        const page = ok(await f.call('GetAssignedTasks', { page_token: read.next_page_token }));
        assert.deepEqual(page.task_queue, read.task_queue); assert.equal(page.captured_at, read.captured_at);
      }
      requests.push(request);
    }
    await f.restart();
    ok(await f.call('GetAssignedTasks', { asset_id: asset.id, process_generation: asset.process_generation, read_id: uuid() }));
    cleanupReads++;
    const db = new Database(join(f.directory, 'core.sqlite'), { readonly: true });
    try {
      assert.equal(db.prepare('SELECT count(*) AS count FROM task_instructions').get().count, 1);
      assert.equal(db.prepare('SELECT count(*) AS count FROM task_instruction_lifetime').get().count, 1);
      const retained = db.prepare('SELECT count(*) AS count, sum(length(read_id)+length(facts)+coalesce(length(proof),0)) AS bytes, count(proof) AS proofs FROM task_instruction_receipts').get();
      assert.equal(retained.count, requests.length + cleanupReads); assert.equal(retained.bytes, 100 * (requests.length + cleanupReads)); assert.equal(retained.proofs, 0);
      snapshots.push({ queued, ...retained });
    } finally { db.close(); }
    for (const request of requests) {
      assert.equal((await f.call('GetAssignedTasks', request)).json.error.code, 'allocation_expired');
      assert.equal((await f.call('GetAssignedTasks', { ...request, page_size: 3 })).json.error.code, 'identity_conflict');
    }
  }
  t.diagnostic(JSON.stringify(snapshots));
  await f.core.close();
  const engine = new Engine(f.directory, f.settings);
  try {
    engine.establish(uuid(), uuid(), false);
    assert.equal(engine.store.db.prepare('SELECT count(*) AS count FROM task_instruction_receipts').get().count, 0);
  } finally { await engine.close(); }
});
test('incompatible stores preserve assigned contexts and Resume proof on refused startup', async t => {
  const f = await fixture(t), asset = ok(await f.call('RegisterAsset', registration())).asset;
  ok(await f.call('CreateTask', { task_id: uuid(), request_id: uuid(), asset_id: asset.id, command: 'resume', scheduling: 'immediate', inputs: {}, expires_at: new Date(Date.now() + 59000).toISOString() }));
  ok(await f.call('GetAssignedTasks', { asset_id: asset.id, process_generation: asset.process_generation, read_id: uuid() }));
  await f.core.close();
  const db = new Database(join(f.directory, 'core.sqlite'));
  try {
    const contexts = db.prepare('SELECT * FROM task_instructions').all();
    const receipts = db.prepare('SELECT * FROM task_instruction_receipts').all();
    assert.equal(contexts.length, 1); assert.equal(receipts.length, 1);
    assert.match(receipts[0].proof, /^[0-9a-f]{64}$/);
    db.prepare("UPDATE core_meta SET value='1' WHERE key='format'").run();
    await assert.rejects(f.restart(), /database_worker_failed/);
    assert.equal(db.prepare("SELECT value FROM core_meta WHERE key='format'").get().value, '1');
    assert.deepEqual(db.prepare('SELECT * FROM task_instructions').all(), contexts);
    assert.deepEqual(db.prepare('SELECT * FROM task_instruction_receipts').all(), receipts);
  } finally { db.close(); }
});
for (const pendingSecondCancellation of [false, true]) {
  test(`cancellation retries recover refused intent with ${pendingSecondCancellation ? 'a later cancellation pending' : 'no cancellation pending'} across Restart`, async t => {
    const f = await fixture(t);
    const asset = ok(await f.call('RegisterAsset', registration())).asset;
    const task = ok(await f.call('CreateTask', { task_id: uuid(), request_id: uuid(), asset_id: asset.id, command: 'move_to', scheduling: 'queued', inputs: { target: { kind: 'position', position: { latitude: 0, longitude: 0 } } } }));
    const request = { task_id: task.task_id, request_id: uuid() };
    const first = await f.call('RequestTaskCancellation', request);
    const accepted = ok(first);
    assert.equal(accepted.cancellation_request_id, request.request_id);
    const refused = await f.call('ReportTaskExecution', { evidence: { dataset_id: f.core.dataset, asset_id: asset.id,
      origin: { kind: 'asset_process', process_generation: asset.process_generation }, report_id: uuid(), sequence: '1', generated_at: null,
      payload: { task_id: task.task_id, event: 'cancellation_refused', state: 'pending', cancellation_request_id: request.request_id, reason: 'cannot_cancel' } } });
    assert.equal(ok(refused).task.cancellation_request_id, null);
    const laterRequest = { task_id: task.task_id, request_id: uuid() };
    const latest = pendingSecondCancellation ? await f.call('RequestTaskCancellation', laterRequest) : refused;
    ok(latest);
    const current = ok(await f.call('GetTask', { task_id: task.task_id }));
    const currentAsset = ok(await f.call('GetAsset', { asset_id: asset.id }));
    assert.equal(current.cancellation_request_id, pendingSecondCancellation ? laterRequest.request_id : null);
    for (const restart of [false, true]) {
      if (restart) await f.restart();
      const replay = await f.call('RequestTaskCancellation', request);
      assert.deepEqual(ok(replay), accepted);
      assert.equal(replay.json.commit_cursor, first.json.commit_cursor);
      assert.deepEqual(ok(await f.call('GetTask', { task_id: task.task_id })), current);
      assert.deepEqual(ok(await f.call('GetAsset', { asset_id: asset.id })), currentAsset);
      const changes = ok(await f.call('ReadChanges', { from_cursor: latest.json.commit_cursor, max_message_bytes: 4194304, max_json_values: 262144, max_changes: 1000 }));
      assert.deepEqual(changes.messages, []);
    }
  });
}
test('held cancellation slots, independent streams, late terminal evidence and permanent result holds', async t => {
  const f = await fixture(t);
  const asset = ok(await f.call('RegisterAsset', registration())).asset;
  const evidence = (task, sequence, payload) => ({ dataset_id: f.core.dataset, asset_id: asset.id, origin: { kind: 'asset_process', process_generation: asset.process_generation }, report_id: uuid(), sequence: String(sequence), generated_at: null, payload: { task_id: task.task_id, ...payload } });
  async function move() { return ok(await f.call('CreateTask', { task_id: uuid(), request_id: uuid(), asset_id: asset.id, command: 'move_to', scheduling: 'queued', inputs: { target: { kind: 'position', position: { latitude: 0, longitude: 0 } } } })); }
  const a = await move(), b = await move(), c = await move();
  const cancellation = uuid(); ok(await f.call('RequestTaskCancellation', { task_id: b.task_id, request_id: cancellation }));
  let current = ok(await f.call('GetAsset', { asset_id: asset.id }));
  ok(await f.call('SetTaskOrder', { request_id: uuid(), asset_id: asset.id, expected_queue_revision: current.task_queue.revision, task_ids: [c.task_id, a.task_id] }));
  current = ok(await f.call('GetAsset', { asset_id: asset.id }));
  assert.deepEqual(current.task_queue.requested_task_ids, [c.task_id, b.task_id, a.task_id]);
  ok(await f.call('ReportTaskExecution', { evidence: evidence(b, 50, { event: 'state', state: 'acknowledged' }) }));
  let task = ok(await f.call('GetTask', { task_id: b.task_id }));
  assert.equal(task.cancellation_request_id, cancellation); assert.equal(task.execution_state, 'acknowledged');
  const refusal = evidence(b, 10, { event: 'cancellation_refused', state: 'pending', cancellation_request_id: cancellation, reason: 'cannot_cancel' });
  ok(await f.call('ReportTaskExecution', { evidence: refusal }));
  task = ok(await f.call('GetTask', { task_id: b.task_id })); assert.equal(task.execution_state, 'acknowledged'); assert.equal(task.cancellation_request_id, null);
  const result1 = { object_id: uuid(), required: true }, result2 = { object_id: uuid(), required: false };
  ok(await f.call('ReportTaskResults', { evidence: evidence(b, 11, { declarations: [result1] }) }));
  ok(await f.call('ReportTaskResults', { evidence: evidence(b, 10, { declarations: [result2] }) }));
  const finish = evidence(b, 9, { event: 'state', state: 'completed' });
  ok(await f.call('ReportTaskExecution', { evidence: finish }));
  assert.equal(ok(await f.call('GetTask', { task_id: b.task_id })).execution_state, 'completed');
  assert.equal((await f.call('ReportTaskExecution', { evidence: evidence(b, 51, { event: 'state', state: 'failed', reason: 'late_conflict' }) })).json.error.code, 'terminal_state_conflict');
  const snapshotTask = ok(await f.call('GetTask', { task_id: b.task_id })); assert.deepEqual(snapshotTask.result_declarations, [result1, result2]);
  assert.equal(ok(await f.call('ReportTaskExecution', { evidence: finish })).evidence_disposition, 'duplicate');
  ok(await f.call('DeleteAsset', { asset_id: asset.id, request_id: uuid() }));
  assert.equal((await f.call('ReportTaskExecution', { evidence: evidence(a, 1, { event: 'state', state: 'completed' }) })).json.error.code, 'asset_not_found');
  assert.equal(ok(await f.call('GetTask', { task_id: a.task_id })).execution_state, 'pending');
});
test('Pause and fresh Resume effects commit with ordered Asset confirmations', async t => {
  const f = await fixture(t); const asset = ok(await f.call('RegisterAsset', registration())).asset;
  const evidence = (task, payload) => ({ dataset_id: f.core.dataset, asset_id: asset.id, origin: { kind: 'asset_process', process_generation: asset.process_generation }, report_id: uuid(), sequence: '1', generated_at: null, payload: { task_id: task.task_id, event: 'state', state: 'completed', ...payload } });
  const pause = ok(await f.call('CreateTask', { task_id: uuid(), request_id: uuid(), asset_id: asset.id, command: 'pause', scheduling: 'immediate', inputs: {} }));
  ok(await f.call('ReportTaskExecution', { evidence: evidence(pause, { control_revision: '1', queue_state: 'paused', applied_at: new Date().toISOString() }) }));
  const resume = ok(await f.call('CreateTask', { task_id: uuid(), request_id: uuid(), asset_id: asset.id, command: 'resume', scheduling: 'immediate', inputs: {}, expires_at: new Date(Date.now() + 60000).toISOString() }));
  const read = ok(await f.call('GetAssignedTasks', { asset_id: asset.id, process_generation: asset.process_generation, read_id: uuid(), page_size: 1 }));
  if (read.next_page_token) ok(await f.call('GetAssignedTasks', { page_token: read.next_page_token }));
  const resumeEvidence = evidence(resume, { control_revision: '2', queue_state: 'running', applied_at: new Date().toISOString(), read_id: read.read_id, core_run_id: read.core_run_id, captured_at: read.captured_at, instructions_valid_until: read.instructions_valid_until, queue_revision: read.task_queue.revision });
  ok(await f.call('ReportTaskExecution', { evidence: resumeEvidence }));
  const current = ok(await f.call('GetAsset', { asset_id: asset.id }));
  assert.equal(current.task_control.confirmed.revision, '2'); assert.equal(current.task_control.confirmed.queue_state, 'running');
});
test('retained Tasks accept exact creation retries and cancellation after Asset deletion', async t => {
  const f = await fixture(t);
  const asset = ok(await f.call('RegisterAsset', registration())).asset;
  const request = { task_id: uuid(), request_id: uuid(), asset_id: asset.id, command: 'move_to', scheduling: 'queued', inputs: { target: { kind: 'position', position: { latitude: 0, longitude: 0 } } } };
  const created = await f.call('CreateTask', request); const task = ok(created);
  ok(await f.call('DeleteAsset', { asset_id: asset.id, request_id: uuid() }));
  const retried = await f.call('CreateTask', request);
  assert.deepEqual(ok(retried), task); assert.equal(retried.json.commit_cursor, created.json.commit_cursor);
  assert.equal((await f.call('CreateTask', { ...request, request_id: uuid(), task_id: uuid() })).json.error.code, 'asset_not_found');
  const cancellation = { task_id: task.task_id, request_id: uuid() };
  const cancelled = ok(await f.call('RequestTaskCancellation', cancellation));
  assert.equal(cancelled.cancellation_request_id, cancellation.request_id); assert.equal(cancelled.execution_state, 'pending');
  assert.deepEqual(ok(await f.call('RequestTaskCancellation', cancellation)), cancelled);
  const evidence = { dataset_id: f.core.dataset, asset_id: asset.id, origin: { kind: 'asset_process', process_generation: asset.process_generation }, report_id: uuid(), sequence: '1', generated_at: null, payload: { task_id: task.task_id, event: 'state', state: 'completed' } };
  assert.equal((await f.call('ReportTaskExecution', { evidence })).json.error.code, 'asset_not_found');
  assert.equal((await f.call('ReportTaskResults', { evidence: { ...evidence, payload: { task_id: task.task_id, declarations: [{ object_id: uuid(), required: false }] } } })).json.error.code, 'asset_not_found');
});
test('delayed cancellation refusal clears intent without rolling back started work or its queue', async t => {
  const f = await fixture(t); const asset = ok(await f.call('RegisterAsset', registration())).asset;
  const task = ok(await f.call('CreateTask', { task_id: uuid(), request_id: uuid(), asset_id: asset.id, command: 'move_to', scheduling: 'queued', inputs: { target: { kind: 'position', position: { latitude: 0, longitude: 0 } } } }));
  const cancellation = uuid(); ok(await f.call('RequestTaskCancellation', { task_id: task.task_id, request_id: cancellation }));
  const evidence = (sequence, payload) => ({ dataset_id: f.core.dataset, asset_id: asset.id, origin: { kind: 'asset_process', process_generation: asset.process_generation }, report_id: uuid(), sequence, generated_at: null, payload: { task_id: task.task_id, ...payload } });
  const refusal = evidence('10', { event: 'cancellation_refused', state: 'pending', reason: 'cannot_cancel', cancellation_request_id: cancellation });
  ok(await f.call('ReportTaskExecution', { evidence: evidence('50', { event: 'state', state: 'in_progress' }) }));
  const started = ok(await f.call('GetAsset', { asset_id: asset.id }));
  assert.deepEqual(started.task_queue.requested_task_ids, []);
  const response = ok(await f.call('ReportTaskExecution', { evidence: refusal }));
  assert.equal(response.evidence_disposition, 'accepted');
  assert.equal(response.task.execution_state, 'in_progress'); assert.equal(response.task.cancellation_request_id, null);
  assert.deepEqual(ok(await f.call('GetAsset', { asset_id: asset.id })), started);
  assert.equal(ok(await f.call('ReportTaskExecution', { evidence: refusal })).evidence_disposition, 'duplicate');
});
test('pending cancellation refusal cannot restore a started Move To to an absent queue slot', async t => {
  const f = await fixture(t); const asset = ok(await f.call('RegisterAsset', registration())).asset;
  const task = ok(await f.call('CreateTask', { task_id: uuid(), request_id: uuid(), asset_id: asset.id, command: 'move_to', scheduling: 'queued', inputs: { target: { kind: 'position', position: { latitude: 0, longitude: 0 } } } }));
  const evidence = payload => ({ dataset_id: f.core.dataset, asset_id: asset.id, origin: { kind: 'asset_process', process_generation: asset.process_generation }, report_id: uuid(), sequence: '1', generated_at: null, payload: { task_id: task.task_id, ...payload } });
  ok(await f.call('ReportTaskExecution', { evidence: evidence({ event: 'state', state: 'in_progress' }) }));
  const cancellation = uuid(); ok(await f.call('RequestTaskCancellation', { task_id: task.task_id, request_id: cancellation }));
  const refusal = { ...evidence({ event: 'cancellation_refused', state: 'pending', reason: 'cannot_cancel', cancellation_request_id: cancellation }), sequence: '2' };
  assert.equal((await f.call('ReportTaskExecution', { evidence: refusal })).json.error.code, 'invalid_request');
  let current = ok(await f.call('GetTask', { task_id: task.task_id }));
  assert.equal(current.execution_state, 'in_progress'); assert.equal(current.cancellation_request_id, cancellation);
  assert.deepEqual(ok(await f.call('GetAsset', { asset_id: asset.id })).task_queue.requested_task_ids, []);
  ok(await f.call('ReportTaskExecution', { evidence: { ...refusal, payload: { ...refusal.payload, state: 'in_progress' } } }));
  current = ok(await f.call('GetTask', { task_id: task.task_id })); assert.equal(current.execution_state, 'in_progress'); assert.equal(current.cancellation_request_id, null);
});
test('delayed proven Resume survives page expiry and Restart while old reads cannot become fresh', { timeout: 90000 }, async t => {
  const f = await fixture(t); const asset = ok(await f.call('RegisterAsset', registration())).asset;
  ok(await f.call('CreateTask', { task_id: uuid(), request_id: uuid(), asset_id: asset.id, command: 'move_to', scheduling: 'queued', inputs: { target: { kind: 'position', position: { latitude: 0, longitude: 0 } } } }));
  const created = await f.call('CreateTask', { task_id: uuid(), request_id: uuid(), asset_id: asset.id, command: 'resume', scheduling: 'immediate', inputs: {}, expires_at: new Date(Date.now() + 59000).toISOString() });
  const resume = ok(created);
  const request = { asset_id: asset.id, process_generation: asset.process_generation, read_id: uuid(), page_size: 1 };
  const read = ok(await f.call('GetAssignedTasks', request));
  assert.ok(read.next_page_token);
  assert.equal(ok(await f.call('GetAssignedTasks', { page_token: read.next_page_token })).next_page_token, null);
  const evidence = { dataset_id: f.core.dataset, asset_id: asset.id, origin: { kind: 'asset_process', process_generation: asset.process_generation }, report_id: uuid(), sequence: '1', generated_at: null,
    payload: { task_id: resume.task_id, event: 'state', state: 'completed', control_revision: read.task_control.revision, queue_state: 'running', applied_at: new Date().toISOString(), read_id: read.read_id, core_run_id: read.core_run_id, captured_at: read.captured_at, instructions_valid_until: read.instructions_valid_until, queue_revision: read.task_queue.revision } };
  await delay(61000);
  assert.equal((await f.call('GetAssignedTasks', request)).json.error.code, 'allocation_expired');
  assert.equal((await f.call('GetAssignedTasks', { page_token: read.next_page_token })).json.error.code, 'allocation_expired');
  const afterExpiry = ok(await f.call('GetAssignedTasks', { ...request, read_id: uuid() }));
  const db = new Database(join(f.directory, 'core.sqlite'), { readonly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS count FROM task_instructions WHERE read_id=?').get(read.read_id).count, 0);
    assert.equal(db.prepare('SELECT count(*) AS count FROM task_instruction_lifetime WHERE read_id=?').get(read.read_id).count, 0);
  } finally { db.close(); }
  assert.equal(afterExpiry.core_run_id, read.core_run_id);
  await f.restart();
  assert.equal((await f.call('GetAssignedTasks', request)).json.error.code, 'allocation_expired');
  const fresh = ok(await f.call('GetAssignedTasks', { ...request, read_id: uuid() }));
  assert.notEqual(fresh.core_run_id, read.core_run_id); assert.notEqual(fresh.read_id, read.read_id);
  assert.deepEqual(ok(await f.call('ReadChanges', { from_cursor: created.json.commit_cursor, max_message_bytes: 4194304, max_json_values: 262144, max_changes: 1000 })).messages, []);
  for (const changed of [{ read_id: fresh.read_id }, { core_run_id: fresh.core_run_id }, { queue_revision: String(BigInt(read.task_queue.revision) + 1n) }, { control_revision: '2' },
    { captured_at: new Date(Date.parse(read.captured_at) - 1).toISOString() }, { instructions_valid_until: new Date(Date.parse(read.instructions_valid_until) - 1).toISOString() }]) {
    const forged = { ...evidence, payload: { ...evidence.payload, ...changed } };
    assert.equal((await f.call('ReportTaskExecution', { evidence: forged })).json.error.code, 'control_not_confirmed');
  }
  assert.equal(ok(await f.call('ReportTaskExecution', { evidence })).task.execution_state, 'completed');
  assert.equal(ok(await f.call('GetAsset', { asset_id: asset.id })).task_control.confirmed.queue_state, 'running');
});
test('Task summaries follow selected evidence through current reads, synchronization and Restart', async t => {
  const limits = { max_message_bytes: 4194304, max_json_values: 262144, max_changes: 1000 };
  const f = await fixture(t), registered = registration();
  const asset = ok(await f.call('RegisterAsset', registered)).asset;
  const origin = { kind: 'asset_process', process_generation: asset.process_generation };
  const feature = ok(await f.call('CreateGeofeature', { request_id: uuid(), geofeature_id: uuid(), geometry: { type: 'Point', coordinates: [1, 1] } }));
  const task = ok(await f.call('CreateTask', { request_id: uuid(), task_id: uuid(), asset_id: asset.id, command: 'move_to', scheduling: 'queued', inputs: { target: { kind: 'geofeature', geofeature_id: feature.id } } }));
  assert.equal(task.execution_summary, null);
  const health = ok(await f.call('GetHealth'));
  const baseline = ok(await f.call('ReadSnapshot', { load_id: uuid(), allocation_context: health.allocation_context, page_size: 100, ...limits }));
  ok(await f.call('ReleaseSnapshot', { release_token: baseline.release_token }));
  const make = (sequence, payload) => ({ dataset_id: f.core.dataset, asset_id: asset.id, origin, report_id: uuid(), sequence,
    generated_at: '2026-10-21T12:00:00.000000123Z', payload: { task_id: task.task_id, ...payload } });
  const summary = evidence => {
    const { task_id, ...payload } = evidence.payload;
    return { origin, report_id: evidence.report_id, sequence: evidence.sequence, generated_at: evidence.generated_at, ...payload };
  };
  const send = async evidence => ok(await f.call('ReportTaskExecution', { evidence })).task;
  const first = make('9007199254740993', { event: 'state', state: 'in_progress', geometry_revision: '0', message: 'Moving' });
  const firstTask = await send(first);
  assert.deepEqual(firstTask.execution_summary, summary(first));
  ok(await f.call('EditGeofeature', { request_id: uuid(), geofeature_id: feature.id, expected_edit_revision: feature.edit_revision, edits: { geometry: { type: 'Point', coordinates: [2, 2] } } }));
  const later = make('9007199254740995', { event: 'state', state: 'in_progress', geometry_revision: '0', message: 'Route blocked' });
  const laterTask = await send(later);
  assert.deepEqual(laterTask.execution_summary, summary(later));
  assert.ok(BigInt(laterTask.version) > BigInt(firstTask.version), 'New metadata in the same state must publish');
  const cancellation = { request_id: uuid(), task_id: task.task_id };
  assert.deepEqual(ok(await f.call('RequestTaskCancellation', cancellation)).execution_summary, summary(later));
  const stale = make('9007199254740994', { event: 'cancellation_refused', state: 'acknowledged', cancellation_request_id: cancellation.request_id, reason: 'already_started' });
  const cleared = await send(stale);
  assert.equal(cleared.cancellation_request_id, null);
  assert.deepEqual(cleared.execution_summary, summary(later));
  assert.deepEqual((await send(first)).execution_summary, summary(later));
  const omitted = make('9007199254740996', { event: 'state', state: 'in_progress' }); omitted.generated_at = null;
  assert.deepEqual((await send(omitted)).execution_summary, summary(omitted));
  const readViews = async (expected, active) => {
    assert.deepEqual(ok(await f.call('GetTask', { task_id: task.task_id })).execution_summary, expected);
    assert.deepEqual(ok(await f.call('ListTasks', { filters: { ids: [task.task_id] } })).items[0].execution_summary, expected);
    const assigned = ok(await f.call('GetAssignedTasks', { asset_id: asset.id, process_generation: asset.process_generation, read_id: uuid() }));
    if (active) assert.deepEqual(assigned.tasks.find(value => value.task_id === task.task_id).execution_summary, expected);
    else assert.equal(assigned.tasks.some(value => value.task_id === task.task_id), false);
    const health = ok(await f.call('GetHealth'));
    const snapshot = ok(await f.call('ReadSnapshot', { load_id: uuid(), allocation_context: health.allocation_context, page_size: 100, ...limits }));
    assert.deepEqual(snapshot.items.find(value => value.resource_id === task.task_id).image.execution_summary, expected);
    ok(await f.call('ReleaseSnapshot', { release_token: snapshot.release_token }));
  };
  await readViews(summary(omitted), true);
  const failed = make('9007199254740997', { event: 'state', state: 'failed', reason: 'target_unreachable', message: 'Fence blocked route', geometry_revision: '0' });
  const terminal = await send(failed);
  assert.deepEqual(terminal.execution_summary, summary(failed));
  const repeated = await send({ ...failed, report_id: uuid(), sequence: '9007199254740998' });
  assert.equal(repeated.version, terminal.version);
  assert.deepEqual(repeated.execution_summary, summary(failed));
  assert.deepEqual((await send(failed)).execution_summary, summary(failed));
  await f.restart();
  await readViews(summary(failed), false);
  const changes = ok(await f.call('ReadChanges', { from_cursor: baseline.baseline_cursor, ...limits }));
  const images = changes.messages.flatMap(message => message.type === 'change_batch' ? message.data.changes.filter(change => change.kind === 'put' && change.resource_id === task.task_id).map(change => change.image) : []);
  assert.ok(images.some(image => image.execution_summary?.report_id === later.report_id));
  assert.deepEqual(images.at(-1).execution_summary, summary(failed));
});
