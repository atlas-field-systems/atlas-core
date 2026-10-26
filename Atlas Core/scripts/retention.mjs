import assert from 'node:assert/strict';
import { fixture, uuid, registration, report, telemetry } from '../test/helpers.mjs';

const args = process.argv.slice(2);
const setting = (name, fallback, maximum) => {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]); args.splice(index, 2);
  assert.ok(Number.isInteger(value) && value >= 1 && value <= maximum, name);
  return value;
};
const assets = setting('assets', 20, 100), observations = setting('observations', 200, 1000), rounds = setting('rounds', 5, 100), turnover = setting('turnover', 20, 1000);
assert.equal(args.length, 0);
const cleanup = [];
const f = await fixture({ after: fn => cleanup.push(fn) });
const limits = { max_message_bytes: 4194304, max_json_values: 262144, max_changes: 1000 };
let requests = 0, failures = 0;
async function call(name, input) { requests++; const result = await f.call(name, input); if (result.status !== 200) failures++; assert.equal(result.status, 200, JSON.stringify(result.json)); return result.json.data; }
try {
  const a = [], o = [];
  for (let i = 0; i < assets; i++) a.push((await call('RegisterAsset', registration(`Asset ${i}`))).asset);
  for (let i = 0; i < observations + turnover; i++) {
    const entity = uuid(), origin = { kind: 'publisher', publisher_id: uuid() };
    const pair = await call('CreateObservation', { request_id: uuid(), observation_id: entity, publisher_id: origin.publisher_id,
      report: report(f.core.dataset, entity, origin, 1, { telemetry: telemetry(origin, i / 1000) }) });
    if (i < observations) o.push({ ...pair.observation, origin });
  }
  for (let round = 0; round < rounds; round++) {
    for (const asset of a) {
      const origin = { kind: 'asset_process', process_generation: asset.process_generation };
      await call('UpdateAsset', { asset_id: asset.id, request_id: uuid(), report: report(f.core.dataset, asset.id, origin, round + 1,
        { telemetry: telemetry(origin, round / 1000, `2026-10-21T12:00:${String(round % 60).padStart(2, '0')}Z`) }) });
    }
    for (const observation of o) await call('ReportObservation', { observation_id: observation.id, publisher_id: observation.publisher_id,
      report: report(f.core.dataset, observation.id, observation.origin, round + 2,
        { telemetry: telemetry(observation.origin, round / 1000, `2026-10-21T12:00:${String(round % 60).padStart(2, '0')}Z`) }) });
  }
  await f.restart();
  const health = await call('GetHealth');
  let snapshot = await call('ReadSnapshot', { load_id: uuid(), allocation_context: health.allocation_context, page_size: 100, ...limits });
  const release = snapshot.release_token;
  const counts = { asset: 0, track: 0, geofeature: 0, task: 0, object: 0 };
  while (true) {
    for (const item of snapshot.items) counts[item.resource_kind]++;
    if (snapshot.next_page_token === null) break;
    snapshot = await call('ReadSnapshot', { page_token: snapshot.next_page_token });
  }
  assert.equal(counts.asset, assets); assert.equal(counts.track, observations + turnover);
  const retained = new Set();
  let page = await call('ListObservations', { page_size: 100 });
  while (true) {
    for (const item of page.items) { assert.equal(retained.has(item.id), false); retained.add(item.id); }
    if (page.next_page_token === null) break;
    page = await call('ListObservations', { page_token: page.next_page_token });
  }
  assert.equal(retained.size, observations + turnover);
  await call('ReleaseSnapshot', { release_token: release });
  const first = o[0]; assert.ok(first);
  const history = await call('GetObservationMovementHistory', { entity_id: first.id, query_id: uuid(), allocation_context: health.allocation_context });
  assert.equal(history.readings.length, rounds + 1);
  await call('ReleaseHistoryView', { release_token: history.release_token });
  process.stdout.write(JSON.stringify({ passed: true, qualification: 'bounded functional retention fixture', requests, failures,
    incoming_reports: observations + turnover + rounds * (assets + observations), picture: counts, retained_observations: retained.size, sampled_history_readings: history.readings.length,
    full_sustained_workload: 'unrun', power_loss: 'unrun' }) + '\n');
} finally { for (const close of cleanup.reverse()) await close(); }
