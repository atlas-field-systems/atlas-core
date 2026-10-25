import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as s from '../../../Atlas Protocol/test/samples.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../../..');
const output = mkdtempSync(join(directory, '.rules-'));
after(() => rmSync(output, { recursive: true, force: true }));
const native = join(output, 'rules');
const bend = process.env.BEND ?? '/tmp/atlas-bend2-toolchain/bin/bend';
const build = spawnSync(bend, [join(directory, 'rules-driver.bend'), '-o', native],
  { cwd: root, encoding: 'utf8', timeout: 120_000, env: { ...process.env, BEND_NO_TELEMETRY: '1' } });
assert.ifError(build.error);
assert.equal(build.status, 0, build.stdout + build.stderr);

let assertions = 0;
function raw(name, value, expected = 'ok', mode = 'validate') {
  const escaped = value.replace(/[\u007f-\uffff]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const result = spawnSync(native, [mode, name, escaped], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${name}\n${result.stderr}`);
  assert.equal(result.stdout.trim(), expected, `${name} ${value.slice(0, 240)}`);
  assertions++;
}
const check = (name, value, expected = 'ok', mode = 'validate') => raw(name, JSON.stringify(value), expected, mode);
const reject = (name, value) => check(name, value, 'invalid_value');
const input = (value, extra = {}) => ({ state: 'value', classification: 'dated_measurement', observed_at: null, value, ...extra });
const read = (value, evidence = null, extra = {}) => input(value, { classification: 'state_until_changed', evidence, ...extra });
const publisher = { kind: 'publisher', publisher_id: s.processId };
const constituent = (origin = s.origin, reading_id = s.requestId) => ({ origin, reading_id });
const constituents = (origin = s.origin) => Object.fromEntries(['position', 'altitude', 'ground_speed'].map((key) => [key, constituent(origin)]));
const telemetry = { position: null, altitude: null, ground_speed: null };
const proof = (section, origin = s.origin, entity_id = s.assetId, sequence = '1') => ({
  dataset_id: s.id, entity_id, origin, report_id: s.requestId, sequence, section,
});
const put = (kind, image, version = image.version) => ({
  kind: 'put', resource_kind: kind,
  resource_id: kind === 'task' ? image.task_id : kind === 'object' ? image.object_id : image.id,
  version, image,
});
const batch = (previous_cursor, commit_cursor, changes = [put('asset', s.asset)]) => ({
  type: 'change_batch', data: { previous_cursor, commit_cursor, changes },
});
const progress = (previous_cursor, through_cursor) => ({ type: 'progress', data: { previous_cursor, through_cursor } });
const replay = (messages, through_cursor = 'end', next_page_token = null, replay_boundary = 'end') => ({
  messages, through_cursor, next_page_token, replay_boundary,
});
const frame = (type, data) => ({ type, data, dataset_id: s.id, protocol_version: '0.1.0', request_id: s.requestId });
const reading = (reading_id, observed_at = s.time, time_status = 'known', extra = {}) => ({
  source_entity_kind: 'observation', source_entity_id: s.observationId, quantity: 'position', value: null,
  observed_at, time_status, source_evidence: constituent(publisher, reading_id), track_ids: [s.trackId], ...extra,
});
const historyPage = (readings) => ({ ...s.historyPage, readings });
const task = (extra = {}) => ({ ...s.task, ...extra });
const resume = (accepted_at, expires_at, extra = {}) => task({
  command: 'resume', scheduling: 'immediate', inputs: {}, accepted_at, expires_at, ...extra,
});

test('independent contract fixtures pass through native schema validation and refinements', () => {
  const aliases = { OrdinaryInteger: 'Integer', TypedFloat: 'Float', NewUuid: 'NewId',
    StatusReadResult: 'ReadSection.status', SynchronizationMessage: 'ServerFrame' };
  for (const filename of ['acceptance.json', 'independent-cases.json']) {
    const corpus = JSON.parse(readFileSync(join(root, 'Atlas Protocol/test/fixtures', filename), 'utf8'));
    for (const item of corpus.cases.filter((entry) => entry.scope !== 'parsing_budget_only' && entry.raw_json !== undefined)) {
      const name = aliases[item.schema_name] ?? item.schema_name;
      const result = spawnSync(native, ['validate', name, item.raw_json], { cwd: root, encoding: 'utf8', timeout: 600_000 });
      if (result.error) throw new Error(`${item.id} ${result.error.code}`);
      assert.equal(result.status, 0, `${item.id} ${result.stderr}`);
      const actual = result.stdout.trim();
      assert.equal(actual === 'ok', item.expected === 'accept', `${item.id} ${item.rationale} got ${actual}`);
      if (item.error_code) assert.equal(actual, item.error_code, item.id);
      assertions++;
      if (item.qualification) console.log(`native qualification ${item.id} passed`);
    }
  }
});

test('scalar refinements enforce exact identifiers, dates, counters and media tokens', () => {
  for (const [name, yes, no] of [
    ['Uuid', s.id, s.id.toUpperCase().replace('1111-', '111A-')],
    ['NewId', s.requestId, '44444444-4444-1444-8444-444444444444'],
    ['Counter', '18446744073709551615', '18446744073709551616'],
    ['Sequence', '1', '0'], ['Secret', 'A'.repeat(43), 'A'.repeat(42) + 'B'],
    ['Timestamp', '2000-02-29T23:59:59.123456789Z', '1900-02-29T00:00:00Z'],
    ['ContentType', 'application/vnd.atlas+json', 'text/plain;charset=utf-8'],
    ['Sha256', 'a'.repeat(64), 'A'.repeat(64)], ['ObjectLength', '2000000000', '2000000001'],
  ]) {
    check(name, yes);
    reject(name, no);
  }
  reject('Counter', '01');
  reject('Timestamp', '0000-01-01T00:00:00Z');
  reject('Timestamp', '2026-01-01T23:59:60Z');
  check('Command.move_to', { command: 'move_to', scheduling: 'queued', inputs: s.task.inputs });
  check('Command.pause', { command: 'pause', scheduling: 'immediate', inputs: {} });
  check('Command.resume', { command: 'resume', scheduling: 'immediate', inputs: {}, expires_at: s.time });
  check('NoSemanticRule', {}, 'ok', 'refine');
});

test('component singularities use converted binary64 values and reserves have stable unique IDs', () => {
  check('Attitude', { heading: null, pitch: 90, roll: null });
  reject('Attitude', { heading: null, pitch: -90, roll: 0 });
  raw('Attitude', '{"heading":0,"pitch":89.999999999999999999999,"roll":null}', 'invalid_value');
  check('Gimbal', { bearing: null, elevation: -90 });
  reject('Gimbal', { bearing: 0, elevation: 90 });
  const fuel = { id: s.id, kind: 'fuel', remaining_percent: null };
  const battery = { ...fuel, kind: 'battery', voltage_volts: null, current_amperes: null };
  check('Power', { external_power: null, reserves: [fuel] });
  reject('Power', { external_power: null, reserves: [fuel, battery] });
  check('PowerTimes', { reserves: { [s.id]: { voltage_volts: null } } });
});

test('section times apply only to present quantities and reserve kinds', () => {
  const camera = { zoom_ratio: null };
  check('InputSection.camera', input(camera, { source_times: { zoom_ratio: null } }));
  reject('InputSection.camera', input(camera, { source_times: { recording: null } }));
  check('InputSection.camera', input({ ...camera, recording: null }, { source_times: { recording: null } }));
  const fuel = { id: s.id, kind: 'fuel', remaining_percent: null };
  const power = { external_power: null, reserves: [fuel] };
  check('InputSection.power', input(power, { source_times: { reserves: { [s.id]: { remaining_percent: null } } } }));
  reject('InputSection.power', input(power, { source_times: { reserves: { [s.assetId]: {} } } }));
  reject('InputSection.power', input(power, { source_times: { reserves: { [s.id]: { voltage_volts: null } } } }));
  reject('ReadSection.power', read(power, proof('power'), { source_times: { reserves: { [s.id]: { current_amperes: null } } } }));
  check('InputSection.power', input({ ...power, reserves: [{ ...fuel, kind: 'battery', voltage_volts: null, current_amperes: null }] },
    { source_times: { reserves: { [s.id]: { voltage_volts: null, current_amperes: null } } } }));
  check('InputSection.geometry', input(s.geometry, { source_times: { geometry: null } }));
  check('InputSection.telemetry', input(telemetry, { constituents: constituents() }));
  reject('InputSection.telemetry', input({ ...telemetry, airspeed: null }, { constituents: constituents() }));
  reject('ReadSection.telemetry', read(telemetry, proof('telemetry'), { constituents: { ...constituents(), airspeed: constituent() } }));
  check('InputSection.telemetry', input({ ...telemetry, airspeed: null }, { constituents: { ...constituents(), airspeed: constituent() } }));
});

test('source-free read values are limited to the exact initial states', () => {
  check('ReadSection.status', read({ condition: 'unknown' }));
  check('ReadSection.communications', read({ bandwidth_bps: null }));
  check('ReadSection.type', read({ kind: null }));
  reject('ReadSection.status', read({ condition: 'healthy' }));
  reject('ReadSection.status', read({ condition: 'unknown', explanation: 'unproven' }));
  reject('ReadSection.status', read({ condition: 'unknown' }, null, { source_times: {} }));
  reject('ReadSection.status', read({ condition: 'unknown' }, null, { observed_at: s.time }));
  reject('ReadSection.status', read({ condition: 'unknown' }, null, { classification: 'dated_measurement' }));
  for (const [name, value] of Object.entries({
    attitude: { heading: null, pitch: null, roll: null }, power: { external_power: null, reserves: [] },
    camera: { zoom_ratio: null }, camera_optics: { horizontal_fov: null, vertical_fov: null },
    gimbal: { bearing: null, elevation: null }, geometry: s.geometry,
  })) reject(`ReadSection.${name}`, read(value));
  reject('ReadSection.communications', read({ bandwidth_bps: 100 }));
  reject('ReadSection.type', read({ kind: 'person' }));
  check('ReadSection.status', read({ condition: 'healthy' }, proof('status')));
});

test('reports enforce content, contact generation time and source-origin rules', () => {
  check('AssetReport', s.report);
  reject('AssetReport', { ...s.report, sections: {} });
  check('AssetReport', { ...s.report, sections: {}, contact_proof: { challenge_id: s.id } });
  reject('AssetReport', { ...s.report, generated_at: null, sections: {}, contact_proof: { challenge_id: s.id } });
  reject('AssetReport', { ...s.report, mode: 'history_only', sections: {} });
  const assetTelemetry = input(telemetry, { constituents: constituents() });
  check('AssetReport', { ...s.report, sections: { telemetry: assetTelemetry } });
  reject('AssetReport', { ...s.report, sections: { telemetry: { ...assetTelemetry, constituents: constituents(publisher) } } });
  check('ObservationReport', { ...s.observationReport, sections: { telemetry: input(telemetry, { constituents: constituents(publisher) }) } });
  reject('ObservationReport', { ...s.observationReport, sections: { telemetry: assetTelemetry } });
  reject('ObservationReport', { ...s.observationReport, sections: { telemetry: input(telemetry, {
    constituents: constituents({ ...publisher, publisher_id: s.assetId }),
  }) } });
});

test('entities retain original evidence scope and shared report sequence', () => {
  check('Asset', s.asset);
  check('Observation', s.observation);
  check('Track', s.track);
  const status = read({ condition: 'healthy' }, proof('status'));
  const capacity = read({ bandwidth_bps: null }, proof('communications'));
  const asset = { ...s.asset, status, communications: { health: 'offline', capacity } };
  check('Asset', asset);
  reject('Asset', { ...asset, communications: { ...asset.communications, capacity: { ...capacity, evidence: { ...capacity.evidence, sequence: '2' } } } });
  check('Asset', { ...asset, communications: { ...asset.communications, capacity: { ...capacity, evidence: { ...capacity.evidence, sequence: '2', report_id: s.taskId } } } });
  for (const mismatch of [{ dataset_id: s.assetId }, { entity_id: s.observationId }, { origin: publisher }])
    reject('Asset', { ...asset, status: { ...status, evidence: { ...status.evidence, ...mismatch } } });
  const oldOrigin = { kind: 'asset_process', process_generation: s.trackId };
  check('Asset', { ...asset, telemetry: read(telemetry, proof('telemetry', oldOrigin), { constituents: constituents(oldOrigin) }) });
  reject('Asset', { ...asset, telemetry: read(telemetry, proof('telemetry'), { constituents: constituents(publisher) }) });
  const type = read({ kind: 'person' }, proof('type', publisher, s.observationId));
  const observation = { ...s.observation, type };
  const track = { ...s.track, type };
  check('Observation', observation);
  check('Track', track);
  for (const mutation of [{ track_id: s.observationId }, { source_asset_id: s.observationId }, { source_asset_id: s.trackId }])
    reject('Observation', { ...observation, ...mutation });
  reject('Observation', { ...observation, type: { ...type, evidence: { ...type.evidence, origin: { ...publisher, publisher_id: s.assetId } } } });
  reject('Observation', { ...observation, type: { ...type, evidence: { ...type.evidence, entity_id: s.trackId } } });
  check('Observation', { ...observation, telemetry: read(telemetry, proof('telemetry', publisher, s.observationId), { constituents: constituents(publisher) }) });
  reject('Track', { ...track, type: { ...type, evidence: { ...type.evidence, entity_id: s.trackId } } });
  reject('Track', { ...track, sources: [{ observation_id: s.observationId, publisher_id: s.assetId }] });
  for (const source of [
    { observation_id: s.trackId, publisher_id: s.processId },
    { observation_id: s.observationId, publisher_id: s.processId, source_asset_id: s.trackId },
    { observation_id: s.observationId, publisher_id: s.processId, source_asset_id: s.observationId },
  ]) reject('Track', { ...track, sources: [source] });
  reject('Track', { ...track, telemetry: read(telemetry, proof('telemetry', publisher, s.observationId), {
    constituents: constituents({ ...publisher, publisher_id: s.assetId }),
  }) });
});

test('queue and control revisions allow retained confirmations and refuse future or inconsistent ones', () => {
  const confirmation = { revision: '9', process_generation: s.processId };
  check('TaskQueue', { ...s.queue, revision: '10', confirmed: confirmation });
  reject('TaskQueue', { ...s.queue, revision: '8', confirmed: confirmation });
  check('TaskQueue', { ...s.queue, revision: '18446744073709551615', confirmed: { ...confirmation, revision: '18446744073709551614' } });
  const requested = { task_id: s.taskId, command: 'pause', expires_at: null };
  const confirmed = { ...confirmation, revision: '10', task_id: s.taskId, queue_state: 'paused' };
  const control = { revision: '10', requested, confirmed };
  check('TaskControl', s.control);
  check('TaskControl', control);
  reject('TaskControl', { ...control, revision: '0' });
  reject('TaskControl', { ...control, requested: null });
  reject('TaskControl', { ...control, confirmed: { ...confirmed, revision: '0' } });
  reject('TaskControl', { ...control, confirmed: { ...confirmed, revision: '11' } });
  reject('TaskControl', { ...control, confirmed: { ...confirmed, task_id: s.assetId } });
  reject('TaskControl', { ...control, confirmed: { ...confirmed, queue_state: 'running' } });
  check('TaskControl', { ...control, requested: { ...requested, command: 'resume', expires_at: s.time }, confirmed: { ...confirmed, queue_state: 'running' } });
  check('TaskControl', { ...control, confirmed: { ...confirmed, revision: '9', task_id: s.assetId, queue_state: 'running' } });
});

test('tasks, resume effects and declarations preserve exact inclusive capture and exclusive expiry bounds', () => {
  const start = '2026-10-23T00:00:00Z';
  check('Task', resume(start, '2026-10-23T00:01:00Z'));
  check('Task', resume(start, '2026-10-23T00:00:00.000000001Z'));
  reject('Task', resume(start, start));
  reject('Task', resume(start, '2026-10-23T00:01:00.000000001Z'));
  reject('Task', resume(start, '2026-10-22T23:59:59.999999999Z'));
  check('Task', task({ execution_state: 'completed' }));
  reject('Task', task({ execution_state: 'completed', cancellation_request_id: s.requestId }));
  check('ResultDeclarations', [{ object_id: s.id, required: true }]);
  reject('ResultDeclarations', [{ object_id: s.id, required: true }, { object_id: s.id, required: false }]);
  check('DeclarationBatch', [{ object_id: s.id, required: true }, { object_id: s.id, required: true }]);
  reject('DeclarationBatch', [{ object_id: s.id, required: true }, { object_id: s.id, required: false }]);
  reject('ReportTaskResults', { evidence: s.evidence({ task_id: s.taskId,
    declarations: [{ object_id: s.id, required: false }, { object_id: s.id, required: true }] }) });
  const effect = { task_id: s.taskId, event: 'state', state: 'completed', control_revision: '1', queue_state: 'running',
    read_id: s.requestId, core_run_id: s.id, captured_at: start, applied_at: start,
    instructions_valid_until: '2026-10-23T00:00:10Z', queue_revision: '0' };
  check('ExecutionPayload', effect);
  check('ReportTaskExecution', { evidence: s.evidence(effect) });
  check('ExecutionPayload', { ...effect, applied_at: '2026-10-23T00:00:09.999999999Z' });
  reject('ExecutionPayload', { ...effect, applied_at: '2026-10-22T23:59:59.999999999Z' });
  reject('ExecutionPayload', { ...effect, applied_at: effect.instructions_valid_until });
});

test('assigned work and contact intervals use exact nanoseconds', () => {
  const captured_at = '2026-10-23T00:00:00Z';
  const instructions_valid_until = '2026-10-23T00:00:10Z';
  const assigned = { asset_id: s.assetId, process_generation: s.processId, read_id: s.id, core_run_id: s.id,
    captured_at, instructions_valid_until, task_queue: s.queue, task_control: s.control, tasks: [s.task], next_page_token: null };
  check('AssignedTasks', assigned);
  reject('AssignedTasks', { ...assigned, instructions_valid_until: '2026-10-23T00:00:10.000000001Z' });
  reject('AssignedTasks', { ...assigned, tasks: [task({ asset_id: s.id })] });
  reject('AssignedTasks', { ...assigned, tasks: [task({ execution_state: 'completed' })] });
  reject('AssignedTasks', { ...assigned, tasks: [s.task, s.task] });
  reject('AssignedTasks', { ...assigned, tasks: [task({ task_id: s.trackId }), s.task] });
  check('AssignedTasks', { ...assigned, tasks: [s.task, task({ task_id: s.trackId })] });
  const begin = { request_id: s.requestId, allocation_context: 'context', asset_id: s.assetId,
    process_generation: s.requestId, expected_process_generation: s.processId, mode: 'replace' };
  check('BeginAssetContact', begin);
  reject('BeginAssetContact', { ...begin, expected_process_generation: s.requestId });
  const challenge = { asset_id: s.assetId, process_generation: s.processId, challenge_id: s.id,
    core_run_id: s.id, mode: 'current', issued_at: captured_at, expires_at: instructions_valid_until };
  check('ContactChallenge', challenge);
  check('ContactChallenge', { ...challenge, expires_at: '2026-10-23T00:00:00.000000001Z' });
  reject('ContactChallenge', { ...challenge, expires_at: captured_at });
  reject('ContactChallenge', { ...challenge, expires_at: '2026-10-23T00:00:10.000000001Z' });
  const replacement = { request_id: s.requestId, asset_id: s.assetId, expected_process_generation: s.id,
    process_generation: s.processId, challenge_id: s.id,
    first_report: { ...s.report, contact_proof: { challenge_id: s.id } } };
  check('ReplaceAssetProcess', replacement);
  reject('ReplaceAssetProcess', { ...replacement, expected_process_generation: s.processId });
  reject('ReplaceAssetProcess', { ...replacement, first_report: { ...replacement.first_report, entity_id: s.id } });
  reject('ReplaceAssetProcess', { ...replacement, challenge_id: s.assetId });
  reject('ReplaceAssetProcess', { ...replacement, first_report: { ...replacement.first_report, origin: { kind: 'asset_process', process_generation: s.id } } });
  reject('ReplaceAssetProcess', { ...replacement, first_report: { ...s.report, mode: 'history_only' } });
});

test('history identity includes the source scope and uses exact time followed by full identity', () => {
  check('HistoryReading', reading(s.requestId));
  check('HistoryReading', reading(s.requestId, null, 'unknown'));
  reject('HistoryReading', reading(s.requestId, null));
  reject('HistoryReading', reading(s.requestId, s.time, 'unknown'));
  const from = '2026-10-23T00:00:00.000000001Z';
  const before = '2026-10-23T00:00:00.000000002Z';
  check('HistoryFirst', { ...s.historyFirst, source_time_from: from, source_time_before: before });
  reject('HistoryFirst', { ...s.historyFirst, source_time_from: before, source_time_before: from });
  reject('HistoryFirst', { ...s.historyFirst, source_time_from: s.time, source_time_before: s.time.replace('.100Z', '.1Z') });
  const a = reading(s.requestId, from);
  const b = reading(s.taskId, before);
  check('HistoryPage', historyPage([a, b]));
  reject('HistoryPage', historyPage([b, a]));
  check('HistoryPage', historyPage([reading(s.requestId, s.time), reading(s.taskId, s.time.replace('.100Z', '.1Z'))]));
  reject('HistoryPage', historyPage([reading(s.taskId, s.time), reading(s.requestId, s.time.replace('.100Z', '.1Z'))]));
  reject('HistoryPage', historyPage([a, { ...a, observed_at: before }]));
  check('HistoryPage', historyPage([a, { ...a, source_entity_id: s.trackId }]));
  const unknown = reading(s.requestId, null, 'unknown');
  const uncertain = reading(s.taskId, s.time, 'uncertain');
  check('HistoryPage', historyPage([a, uncertain]));
  check('HistoryPage', historyPage([unknown, uncertain]));
  reject('HistoryPage', historyPage([uncertain, unknown]));
  reject('HistoryPage', historyPage([unknown, b]));
});

test('synchronization matches concrete identities, versions, datasets, resources and negotiated count', () => {
  for (const [kind, image] of [['asset', s.asset], ['track', s.track], ['geofeature', s.geofeature], ['task', s.task], ['object', s.object]]) {
    const item = put(kind, image);
    check('Put', item);
    reject('Put', { ...item, resource_id: s.processId });
    reject('Put', { ...item, version: '1' });
    reject('Changes', [item, { ...item, version: '1', image: { ...image, version: '1' } }]);
    const invalid = { ...item, image: { ...image, dataset_id: s.assetId } };
    reject('ServerFrame', { ...frame('change_batch', { ...batch('start', 'end', [invalid]).data, subscription_id: s.id }), request_id: undefined });
    reject('ServerFrame', frame('read_snapshot_result', { ...s.snapshot, items: [invalid] }));
    reject('ServerFrame', frame('read_changes_result', replay([batch('start', 'end', [invalid])])));
  }
  const asset = put('asset', s.asset);
  const track = put('track', s.track);
  check('Changes', [track, asset]);
  check('SnapshotPage', { ...s.snapshot, items: [asset, track] });
  reject('SnapshotPage', { ...s.snapshot, items: [track, asset] });
  reject('SnapshotPage', { ...s.snapshot, items: [asset, asset] });
  reject('SnapshotPage', { ...s.snapshot, limits: { ...s.limits, max_changes: 1 }, items: [asset, track] });
  reject('ChangeBatchData', batch('same', 'same').data);
  reject('LiveChangeBatchData', { ...batch('same', 'same').data, subscription_id: s.id });
  reject('ReplayBatch', batch('same', 'same'));
  check('ReplayProgress', progress('same', 'same'));
});

test('replay permits unchanged progress but refuses gaps, cycles and incomplete completion', () => {
  check('ReplayPage', replay([]));
  check('ReplayPage', replay([batch('start', 'end')]));
  check('ReplayPage', replay([progress('start', 'start'), progress('start', 'start'), batch('start', 'end')]));
  check('ReplayPage', replay([batch('start', 'middle'), progress('middle', 'middle'), progress('middle', 'end')]));
  check('ReplayPage', replay([progress('start', 'middle')], 'middle', 'next'));
  reject('ReplayPage', replay([batch('start', 'middle'), progress('elsewhere', 'end')]));
  reject('ReplayPage', replay([progress('start', 'middle'), progress('middle', 'start')], 'start', 'next'));
  reject('ReplayPage', replay([batch('start', 'middle'), batch('middle', 'end'), progress('end', 'middle')], 'middle', 'next'));
  reject('ReplayPage', replay([batch('start', 'end')], 'other', 'next'));
  reject('ReplayPage', replay([progress('start', 'middle')], 'middle'));
  reject('ReplayPage', replay([], 'middle'));
  check('ReplayPage', replay([], 'middle', 'next'));
});

test('administration, object and error refinements rely on the structural owner for field variants', () => {
  const activity = { activity_id: s.id, at: s.time, category: 'state', message: '', api_key_id: null,
    operator_id: null, operator_deleted: false };
  check('Activity', activity);
  reject('Activity', { ...activity, operator_deleted: true });
  check('Activity', { ...activity, operator_id: s.id, operator_deleted: true });
  reject('ObjectEdits', {});
  check('ObjectEdits', { name: null });
  reject('Associations', [{ kind: 'asset', id: s.id }, { kind: 'asset', id: s.id }]);
  check('Associations', [{ kind: 'asset', id: s.id }, { kind: 'track', id: s.id }]);
  const error = { code: 'cursor_expired', message: '', request_id: s.requestId,
    details: { earliest_recoverable_cursor: 'start' } };
  check('ErrorObject', error);
  check('HttpError', { kind: 'error', status: 410, body: { dataset_id: s.id, error } });
  reject('HttpError', { kind: 'error', status: 409, body: { dataset_id: s.id, error } });
  reject('ErrorObject', { ...error, details: undefined });
  reject('ErrorObject', { ...error, details: { secret: 'forbidden' } });
});

after(() => console.log(`native semantic assertions ${assertions}`));


test('geometry structural failures retain their public refusal codes', () => {
  check('Geometry', { type: 'MultiPoint', coordinates: [[0, 0]] }, 'unsupported_geometry');
  check('Geometry', { type: 4, coordinates: [0, 0] }, 'invalid_geometry');
  check('Geometry', { type: 'Point', coordinates: [0] }, 'invalid_geometry');
  check('Geometry', { type: 'Point', coordinates: [0, 91] }, 'invalid_geometry');
  check('Geometry', { type: 'Point', coordinates: [0, 0], extra: true }, 'invalid_geometry');
  check('InputSection.geometry', input({ type: 'MultiPoint', coordinates: [[0, 0]] }), 'unsupported_geometry');
  check('InputSection.geometry', input(s.geometry, { source_times: { position: null } }), 'invalid_value');
  check('InputSection.geometry', input(undefined), 'invalid_geometry');
  check('ReadSection.geometry', read(undefined, proof('geometry')), 'invalid_geometry');
});
