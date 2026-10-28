import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { defaults } from '../dist/settings.js';
import { fixture, uuid, registration, report, telemetry } from './helpers.mjs';

const ok = result => { assert.equal(result.status, 200, JSON.stringify(result.json)); return result.json.data; };
const limits = { max_message_bytes: 4194304, max_json_values: 262144, max_changes: 1000 };
test('Observation creation bounds the complete image and rolls back its pair, evidence and retry before correction', async t => {
  const f = await fixture(t, { resourceImageBytes: 65536, limits: { ...defaults.limits, max_message_bytes: 212992 } });
  const make = description => {
    const observation = uuid(), publisher = uuid(), origin = { kind: 'publisher', publisher_id: publisher };
    return { request_id: uuid(), observation_id: observation, publisher_id: publisher, description: { name: 'boundary', description },
      report: report(f.core.dataset, observation, origin, 1, { geometry: { state: 'value', classification: 'state_until_changed', observed_at: null,
        value: { type: 'LineString', coordinates: Array.from({ length: 1024 }, (_, i) => [1.123456789012345e-100 + i * 1e-115, -1.123456789012345e-100]) } } }) };
  };
  const small = make('\u0000'.repeat(2200)), pair = ok(await f.call('CreateObservation', small));
  const imageBytes = Buffer.byteLength(JSON.stringify(pair.observation));
  assert.ok(imageBytes > 65536 - 1024 && imageBytes <= 65536);
  const withdraw = creation => ({ observation_id: creation.observation_id, publisher_id: creation.publisher_id,
    report: report(f.core.dataset, creation.observation_id, { kind: 'publisher', publisher_id: creation.publisher_id }, 2,
      { type: { state: 'withdrawn', classification: 'state_until_changed', observed_at: null } }) });
  assert.equal(ok(await f.call('ReportObservation', withdraw(small))).observation.type.state, 'withdrawn');
  const database = new Database(join(f.directory, 'core.sqlite'), { readonly: true });
  t.after(() => database.close());
  const counts = () => Object.fromEntries(['entity_identity', 'entity_observations', 'entity_tracks', 'evidence_reports', 'evidence_sections', 'evidence_readings', 'evidence_positions', 'retry', 'commit_log']
    .map(table => [table, database.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
  const before = counts(), oversized = make('\u0000'.repeat(4096));
  const rejected = await f.call('CreateObservation', oversized);
  assert.equal(rejected.status, 429, 'The complete Observation must fit 65536 bytes before commit');
  assert.equal(rejected.json.error.code, 'resource_limit');
  assert.deepEqual(counts(), before);
  assert.equal((await f.call('GetObservation', { observation_id: oversized.observation_id })).status, 404);
  const corrected = ok(await f.call('CreateObservation', { ...oversized, description: { name: 'boundary', description: 'corrected' } }));
  assert.equal(corrected.observation.id, oversized.observation_id);
  assert.equal(ok(await f.call('ReportObservation', withdraw(oversized))).observation.type.state, 'withdrawn');
});
test('independent evidence admission, frozen history, exact times, structural retry and restart', async t => {
  const f = await fixture(t);
  const publisher = uuid(), observationId = uuid(), origin = { kind: 'publisher', publisher_id: publisher };
  const p2 = telemetry(origin, 51.001, '2026-10-21T12:00:11Z');
  const r11 = report(f.core.dataset, observationId, origin, '18446744073709551614', { telemetry: p2 });
  const creation = { request_id: uuid(), observation_id: observationId, publisher_id: publisher, report: r11 };
  const created = await f.call('CreateObservation', creation); const pair = ok(created);
  const r10 = report(f.core.dataset, observationId, origin, 10, { telemetry: telemetry(origin, 51, '2026-10-21T12:00:10Z') });
  ok(await f.call('ReportObservation', { observation_id: observationId, publisher_id: publisher, report: r10 }));
  const health = ok(await f.call('GetHealth'));
  const query = { entity_id: observationId, query_id: uuid(), allocation_context: health.allocation_context, page_size: 1 };
  const first = ok(await f.call('GetObservationMovementHistory', query));
  assert.equal(first.readings[0].value.latitude, 51);
  const r12 = report(f.core.dataset, observationId, origin, 12, { telemetry: telemetry(origin, 50.9, '2026-10-21T12:00:09Z') }, 'history_only');
  const changed = await f.call('ReportObservation', { observation_id: observationId, publisher_id: publisher, report: r12 }); ok(changed);
  assert.ok(changed.json.commit_cursor);
  const retried = ok(await f.call('GetObservationMovementHistory', JSON.parse(JSON.stringify(query, Object.keys(query).reverse()))));
  assert.equal(first.view_id, retried.view_id); assert.equal(first.expires_at, retried.expires_at);
  const last = ok(await f.call('GetObservationMovementHistory', { page_token: first.next_page_token }));
  assert.equal(last.readings[0].value.latitude, 51.001); assert.equal(last.next_page_token, null);
  const snapshot = ok(await f.call('ReadSnapshot', { load_id: uuid(), allocation_context: health.allocation_context, page_size: 100, ...limits }));
  for (const r of [r10, r11, r12]) assert.equal(ok(await f.call('ReportObservation', { observation_id: observationId, publisher_id: publisher, report: r })).evidence_disposition, 'duplicate');
  const conflict = structuredClone(r10); conflict.report_id = uuid(); conflict.sequence = '18446744073709551615'; conflict.sections.telemetry.value.position.latitude = 51.0001;
  const refused = await f.call('ReportObservation', { observation_id: observationId, publisher_id: publisher, report: conflict });
  assert.equal(refused.json.error.code, 'constituent_conflict');
  const collision = { ...r11, report_id: uuid() };
  assert.equal((await f.call('ReportObservation', { observation_id: observationId, publisher_id: publisher, report: collision })).json.error.code, 'section_sequence_conflict');
  const replay = ok(await f.call('ReadChanges', { from_cursor: snapshot.baseline_cursor, ...limits }));
  assert.equal(replay.messages.length, 0);
  const carried = report(f.core.dataset, observationId, origin, '18446744073709551615', { telemetry: p2 });
  ok(await f.call('ReportObservation', { observation_id: observationId, publisher_id: publisher, report: carried }));
  assert.equal(ok(await f.call('GetObservation', { observation_id: observationId })).telemetry.evidence.sequence, '18446744073709551615');
  const currentTrack = ok(await f.call('GetTrack', { track_id: pair.track.id }));
  assert.equal(currentTrack.telemetry.observed_at, '2026-10-21T12:00:11Z');
  await f.restart();
  assert.equal(ok(await f.call('CreateObservation', creation)).track.id, pair.track.id);
  assert.equal((await f.call('GetObservationMovementHistory', { page_token: first.next_page_token })).json.error.code, 'allocation_expired');
  const newHealth = ok(await f.call('GetHealth'));
  const all = ok(await f.call('GetTrackMovementHistory', { entity_id: pair.track.id, query_id: uuid(), allocation_context: newHealth.allocation_context }));
  assert.deepEqual(all.readings.map(r => r.value.latitude), [50.9, 51, 51.001]);
  assert.ok(all.readings.every(r => r.source_entity_id === observationId && r.track_ids[0] === pair.track.id));
});
test('nanosecond order preserves spelling and future classification stays uncertain', async t => {
  const f = await fixture(t);
  const origin = { kind: 'publisher', publisher_id: uuid() }, entity = uuid();
  const create = { observation_id: entity, publisher_id: origin.publisher_id, request_id: uuid() };
  ok(await f.call('CreateObservation', create));
  const times = ['2026-10-21T12:00:00.0000002Z', '2026-10-21T12:00:00.0000001Z', '2026-10-21T12:00:00.100Z', '2026-10-21T12:00:00.1Z', '9999-12-31T23:59:59.999999999Z'];
  for (const [i, at] of times.entries()) ok(await f.call('ReportObservation', { observation_id: entity, publisher_id: origin.publisher_id, report: report(f.core.dataset, entity, origin, i + 1, { telemetry: telemetry(origin, i, at) }) }));
  await f.restart();
  const health = ok(await f.call('GetHealth'));
  const page = ok(await f.call('GetObservationMovementHistory', { entity_id: entity, query_id: uuid(), allocation_context: health.allocation_context }));
  assert.equal(page.readings[0].observed_at, times[1]); assert.equal(page.readings[1].observed_at, times[0]);
  assert.deepEqual(new Set(page.readings.slice(2, 4).map(r => r.observed_at)), new Set(times.slice(2, 4)));
  assert.equal(page.readings.at(-1).time_status, 'uncertain');
  const known = ok(await f.call('GetObservationMovementHistory', { entity_id: entity, query_id: uuid(), allocation_context: health.allocation_context, time_groups: ['known'] }));
  assert.equal(known.readings.length, 4);
});
test('Unicode Entity identity, tombstones and continued publisher evidence after Asset deletion', async t => {
  const f = await fixture(t);
  const r = registration('Σ'); const asset = ok(await f.call('RegisterAsset', r)).asset;
  assert.equal(ok(await f.call('GetAssetByAlias', { alias: 'ς' })).id, asset.id);
  const collision = await f.call('CreateGeofeature', { geofeature_id: uuid(), request_id: uuid(), alias: 'σ', geometry: { type: 'Point', coordinates: [0, 0] } });
  assert.equal(collision.json.error.code, 'identity_conflict');
  const publisher = uuid(), entity = uuid();
  const pair = ok(await f.call('CreateObservation', { observation_id: entity, request_id: uuid(), publisher_id: publisher, source_asset_id: asset.id }));
  ok(await f.call('DeleteAsset', { asset_id: asset.id, request_id: uuid() }));
  assert.equal((await f.call('RegisterAsset', r)).json.error.code, 'asset_not_found');
  assert.equal((await f.call('CreateObservation', { observation_id: uuid(), request_id: uuid(), publisher_id: publisher, source_asset_id: asset.id })).json.error.code, 'asset_not_found');
  const result = ok(await f.call('ReportObservation', { observation_id: entity, publisher_id: publisher, report: report(f.core.dataset, entity, { kind: 'publisher', publisher_id: publisher }, 1, { type: { state: 'withdrawn', classification: 'state_until_changed', observed_at: null } }) }));
  assert.equal(result.track.id, pair.track.id); assert.equal(result.track.type.state, 'withdrawn');
});
