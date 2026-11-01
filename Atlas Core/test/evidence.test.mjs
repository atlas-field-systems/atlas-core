import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { writeFile, rm } from 'node:fs/promises';
import { storageUsage } from '../dist/server.js';
import { defaults } from '../dist/settings.js';
import { fixture, uuid, registration, report, telemetry } from './helpers.mjs';

const ok = (result) => {
  assert.equal(result.status, 200, JSON.stringify(result.json));
  return result.json.data;
};
const limits = { max_message_bytes: 4194304, max_json_values: 262144, max_changes: 1000 };
test('one-to-one policy keeps Core identity and authored Track metadata separate from source sections', async (t) => {
  const f = await fixture(t);
  const asset = ok(await f.call('RegisterAsset', registration())).asset;
  const observationId = uuid(),
    publisherId = uuid();
  const pair = ok(
    await f.call('CreateObservation', {
      request_id: uuid(),
      observation_id: observationId,
      publisher_id: publisherId,
      source_asset_id: asset.id,
      alias: 'Observation alias',
      description: { name: 'Source description' },
    }),
  );
  assert.notEqual(pair.track.id, observationId);
  const initial = {
    dataset_id: f.core.dataset,
    id: pair.track.id,
    entity_type: 'track',
    version: '0',
    edit_revision: '0',
    sources: [
      { observation_id: observationId, publisher_id: publisherId, source_asset_id: asset.id },
    ],
    type: {
      state: 'value',
      classification: 'state_until_changed',
      observed_at: null,
      evidence: null,
      time_status: { kind: 'unknown' },
      value: { kind: null },
    },
  };
  assert.deepEqual(pair.track, initial);
  ok(
    await f.call('EditTrack', {
      request_id: uuid(),
      track_id: pair.track.id,
      expected_edit_revision: '0',
      edits: { alias: 'Authored Track alias', description: { name: 'Authored Track description' } },
    }),
  );
  const origin = { kind: 'publisher', publisher_id: publisherId };
  const reading = report(f.core.dataset, observationId, origin, 1, {
    type: { state: 'withdrawn', classification: 'state_until_changed', observed_at: null },
  });
  const submission = { observation_id: observationId, publisher_id: publisherId, report: reading };
  const expected = {
    ...initial,
    version: '2',
    edit_revision: '1',
    alias: 'Authored Track alias',
    description: { name: 'Authored Track description' },
    type: {
      state: 'withdrawn',
      classification: 'state_until_changed',
      observed_at: null,
      time_status: 'unknown',
      evidence: {
        dataset_id: f.core.dataset,
        entity_id: observationId,
        origin,
        report_id: reading.report_id,
        sequence: '1',
        section: 'type',
      },
    },
  };
  assert.deepEqual(ok(await f.call('ReportObservation', submission)).track, expected);
  const replay = ok(await f.call('ReportObservation', submission));
  assert.equal(replay.evidence_disposition, 'duplicate');
  assert.deepEqual(replay.track, expected);
  await f.restart();
  assert.deepEqual(ok(await f.call('GetTrack', { track_id: pair.track.id })), expected);
  const database = new Database(join(f.directory, 'core.sqlite'), { readonly: true });
  try {
    assert.deepEqual(database.prepare('SELECT track,observation FROM entity_track_sources').all(), [
      { track: pair.track.id, observation: observationId },
    ]);
  } finally {
    database.close();
  }
});
test('duplicate Asset wrappers bind original facts privately across Restart and storage refusal', async (t) => {
  const f = await fixture(t, {
    storageBytes: 32 * 1024 * 1024,
    objectBytes: 16 * 1024 * 1024,
    reserveBytes: 1024 * 1024,
  });
  const asset = ok(await f.call('RegisterAsset', registration())).asset;
  const origin = { kind: 'asset_process', process_generation: asset.process_generation };
  const firstRequest = {
    asset_id: asset.id,
    request_id: uuid(),
    report: report(f.core.dataset, asset.id, origin, 1, { telemetry: telemetry(origin, 10) }),
  };
  const first = await f.call('UpdateAsset', firstRequest),
    accepted = ok(first).asset;
  assert.equal(first.json.data.evidence_disposition, 'accepted');
  const duplicateRequest = { ...firstRequest, request_id: uuid() };
  const duplicate = await f.call('UpdateAsset', duplicateRequest);
  assert.equal(ok(duplicate).evidence_disposition, 'duplicate');
  assert.equal(duplicate.json.commit_cursor, undefined);
  for (const restart of [false, true]) {
    if (restart) await f.restart();
    const changed = await f.call('UpdateAsset', {
      ...duplicateRequest,
      alias: 'reused-identity',
      expected_edit_revision: '0',
    });
    assert.equal(changed.status, 409);
    assert.equal(changed.json.error.code, 'identity_conflict');
    const retry = await f.call('UpdateAsset', duplicateRequest);
    assert.equal(ok(retry).evidence_disposition, 'duplicate');
    assert.equal(retry.json.commit_cursor, undefined);
    assert.deepEqual(retry.json.data.asset, accepted);
    assert.deepEqual(ok(await f.call('GetAsset', { asset_id: asset.id })), accepted);
    assert.deepEqual(
      ok(await f.call('ReadChanges', { from_cursor: first.json.commit_cursor, ...limits }))
        .messages,
      [],
    );
  }
  const pressure = join(f.directory, 'pressure.bin');
  const usage = await storageUsage(f.directory);
  await writeFile(
    pressure,
    Buffer.alloc(f.settings.storageBytes - f.settings.reserveBytes - usage.bytes - 32768),
  );
  assert.equal(ok(await f.call('UpdateAsset', duplicateRequest)).evidence_disposition, 'duplicate');
  const refusedRequest = { ...firstRequest, request_id: uuid() };
  assert.equal((await f.call('UpdateAsset', refusedRequest)).json.error?.code, 'storage_limit');
  await rm(pressure);
  const edited = await f.call('UpdateAsset', {
    ...refusedRequest,
    alias: 'after-refusal',
    expected_edit_revision: '0',
  });
  assert.equal(ok(edited).asset.alias, 'after-refusal', 'A refused private receipt must roll back');
  assert.equal(ok(await f.call('UpdateAsset', firstRequest)).evidence_disposition, 'duplicate');
  const health = ok(await f.call('GetHealth'));
  const history = ok(
    await f.call('GetAssetMovementHistory', {
      query_id: uuid(),
      entity_id: asset.id,
      allocation_context: health.allocation_context,
    }),
  );
  assert.equal(history.readings.length, 1);
  assert.equal(history.readings[0].value.latitude, 10);
  ok(await f.call('ReleaseHistoryView', { release_token: history.release_token }));
});
test('Observation creation bounds the complete image and rolls back its pair, evidence and retry before correction', async (t) => {
  const f = await fixture(t, {
    resourceImageBytes: 65536,
    limits: { ...defaults.limits, max_message_bytes: 212992 },
  });
  const sourceAssetId = await f.sourceAssetId();
  const make = (description) => {
    const observation = uuid(),
      publisher = uuid(),
      origin = { kind: 'publisher', publisher_id: publisher };
    return {
      request_id: uuid(),
      observation_id: observation,
      publisher_id: publisher,
      source_asset_id: sourceAssetId,
      description: { name: 'boundary', description },
      report: report(f.core.dataset, observation, origin, 1, {
        geometry: {
          state: 'value',
          classification: 'state_until_changed',
          observed_at: null,
          value: {
            type: 'LineString',
            coordinates: Array.from({ length: 1024 }, (_, i) => [
              1.123456789012345e-100 + i * 1e-115,
              -1.123456789012345e-100,
            ]),
          },
        },
      }),
    };
  };
  const small = make('\u0000'.repeat(2200)),
    pair = ok(await f.call('CreateObservation', small));
  const imageBytes = Buffer.byteLength(JSON.stringify(pair.observation));
  assert.ok(imageBytes > 65536 - 1024 && imageBytes <= 65536);
  const withdraw = (creation) => ({
    observation_id: creation.observation_id,
    publisher_id: creation.publisher_id,
    report: report(
      f.core.dataset,
      creation.observation_id,
      { kind: 'publisher', publisher_id: creation.publisher_id },
      2,
      { type: { state: 'withdrawn', classification: 'state_until_changed', observed_at: null } },
    ),
  });
  assert.equal(
    ok(await f.call('ReportObservation', withdraw(small))).observation.type.state,
    'withdrawn',
  );
  const database = new Database(join(f.directory, 'core.sqlite'), { readonly: true });
  t.after(() => database.close());
  const counts = () =>
    Object.fromEntries(
      [
        'entity_identity',
        'observations',
        'entities',
        'entity_track_sources',
        'evidence_reports',
        'evidence_sections',
        'evidence_readings',
        'evidence_positions',
        'retry',
        'commit_log',
      ].map((table) => [table, database.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]),
    );
  const before = counts(),
    oversized = make('\u0000'.repeat(4096));
  const rejected = await f.call('CreateObservation', oversized);
  assert.equal(rejected.status, 429, 'The complete Observation must fit 65536 bytes before commit');
  assert.equal(rejected.json.error.code, 'resource_limit');
  assert.deepEqual(counts(), before);
  assert.equal(
    (await f.call('GetObservation', { observation_id: oversized.observation_id })).status,
    404,
  );
  const corrected = ok(
    await f.call('CreateObservation', {
      ...oversized,
      description: { name: 'boundary', description: 'corrected' },
    }),
  );
  assert.equal(corrected.observation.id, oversized.observation_id);
  assert.equal(
    ok(await f.call('ReportObservation', withdraw(oversized))).observation.type.state,
    'withdrawn',
  );
});
test('independent evidence admission, frozen history, exact times, structural retry and restart', async (t) => {
  const f = await fixture(t);
  const publisher = uuid(),
    observationId = uuid(),
    origin = { kind: 'publisher', publisher_id: publisher };
  const p2 = telemetry(origin, 51.001, '2026-10-21T12:00:11Z');
  const r11 = report(f.core.dataset, observationId, origin, '18446744073709551614', {
    telemetry: p2,
  });
  const creation = {
    source_asset_id: await f.sourceAssetId(),
    request_id: uuid(),
    observation_id: observationId,
    publisher_id: publisher,
    report: r11,
  };
  const created = await f.call('CreateObservation', creation);
  const pair = ok(created);
  const r10 = report(f.core.dataset, observationId, origin, 10, {
    telemetry: telemetry(origin, 51, '2026-10-21T12:00:10Z'),
  });
  ok(
    await f.call('ReportObservation', {
      observation_id: observationId,
      publisher_id: publisher,
      report: r10,
    }),
  );
  const health = ok(await f.call('GetHealth'));
  const query = {
    entity_id: observationId,
    query_id: uuid(),
    allocation_context: health.allocation_context,
    page_size: 1,
  };
  const first = ok(await f.call('GetObservationMovementHistory', query));
  assert.equal(first.readings[0].value.latitude, 51);
  const r12 = report(
    f.core.dataset,
    observationId,
    origin,
    12,
    { telemetry: telemetry(origin, 50.9, '2026-10-21T12:00:09Z') },
    'history_only',
  );
  const changed = await f.call('ReportObservation', {
    observation_id: observationId,
    publisher_id: publisher,
    report: r12,
  });
  ok(changed);
  assert.ok(changed.json.commit_cursor);
  const retried = ok(
    await f.call(
      'GetObservationMovementHistory',
      JSON.parse(JSON.stringify(query, Object.keys(query).reverse())),
    ),
  );
  assert.equal(first.view_id, retried.view_id);
  assert.equal(first.expires_at, retried.expires_at);
  const last = ok(
    await f.call('GetObservationMovementHistory', { page_token: first.next_page_token }),
  );
  assert.equal(last.readings[0].value.latitude, 51.001);
  assert.equal(last.next_page_token, null);
  const snapshot = ok(
    await f.call('ReadSnapshot', {
      load_id: uuid(),
      allocation_context: health.allocation_context,
      page_size: 100,
      ...limits,
    }),
  );
  for (const r of [r10, r11, r12])
    assert.equal(
      ok(
        await f.call('ReportObservation', {
          observation_id: observationId,
          publisher_id: publisher,
          report: r,
        }),
      ).evidence_disposition,
      'duplicate',
    );
  const conflict = structuredClone(r10);
  conflict.report_id = uuid();
  conflict.sequence = '18446744073709551615';
  conflict.sections.telemetry.value.position.latitude = 51.0001;
  const refused = await f.call('ReportObservation', {
    observation_id: observationId,
    publisher_id: publisher,
    report: conflict,
  });
  assert.equal(refused.json.error.code, 'constituent_conflict');
  const collision = { ...r11, report_id: uuid() };
  assert.equal(
    (
      await f.call('ReportObservation', {
        observation_id: observationId,
        publisher_id: publisher,
        report: collision,
      })
    ).json.error.code,
    'section_sequence_conflict',
  );
  const replay = ok(
    await f.call('ReadChanges', { from_cursor: snapshot.baseline_cursor, ...limits }),
  );
  assert.equal(replay.messages.length, 0);
  const carried = report(f.core.dataset, observationId, origin, '18446744073709551615', {
    telemetry: p2,
  });
  ok(
    await f.call('ReportObservation', {
      observation_id: observationId,
      publisher_id: publisher,
      report: carried,
    }),
  );
  assert.equal(
    ok(await f.call('GetObservation', { observation_id: observationId })).telemetry.evidence
      .sequence,
    '18446744073709551615',
  );
  const currentTrack = ok(await f.call('GetTrack', { track_id: pair.track.id }));
  assert.equal(currentTrack.telemetry.observed_at, '2026-10-21T12:00:11Z');
  await f.restart();
  assert.equal(ok(await f.call('CreateObservation', creation)).track.id, pair.track.id);
  assert.equal(
    (await f.call('GetObservationMovementHistory', { page_token: first.next_page_token })).json
      .error.code,
    'allocation_expired',
  );
  const newHealth = ok(await f.call('GetHealth'));
  const all = ok(
    await f.call('GetTrackMovementHistory', {
      entity_id: pair.track.id,
      query_id: uuid(),
      allocation_context: newHealth.allocation_context,
    }),
  );
  assert.deepEqual(
    all.readings.map((r) => r.value.latitude),
    [50.9, 51, 51.001],
  );
  assert.ok(
    all.readings.every(
      (r) => r.source_entity_id === observationId && r.track_ids[0] === pair.track.id,
    ),
  );
});
test('nanosecond order preserves spelling and future classification stays uncertain', async (t) => {
  const f = await fixture(t);
  const origin = { kind: 'publisher', publisher_id: uuid() },
    entity = uuid();
  const create = {
    source_asset_id: await f.sourceAssetId(),
    observation_id: entity,
    publisher_id: origin.publisher_id,
    request_id: uuid(),
  };
  ok(await f.call('CreateObservation', create));
  const times = [
    '2026-10-21T12:00:00.0000002Z',
    '2026-10-21T12:00:00.0000001Z',
    '2026-10-21T12:00:00.100Z',
    '2026-10-21T12:00:00.1Z',
    '9999-12-31T23:59:59.999999999Z',
  ];
  for (const [i, at] of times.entries())
    ok(
      await f.call('ReportObservation', {
        observation_id: entity,
        publisher_id: origin.publisher_id,
        report: report(f.core.dataset, entity, origin, i + 1, {
          telemetry: telemetry(origin, i, at),
        }),
      }),
    );
  await f.restart();
  const health = ok(await f.call('GetHealth'));
  const page = ok(
    await f.call('GetObservationMovementHistory', {
      entity_id: entity,
      query_id: uuid(),
      allocation_context: health.allocation_context,
    }),
  );
  assert.equal(page.readings[0].observed_at, times[1]);
  assert.equal(page.readings[1].observed_at, times[0]);
  assert.deepEqual(
    new Set(page.readings.slice(2, 4).map((r) => r.observed_at)),
    new Set(times.slice(2, 4)),
  );
  assert.equal(page.readings.at(-1).time_status, 'uncertain');
  const known = ok(
    await f.call('GetObservationMovementHistory', {
      entity_id: entity,
      query_id: uuid(),
      allocation_context: health.allocation_context,
      time_groups: ['known'],
    }),
  );
  assert.equal(known.readings.length, 4);
});
test('Unicode Entity identity, tombstones and continued publisher evidence after Asset deletion', async (t) => {
  const f = await fixture(t);
  const r = registration('Σ');
  r.capabilities = { commands: [] };
  const asset = ok(await f.call('RegisterAsset', r)).asset;
  assert.equal(ok(await f.call('GetAssetByAlias', { alias: 'ς' })).id, asset.id);
  const collision = await f.call('CreateGeofeature', {
    geofeature_id: uuid(),
    request_id: uuid(),
    alias: 'σ',
    geometry: { type: 'Point', coordinates: [0, 0] },
  });
  assert.equal(collision.json.error.code, 'identity_conflict');
  const publisher = uuid(),
    entity = uuid();
  const creation = {
    observation_id: entity,
    request_id: uuid(),
    publisher_id: publisher,
    source_asset_id: asset.id,
  };
  for (const source of [undefined, null, uuid()]) {
    const refused = await f.call('CreateObservation', { ...creation, source_asset_id: source });
    assert.equal(
      refused.json.error.code,
      typeof source === 'string' ? 'asset_not_found' : 'invalid_request',
    );
  }
  const pair = ok(await f.call('CreateObservation', creation));
  assert.equal(pair.observation.source_asset_id, asset.id);
  assert.deepEqual(pair.track.sources, [
    { observation_id: entity, publisher_id: publisher, source_asset_id: asset.id },
  ]);
  assert.equal(
    (
      await f.call('CreateObservation', {
        ...creation,
        request_id: uuid(),
        observation_id: uuid(),
        source_asset_id: pair.track.id,
      })
    ).json.error.code,
    'asset_not_found',
  );
  const racingId = uuid();
  const [deleted, racing] = await Promise.all([
    f.call('DeleteAsset', { asset_id: asset.id, request_id: uuid() }),
    f.call('CreateObservation', { ...creation, request_id: uuid(), observation_id: racingId }),
  ]);
  ok(deleted);
  if (racing.status === 200) {
    assert.equal(ok(racing).observation.source_asset_id, asset.id);
  } else {
    assert.equal(racing.json.error.code, 'asset_not_found');
    assert.equal((await f.call('GetObservation', { observation_id: racingId })).status, 404);
  }
  assert.deepEqual(ok(await f.call('CreateObservation', creation)), pair);
  assert.equal((await f.call('RegisterAsset', r)).json.error.code, 'asset_not_found');
  assert.equal(
    (
      await f.call('CreateObservation', {
        observation_id: uuid(),
        request_id: uuid(),
        publisher_id: publisher,
        source_asset_id: asset.id,
      })
    ).json.error.code,
    'asset_not_found',
  );
  const result = ok(
    await f.call('ReportObservation', {
      observation_id: entity,
      publisher_id: publisher,
      report: report(f.core.dataset, entity, { kind: 'publisher', publisher_id: publisher }, 1, {
        type: { state: 'withdrawn', classification: 'state_until_changed', observed_at: null },
      }),
    }),
  );
  assert.equal(result.track.id, pair.track.id);
  assert.equal(result.track.type.state, 'withdrawn');
  assert.equal(result.observation.source_asset_id, asset.id);
  assert.deepEqual(result.track.sources, pair.track.sources);
  await f.restart();
  assert.deepEqual(
    ok(await f.call('GetObservation', { observation_id: entity })),
    result.observation,
  );
});
test('current time status survives wall-clock passage, carry-forward, new clients, fusion and Restart', async (t) => {
  const f = await fixture(t);
  const registered = registration();
  const asset = ok(await f.call('RegisterAsset', registered)).asset;
  const assetOrigin = { kind: 'asset_process', process_generation: asset.process_generation };
  const publisher = { kind: 'publisher', publisher_id: uuid() },
    observationId = uuid();
  const future = new Date(Date.now() + 5000).toISOString();
  const past = '2026-10-21T12:00:00.000000001Z';
  const make = (origin) => ({
    ...telemetry(origin, 51, future),
    source_times: { altitude: null, airspeed: past },
    value: {
      position: { latitude: 51, longitude: -1 },
      altitude: null,
      ground_speed: 7,
      airspeed: 4,
    },
    constituents: {
      ...telemetry(origin, 51).constituents,
      airspeed: { origin, reading_id: uuid() },
    },
  });
  const assetTelemetry = make(assetOrigin),
    observationTelemetry = make(publisher),
    reserve = uuid();
  const power = {
    state: 'value',
    classification: 'dated_measurement',
    observed_at: future,
    value: {
      external_power: false,
      reserves: [
        {
          id: reserve,
          kind: 'battery',
          remaining_percent: 50,
          voltage_volts: 12,
          current_amperes: null,
        },
      ],
    },
    source_times: {
      external_power: past,
      reserves: { [reserve]: { voltage_volts: past, current_amperes: null } },
    },
  };
  const assetReport = report(f.core.dataset, asset.id, assetOrigin, 1, {
    telemetry: assetTelemetry,
    power,
  });
  const request = { request_id: uuid(), asset_id: asset.id, report: assetReport };
  const expected = {
    position: 'uncertain',
    altitude: 'unknown',
    ground_speed: 'uncertain',
    airspeed: 'known',
  };
  assert.deepEqual(ok(await f.call('UpdateAsset', request)).asset.telemetry.time_status, expected);
  const observationReport = report(f.core.dataset, observationId, publisher, 1, {
    telemetry: observationTelemetry,
    attitude: {
      state: 'error',
      classification: 'dated_measurement',
      observed_at: future,
      error: { code: 'offline' },
    },
  });
  const creation = {
    source_asset_id: await f.sourceAssetId(),
    request_id: uuid(),
    observation_id: observationId,
    publisher_id: publisher.publisher_id,
    report: observationReport,
  };
  const pair = ok(await f.call('CreateObservation', creation));
  assert.deepEqual(pair.track.telemetry.time_status, expected);
  assert.equal(pair.observation.attitude.time_status, 'uncertain');
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, Date.parse(future) - Date.now() + 20)),
  );
  assert.ok(Date.now() > Date.parse(future), 'The original future time has actually passed');
  const check = (image) => {
    assert.deepEqual(image.telemetry.time_status, expected);
    assert.equal(image.telemetry.observed_at, future);
    assert.deepEqual(image.telemetry.source_times, { altitude: null, airspeed: past });
  };
  check(ok(await f.call('UpdateAsset', request)).asset);
  check(ok(await f.call('CreateObservation', creation)).observation);
  const carried = {
    ...assetTelemetry,
    observed_at: past,
    source_times: { ...assetTelemetry.source_times, position: future, ground_speed: future },
  };
  const updated = ok(
    await f.call('UpdateAsset', {
      request_id: uuid(),
      asset_id: asset.id,
      report: report(f.core.dataset, asset.id, assetOrigin, 2, { telemetry: carried }),
    }),
  ).asset;
  assert.deepEqual(updated.telemetry.time_status, expected);
  assert.deepEqual(updated.telemetry.constituents, assetTelemetry.constituents);
  assert.deepEqual(updated.power.time_status, {
    external_power: 'known',
    reserves: {
      [reserve]: {
        remaining_percent: 'uncertain',
        voltage_volts: 'known',
        current_amperes: 'unknown',
      },
    },
  });
  check(
    ok(
      await f.call('ReportObservation', {
        observation_id: observationId,
        publisher_id: publisher.publisher_id,
        report: report(f.core.dataset, observationId, publisher, 2, {
          telemetry: observationTelemetry,
        }),
      }),
    ).track,
  );
  const newKey = registration();
  ok(
    await f.call('CreateApiKey', {
      request_id: uuid(),
      api_key_id: newKey.api_key_id,
      secret: newKey.secret,
    }),
  );
  const credentials = { Authorization: `Bearer ${newKey.secret}` };
  for (const restart of [false, true]) {
    if (restart) await f.restart();
    const readAsset = ok(await f.call('GetAsset', { asset_id: asset.id }, credentials));
    assert.deepEqual(readAsset.telemetry.time_status, expected);
    assert.deepEqual(readAsset.power.time_status, updated.power.time_status);
    const readObservation = ok(
      await f.call('GetObservation', { observation_id: observationId }, credentials),
    );
    check(readObservation);
    assert.equal(readObservation.attitude.time_status, 'uncertain');
    check(ok(await f.call('GetTrack', { track_id: pair.track.id }, credentials)));
    const health = ok(await f.call('GetHealth', {}, credentials));
    const snapshot = ok(
      await f.call(
        'ReadSnapshot',
        {
          load_id: uuid(),
          allocation_context: health.allocation_context,
          page_size: 100,
          ...limits,
        },
        credentials,
      ),
    );
    const images = snapshot.items.map((item) => item.image);
    assert.deepEqual(images.find((image) => image.id === asset.id).telemetry.time_status, expected);
    check(images.find((image) => image.id === pair.track.id));
    const history = ok(
      await f.call(
        'GetAssetMovementHistory',
        { entity_id: asset.id, query_id: uuid(), allocation_context: health.allocation_context },
        credentials,
      ),
    );
    assert.equal(history.readings.length, 1);
    assert.equal(history.readings[0].time_status, 'uncertain');
    assert.equal(history.readings[0].observed_at, future);
    ok(await f.call('ReleaseSnapshot', { release_token: snapshot.release_token }, credentials));
    ok(await f.call('ReleaseHistoryView', { release_token: history.release_token }, credentials));
  }
});
test('component quantity timing survives reads and Restart while replacement removes optional quantities', async (t) => {
  const f = await fixture(t);
  const asset = ok(await f.call('RegisterAsset', registration())).asset;
  const origin = { kind: 'asset_process', process_generation: asset.process_generation };
  const past = '2026-10-21T12:00:00.000000001Z',
    future = '9999-12-31T23:59:59.999999999Z';
  const fuel = uuid(),
    removedFuel = uuid();
  const sections = {
    communications: {
      state: 'value',
      classification: 'state_until_changed',
      observed_at: future,
      value: { bandwidth_bps: 1200 },
      source_times: { bandwidth_bps: past },
    },
    status: {
      state: 'value',
      classification: 'state_until_changed',
      observed_at: past,
      value: { condition: 'degraded', explanation: 'Navigation unavailable' },
      source_times: { condition: null },
    },
    camera: {
      state: 'value',
      classification: 'dated_measurement',
      observed_at: future,
      value: { zoom_ratio: null, recording: false, capturing: true },
      source_times: { zoom_ratio: null, recording: past },
    },
    camera_optics: {
      state: 'value',
      classification: 'state_until_changed',
      observed_at: null,
      value: { horizontal_fov: 90, vertical_fov: 60 },
      source_times: { horizontal_fov: past, vertical_fov: future },
    },
    gimbal: {
      state: 'value',
      classification: 'dated_measurement',
      observed_at: past,
      value: { bearing: null, elevation: -90 },
      source_times: { bearing: null },
    },
    power: {
      state: 'value',
      classification: 'dated_measurement',
      observed_at: future,
      value: {
        external_power: null,
        reserves: [
          { id: fuel, kind: 'fuel', remaining_percent: 38 },
          { id: removedFuel, kind: 'fuel', remaining_percent: null },
        ],
      },
      source_times: {
        external_power: null,
        reserves: { [removedFuel]: { remaining_percent: past } },
      },
    },
    telemetry: {
      ...telemetry(origin, 51, past),
      value: {
        position: { latitude: 51, longitude: -1 },
        altitude: null,
        ground_speed: 0,
        airspeed: 4,
      },
      constituents: {
        ...telemetry(origin, 51, past).constituents,
        airspeed: { origin, reading_id: uuid() },
      },
      source_times: { airspeed: null },
    },
  };
  const expected = {
    communications: { bandwidth_bps: 'known' },
    status: { condition: 'unknown' },
    camera: { zoom_ratio: 'unknown', recording: 'known', capturing: 'uncertain' },
    camera_optics: { horizontal_fov: 'known', vertical_fov: 'uncertain' },
    gimbal: { bearing: 'unknown', elevation: 'known' },
    power: {
      external_power: 'unknown',
      reserves: {
        [fuel]: { remaining_percent: 'uncertain' },
        [removedFuel]: { remaining_percent: 'known' },
      },
    },
    telemetry: { position: 'known', altitude: 'known', ground_speed: 'known', airspeed: 'unknown' },
  };
  const accepted = ok(
    await f.call('UpdateAsset', {
      asset_id: asset.id,
      request_id: uuid(),
      report: report(f.core.dataset, asset.id, origin, 1, sections),
    }),
  ).asset;
  const checkAsset = (image) => {
    assert.equal(image.communications.health, 'offline');
    for (const [name, status] of Object.entries(expected)) {
      const result = name === 'communications' ? image.communications.capacity : image[name];
      assert.deepEqual(result.time_status, status, name);
      assert.deepEqual(result.value, sections[name].value, name);
      assert.deepEqual(result.source_times, sections[name].source_times, name);
      assert.equal(result.observed_at, sections[name].observed_at, name);
    }
  };
  checkAsset(accepted);
  const publisher = uuid(),
    observation = uuid(),
    publisherOrigin = { kind: 'publisher', publisher_id: publisher };
  const geometry = {
    state: 'value',
    classification: 'dated_measurement',
    observed_at: future,
    source_times: { geometry: past },
    value: { type: 'Point', coordinates: [-1, 51] },
  };
  const pair = ok(
    await f.call('CreateObservation', {
      source_asset_id: await f.sourceAssetId(),
      observation_id: observation,
      publisher_id: publisher,
      request_id: uuid(),
      report: report(f.core.dataset, observation, publisherOrigin, 1, { geometry }),
    }),
  );
  const checkGeometry = (image) => {
    assert.deepEqual(image.geometry.time_status, { geometry: 'known' });
    assert.deepEqual(image.geometry.value, { type: 'Point', coordinates: [-1, 51] });
    assert.deepEqual(image.geometry.source_times, { geometry: past });
    assert.equal(image.geometry.observed_at, future);
    assert.equal(image.geometry.evidence.entity_id, observation);
  };
  checkGeometry(pair.observation);
  checkGeometry(pair.track);
  for (const restart of [false, true]) {
    if (restart) await f.restart();
    checkAsset(ok(await f.call('GetAsset', { asset_id: asset.id })));
    checkGeometry(ok(await f.call('GetObservation', { observation_id: observation })));
    checkGeometry(ok(await f.call('GetTrack', { track_id: pair.track.id })));
    const health = ok(await f.call('GetHealth'));
    const snapshot = ok(
      await f.call('ReadSnapshot', {
        load_id: uuid(),
        allocation_context: health.allocation_context,
        page_size: 100,
        ...limits,
      }),
    );
    checkAsset(snapshot.items.find((item) => item.resource_id === asset.id).image);
    checkGeometry(snapshot.items.find((item) => item.resource_id === pair.track.id).image);
    ok(await f.call('ReleaseSnapshot', { release_token: snapshot.release_token }));
  }
  const reducedTelemetry = structuredClone(sections.telemetry);
  delete reducedTelemetry.value.airspeed;
  delete reducedTelemetry.constituents.airspeed;
  delete reducedTelemetry.source_times.airspeed;
  const replaced = ok(
    await f.call('UpdateAsset', {
      asset_id: asset.id,
      request_id: uuid(),
      report: report(f.core.dataset, asset.id, origin, 2, {
        camera: {
          state: 'value',
          classification: 'dated_measurement',
          observed_at: null,
          value: { zoom_ratio: 1 },
        },
        telemetry: reducedTelemetry,
        power: {
          state: 'value',
          classification: 'dated_measurement',
          observed_at: past,
          value: {
            external_power: true,
            reserves: [{ id: fuel, kind: 'fuel', remaining_percent: 37 }],
          },
        },
      }),
    }),
  ).asset;
  assert.deepEqual(replaced.camera.value, { zoom_ratio: 1 });
  assert.deepEqual(replaced.camera.time_status, { zoom_ratio: 'unknown' });
  assert.equal(Object.hasOwn(replaced.camera, 'source_times'), false);
  assert.equal(Object.hasOwn(replaced.telemetry.value, 'airspeed'), false);
  assert.equal(Object.hasOwn(replaced.telemetry.constituents, 'airspeed'), false);
  assert.deepEqual(replaced.telemetry.time_status, {
    position: 'known',
    altitude: 'known',
    ground_speed: 'known',
  });
  assert.deepEqual(replaced.power.time_status, {
    external_power: 'known',
    reserves: { [fuel]: { remaining_percent: 'known' } },
  });
  assert.deepEqual(
    replaced.camera_optics,
    accepted.camera_optics,
    'Omitting a section retains all its facts',
  );
  const withdrawnAsset = ok(
    await f.call('UpdateAsset', {
      asset_id: asset.id,
      request_id: uuid(),
      report: report(f.core.dataset, asset.id, origin, 3, {
        status: { state: 'withdrawn', classification: 'state_until_changed', observed_at: null },
        camera: { state: 'withdrawn', classification: 'state_until_changed', observed_at: past },
        gimbal: { state: 'withdrawn', classification: 'state_until_changed', observed_at: future },
      }),
    }),
  ).asset;
  for (const [name, status] of [
    ['status', 'unknown'],
    ['camera', 'known'],
    ['gimbal', 'uncertain'],
  ]) {
    assert.equal(withdrawnAsset[name].state, 'withdrawn');
    assert.equal(withdrawnAsset[name].time_status, status);
    assert.equal(Object.hasOwn(withdrawnAsset[name], 'value'), false);
    assert.equal(Object.hasOwn(withdrawnAsset[name], 'source_times'), false);
  }
  const withdrawn = {
    state: 'withdrawn',
    classification: 'state_until_changed',
    observed_at: future,
  };
  const withdrawal = report(f.core.dataset, observation, publisherOrigin, 2, {
    geometry: withdrawn,
  });
  const ended = ok(
    await f.call('ReportObservation', {
      observation_id: observation,
      publisher_id: publisher,
      report: withdrawal,
    }),
  );
  for (const image of [ended.observation, ended.track])
    assert.deepEqual(image.geometry, {
      ...withdrawn,
      time_status: 'uncertain',
      evidence: {
        dataset_id: f.core.dataset,
        entity_id: observation,
        origin: publisherOrigin,
        report_id: withdrawal.report_id,
        sequence: '2',
        section: 'geometry',
      },
    });
  await f.restart();
  assert.deepEqual(ok(await f.call('GetAsset', { asset_id: asset.id })), withdrawnAsset);
  assert.deepEqual(
    ok(await f.call('GetTrack', { track_id: pair.track.id })).geometry,
    ended.track.geometry,
  );
});
test('history-only first admission keeps a future reading uncertain when later selected as current', async (t) => {
  const f = await fixture(t),
    publisher = uuid(),
    entity = uuid();
  const origin = { kind: 'publisher', publisher_id: publisher };
  const pair = ok(
    await f.call('CreateObservation', {
      source_asset_id: await f.sourceAssetId(),
      observation_id: entity,
      publisher_id: publisher,
      request_id: uuid(),
      report: report(f.core.dataset, entity, origin, 1, { telemetry: telemetry(origin, 50) }),
    }),
  );
  const future = new Date(Date.now() + 5000).toISOString(),
    reading = telemetry(origin, 51, future);
  const historical = report(
    f.core.dataset,
    entity,
    origin,
    2,
    { telemetry: reading },
    'history_only',
  );
  const historyRequest = { observation_id: entity, publisher_id: publisher, report: historical };
  const admitted = ok(await f.call('ReportObservation', historyRequest));
  assert.deepEqual(admitted.observation, pair.observation);
  assert.deepEqual(admitted.track, pair.track);
  const health = ok(await f.call('GetHealth'));
  const query = {
    entity_id: entity,
    query_id: uuid(),
    allocation_context: health.allocation_context,
    time_groups: ['uncertain'],
  };
  const frozen = ok(await f.call('GetObservationMovementHistory', query));
  assert.equal(frozen.readings.length, 1);
  assert.equal(frozen.readings[0].time_status, 'uncertain');
  assert.equal(
    frozen.readings[0].source_evidence.reading_id,
    reading.constituents.position.reading_id,
  );
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, Date.parse(future) - Date.now() + 20)),
  );
  assert.ok(Date.now() > Date.parse(future), 'The source time passed before current admission');
  const carried = report(f.core.dataset, entity, origin, 3, { telemetry: reading });
  const selected = await f.call('ReportObservation', { ...historyRequest, report: carried });
  const expected = { position: 'uncertain', altitude: 'uncertain', ground_speed: 'uncertain' };
  for (const image of [ok(selected).observation, ok(selected).track]) {
    assert.deepEqual(image.telemetry.time_status, expected);
    assert.equal(image.telemetry.observed_at, future);
    assert.deepEqual(image.telemetry.constituents, reading.constituents);
  }
  assert.deepEqual(ok(await f.call('GetObservationMovementHistory', query)), frozen);
  assert.equal(
    ok(await f.call('ReportObservation', historyRequest)).evidence_disposition,
    'duplicate',
  );
  assert.equal(
    ok(await f.call('ReportObservation', { ...historyRequest, report: carried }))
      .evidence_disposition,
    'duplicate',
  );
  assert.deepEqual(
    ok(await f.call('ReadChanges', { from_cursor: selected.json.commit_cursor, ...limits }))
      .messages,
    [],
  );
  await f.restart();
  assert.deepEqual(
    ok(await f.call('GetObservation', { observation_id: entity })).telemetry.time_status,
    expected,
  );
  assert.deepEqual(
    ok(await f.call('GetTrack', { track_id: pair.track.id })).telemetry.time_status,
    expected,
  );
  const fresh = telemetry(origin, 51, future);
  const newReading = ok(
    await f.call('ReportObservation', {
      ...historyRequest,
      report: report(f.core.dataset, entity, origin, 4, { telemetry: fresh }),
    }),
  );
  assert.deepEqual(newReading.observation.telemetry.time_status, {
    position: 'known',
    altitude: 'known',
    ground_speed: 'known',
  });
  const afterRestart = ok(await f.call('GetHealth'));
  for (const [group, ids] of [
    ['uncertain', [reading.constituents.position.reading_id]],
    [
      'known',
      [
        pair.observation.telemetry.constituents.position.reading_id,
        fresh.constituents.position.reading_id,
      ],
    ],
  ]) {
    const page = ok(
      await f.call('GetTrackMovementHistory', {
        entity_id: pair.track.id,
        query_id: uuid(),
        allocation_context: afterRestart.allocation_context,
        time_groups: [group],
      }),
    );
    assert.deepEqual(
      page.readings.map((value) => value.source_evidence.reading_id),
      ids,
    );
    assert.ok(page.readings.every((value) => value.time_status === group));
    ok(await f.call('ReleaseHistoryView', { release_token: page.release_token }));
  }
});
test('HTTP refuses publisher time_status without evidence or retry effects and permits correction of the same identity', async (t) => {
  const f = await fixture(t),
    asset = ok(await f.call('RegisterAsset', registration())).asset;
  const publisher = uuid(),
    entity = uuid(),
    origin = { kind: 'publisher', publisher_id: publisher };
  const assetOrigin = { kind: 'asset_process', process_generation: asset.process_generation };
  const db = new Database(join(f.directory, 'core.sqlite'), { readonly: true });
  t.after(() => db.close());
  const counts = () =>
    Object.fromEntries(
      [
        'evidence_reports',
        'evidence_sections',
        'evidence_readings',
        'evidence_positions',
        'retry',
        'commit_log',
        'entity_identity',
      ].map((table) => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]),
    );
  const requests = [
    [
      'UpdateAsset',
      {
        asset_id: asset.id,
        request_id: uuid(),
        report: report(f.core.dataset, asset.id, assetOrigin, 1, {
          telemetry: telemetry(assetOrigin, 51),
        }),
      },
    ],
    [
      'CreateObservation',
      {
        source_asset_id: await f.sourceAssetId(),
        observation_id: entity,
        publisher_id: publisher,
        request_id: uuid(),
        report: report(f.core.dataset, entity, origin, 1, { telemetry: telemetry(origin, 51) }),
      },
    ],
    [
      'ReportObservation',
      {
        observation_id: entity,
        publisher_id: publisher,
        report: report(f.core.dataset, entity, origin, 2, { telemetry: telemetry(origin, 52) }),
      },
    ],
  ];
  for (const [name, request] of requests) {
    const forged = structuredClone(request);
    forged.report.sections.telemetry.time_status = {
      position: 'known',
      altitude: 'known',
      ground_speed: 'known',
    };
    const before = counts(),
      rejected = await f.call(name, forged);
    assert.equal(rejected.status, 400, name);
    assert.equal(rejected.json.error.code, 'invalid_request', name);
    assert.deepEqual(
      counts(),
      before,
      'Rejected read-only metadata must reserve no identity or evidence',
    );
    if (name === 'CreateObservation')
      assert.equal((await f.call('GetObservation', { observation_id: entity })).status, 404);
    assert.equal(ok(await f.call(name, request)).evidence_disposition, 'accepted', name);
    const acceptedCounts = counts();
    assert.equal(ok(await f.call(name, request)).evidence_disposition, 'duplicate', name);
    assert.deepEqual(
      counts(),
      acceptedCounts,
      'An exact correction replay must add no durable effects',
    );
  }
});
test('startup refuses legacy evidence without retained quantity status', async (t) => {
  const f = await fixture(t);
  await f.core.close();
  const db = new Database(join(f.directory, 'core.sqlite'));
  try {
    db.exec('ALTER TABLE evidence_readings DROP COLUMN status');
  } finally {
    db.close();
  }
  await assert.rejects(f.restart(), /database_worker_failed/);
  const retained = new Database(join(f.directory, 'core.sqlite'), { readonly: true });
  try {
    assert.equal(
      retained.pragma('table_info(evidence_readings)').some((column) => column.name === 'status'),
      false,
    );
  } finally {
    retained.close();
  }
});

test('incompatible database formats are refused before old evidence can be interpreted', async (t) => {
  for (const format of ['1', '2', '3', '4', '5']) {
    const f = await fixture(t);
    await f.core.close();
    const db = new Database(join(f.directory, 'core.sqlite'));
    try {
      assert.equal(db.prepare("SELECT value FROM core_meta WHERE key='format'").get().value, '6');
      db.prepare("UPDATE core_meta SET value=? WHERE key='format'").run(format);
    } finally {
      db.close();
    }
    await assert.rejects(f.restart(), /database_worker_failed/);
    const retained = new Database(join(f.directory, 'core.sqlite'), { readonly: true });
    try {
      assert.equal(
        retained.prepare("SELECT value FROM core_meta WHERE key='format'").get().value,
        format,
      );
    } finally {
      retained.close();
    }
  }
});

test('Asset Tags retain sourced sets, ordering and process scope through Restart', async (t) => {
  const f = await fixture(t);
  let asset = ok(await f.call('RegisterAsset', registration())).asset;
  assert.equal(Object.hasOwn(asset, 'tags'), false);
  const original = asset;
  const value = (presets) => ({
    state: 'value',
    classification: 'state_until_changed',
    observed_at: null,
    value: { presets },
  });
  const submit = async (sequence, sections, mode = 'current') => {
    const request = {
      asset_id: asset.id,
      request_id: uuid(),
      report: report(
        f.core.dataset,
        asset.id,
        { kind: 'asset_process', process_generation: asset.process_generation },
        sequence,
        sections,
        mode,
      ),
    };
    const response = await f.call('UpdateAsset', request);
    asset = ok(response).asset;
    assert.equal(asset.edit_revision, original.edit_revision);
    return { request, response };
  };
  const first = await submit(100, {
    tags: {
      ...value(['simulated']),
      observed_at: '9999-01-01T00:00:00Z',
      source_times: { presets: null },
    },
  });
  assert.equal(asset.version, '1');
  assert.deepEqual(asset.tags.time_status, { presets: 'unknown' });
  assert.deepEqual(asset.tags.value.presets, ['simulated']);
  const initialTags = asset.tags;
  const retry = await f.call('UpdateAsset', { ...first.request, request_id: uuid() });
  assert.equal(ok(retry).evidence_disposition, 'duplicate');
  assert.equal(retry.json.commit_cursor, undefined);
  assert.deepEqual(ok(retry).asset, asset);
  for (const [sequence, mode] of [
    [99, 'current'],
    [101, 'history_only'],
  ]) {
    await submit(sequence, { tags: value([]) }, mode);
    assert.deepEqual(asset.tags, initialTags);
    assert.equal(asset.version, '1');
  }
  await submit(102, {
    status: {
      state: 'value',
      classification: 'state_until_changed',
      observed_at: null,
      value: { condition: 'healthy' },
    },
  });
  assert.deepEqual(asset.tags, initialTags);
  await f.restart();
  assert.deepEqual(ok(await f.call('GetAsset', { asset_id: asset.id })).tags, initialTags);
  const health = ok(await f.call('GetHealth'));
  const replace = async (sections) => {
    const prior = asset.process_generation,
      generation = uuid();
    const challenge = ok(
      await f.call('BeginAssetContact', {
        allocation_context: health.allocation_context,
        request_id: uuid(),
        asset_id: asset.id,
        mode: 'replace',
        expected_process_generation: prior,
        process_generation: generation,
      }),
    );
    asset = ok(
      await f.call('ReplaceAssetProcess', {
        request_id: uuid(),
        asset_id: asset.id,
        expected_process_generation: prior,
        process_generation: generation,
        challenge_id: challenge.challenge_id,
        first_report: {
          ...report(
            f.core.dataset,
            asset.id,
            { kind: 'asset_process', process_generation: generation },
            1,
            sections,
          ),
          generated_at: challenge.issued_at,
          contact_proof: { challenge_id: challenge.challenge_id },
        },
      }),
    ).asset;
  };
  await replace({});
  assert.deepEqual(asset.tags, initialTags, 'Omission preserves the original process evidence');
  await replace({ tags: { ...value([]), observed_at: '2026-10-21T12:00:00Z' } });
  assert.deepEqual(asset.tags.value.presets, []);
  assert.equal(asset.tags.evidence.sequence, '1');
  assert.equal(asset.tags.evidence.origin.process_generation, asset.process_generation);
  assert.deepEqual(asset.tags.time_status, { presets: 'known' });
  await submit(2, {
    tags: {
      state: 'error',
      classification: 'dated_measurement',
      observed_at: null,
      error: { code: 'unavailable' },
    },
  });
  assert.equal(asset.tags.state, 'error');
  assert.equal(asset.tags.time_status, 'unknown');
  await submit(3, {
    tags: { state: 'withdrawn', classification: 'state_until_changed', observed_at: null },
  });
  const retained = asset.tags;
  await f.restart();
  asset = ok(await f.call('GetAsset', { asset_id: asset.id }));
  assert.deepEqual(asset.tags, retained);
  assert.equal(asset.edit_revision, '0');
  for (const tags of [
    null,
    value(['simulated', 'simulated']),
    value(['unknown']),
    { ...value([]), extra: true },
  ]) {
    const refused = await f.call('UpdateAsset', {
      asset_id: asset.id,
      request_id: uuid(),
      report: report(
        f.core.dataset,
        asset.id,
        { kind: 'asset_process', process_generation: asset.process_generation },
        4,
        { tags },
      ),
    });
    assert.equal(refused.status, 400);
    assert.deepEqual(ok(await f.call('GetAsset', { asset_id: asset.id })).tags, retained);
  }
});
test('Bearing Measurements keep one source sighting apart from target state and position history', async (t) => {
  const f = await fixture(t);
  const source = ok(
    await f.call('RegisterAsset', { ...registration(), capabilities: { commands: [] } }),
  ).asset;
  const sourceOrigin = { kind: 'asset_process', process_generation: source.process_generation };
  const moveSource = async (sequence, latitude) =>
    ok(
      await f.call('UpdateAsset', {
        request_id: uuid(),
        asset_id: source.id,
        report: report(f.core.dataset, source.id, sourceOrigin, sequence, {
          telemetry: telemetry(sourceOrigin, latitude),
        }),
      }),
    );
  await moveSource(1, 60);
  const publisherId = uuid(),
    observationId = uuid(),
    origin = { kind: 'publisher', publisher_id: publisherId };
  const sighting = (bearing, observedAt = '2026-10-21T12:00:00.0000001Z') => ({
    state: 'value',
    classification: 'dated_measurement',
    observed_at: observedAt,
    value: {
      sensor_origin: {
        position: { latitude: 51, longitude: -1 },
        altitude: { metres: 0, reference: 'wgs84_ellipsoid' },
      },
      bearing,
      elevation: null,
      bearing_interval: { start: 350, end: 10 },
    },
  });
  const sourced = (accepted, time_status, entity = observationId) => ({
    ...accepted.sections.bearing_measurement,
    evidence: {
      dataset_id: f.core.dataset,
      entity_id: entity,
      origin: accepted.origin,
      report_id: accepted.report_id,
      sequence: accepted.sequence,
      section: 'bearing_measurement',
    },
    time_status,
  });
  const reportOf = (sequence, section, mode) =>
    report(f.core.dataset, observationId, origin, sequence, { bearing_measurement: section }, mode);
  const submit = (accepted, credentials) =>
    f.call(
      'ReportObservation',
      { observation_id: observationId, publisher_id: publisherId, report: accepted },
      credentials,
    );
  const positions = async (name, entity_id) => {
    const { allocation_context } = ok(await f.call('GetHealth'));
    return ok(await f.call(name, { entity_id, query_id: uuid(), allocation_context })).readings;
  };

  const first = reportOf(1, sighting(0));
  const creation = {
    source_asset_id: source.id,
    request_id: uuid(),
    observation_id: observationId,
    publisher_id: publisherId,
    report: first,
  };
  const pair = ok(await f.call('CreateObservation', creation));
  assert.deepEqual(pair.observation.bearing_measurement, sourced(first, 'known'));
  const trackId = pair.track.id;
  const directionOnly = {
    dataset_id: f.core.dataset,
    id: trackId,
    entity_type: 'track',
    version: '0',
    edit_revision: '0',
    sources: [
      { observation_id: observationId, publisher_id: publisherId, source_asset_id: source.id },
    ],
    type: {
      state: 'value',
      classification: 'state_until_changed',
      observed_at: null,
      evidence: null,
      time_status: { kind: 'unknown' },
      value: { kind: null },
    },
  };
  assert.deepEqual(pair.track, directionOnly);
  for (const field of ['telemetry', 'attitude', 'geometry'])
    assert.equal(Object.hasOwn(pair.observation, field), false, field);
  assert.deepEqual(await positions('GetObservationMovementHistory', observationId), []);
  assert.deepEqual(await positions('GetTrackMovementHistory', trackId), []);

  await moveSource(2, 61);
  assert.deepEqual(
    ok(await f.call('GetObservation', { observation_id: observationId })).bearing_measurement,
    sourced(first, 'known'),
    'Later source movement leaves the measured origin in place',
  );
  const vertical = {
    state: 'value',
    classification: 'dated_measurement',
    observed_at: null,
    value: { sensor_origin: { position: null, altitude: null }, bearing: null, elevation: 90 },
  };
  const unlocatedId = uuid();
  const unlocated = report(f.core.dataset, unlocatedId, origin, 1, {
    bearing_measurement: vertical,
  });
  assert.deepEqual(
    ok(
      await f.call('CreateObservation', {
        source_asset_id: source.id,
        request_id: uuid(),
        observation_id: unlocatedId,
        publisher_id: publisherId,
        report: unlocated,
      }),
    ).observation.bearing_measurement,
    sourced(unlocated, 'unknown', unlocatedId),
    'Unknown location and time stay null despite current source Telemetry',
  );

  const relayKey = registration();
  ok(
    await f.call('CreateApiKey', {
      request_id: uuid(),
      api_key_id: relayKey.api_key_id,
      secret: relayKey.secret,
    }),
  );
  const relay = { Authorization: `Bearer ${relayKey.secret}` };
  const future = new Date(Date.now() + 1500).toISOString();
  const current = reportOf(3, sighting(355, future));
  const accepted = ok(await submit(current));
  assert.equal(accepted.evidence_disposition, 'accepted');
  assert.deepEqual(accepted.observation.bearing_measurement, sourced(current, 'uncertain'));
  assert.equal(accepted.observation.version, '1');
  assert.deepEqual(accepted.track, { ...directionOnly, version: '1' });
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, Date.parse(future) - Date.now() + 20)),
  );
  assert.ok(Date.now() > Date.parse(future), 'The original future time has actually passed');
  await f.restart();
  for (const retry of [await submit(current, relay), await submit(current)]) {
    const replay = ok(retry);
    assert.equal(replay.evidence_disposition, 'duplicate');
    assert.deepEqual(replay.observation, accepted.observation);
    assert.deepEqual(replay.track, accepted.track);
  }
  const lostCreationReply = ok(await f.call('CreateObservation', creation, relay));
  assert.deepEqual(lostCreationReply.observation, accepted.observation);
  assert.deepEqual(lostCreationReply.track, accepted.track);

  const changedFacts = structuredClone(current);
  changedFacts.sections.bearing_measurement.value.bearing = 356;
  assert.equal((await submit(changedFacts)).json.error.code, 'report_identity_conflict');
  const occupied = reportOf(3, sighting(357));
  assert.equal((await submit(occupied)).json.error.code, 'section_sequence_conflict');
  const older = ok(await submit(reportOf(2, sighting(1))));
  assert.equal(older.evidence_disposition, 'accepted');
  const historical = ok(await submit(reportOf(9, sighting(2), 'history_only')));
  assert.equal(historical.evidence_disposition, 'accepted');
  for (const unchanged of [older, historical]) {
    assert.deepEqual(unchanged.observation, accepted.observation);
    assert.deepEqual(unchanged.track, accepted.track);
  }

  const failure = reportOf(5, {
    state: 'error',
    classification: 'dated_measurement',
    observed_at: '2026-10-21T12:00:05.5Z',
    error: { code: 'sensor_fault' },
  });
  const failed = ok(await submit(failure));
  assert.deepEqual(failed.observation.bearing_measurement, sourced(failure, 'known'));
  const withdrawal = reportOf(6, {
    state: 'withdrawn',
    classification: 'dated_measurement',
    observed_at: null,
  });
  const withdrawn = ok(await submit(withdrawal));
  assert.deepEqual(withdrawn.observation.bearing_measurement, sourced(withdrawal, 'unknown'));
  assert.deepEqual(withdrawn.track, { ...directionOnly, version: '3' });

  const database = new Database(join(f.directory, 'core.sqlite'), { readonly: true });
  t.after(() => database.close());
  const counts = () =>
    ['evidence_reports', 'evidence_sections', 'evidence_readings', 'evidence_positions'].map(
      (table) => database.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,
    );
  const invalidReport = (section, extra = {}) =>
    report(f.core.dataset, observationId, origin, 7, { bearing_measurement: section, ...extra });
  const refusals = {
    'empty source times': invalidReport({ ...sighting(0), source_times: {} }),
    'state until changed': invalidReport({
      ...sighting(0),
      classification: 'state_until_changed',
    }),
    'publisher time status': invalidReport({ ...sighting(0), time_status: 'known' }),
    'whole report with bearing outside its arc': invalidReport(sighting(180), {
      telemetry: telemetry(origin, 40),
    }),
  };
  for (const [name, invalid] of Object.entries(refusals)) {
    const before = counts();
    const refused = await submit(invalid);
    assert.equal(refused.status, 400, name);
    assert.equal(refused.json.error.code, 'invalid_request', name);
    assert.deepEqual(counts(), before, name);
  }
  const assetSighting = await f.call('UpdateAsset', {
    request_id: uuid(),
    asset_id: source.id,
    report: report(f.core.dataset, source.id, sourceOrigin, 3, {
      bearing_measurement: sighting(0),
    }),
  });
  assert.equal(assetSighting.json.error.code, 'invalid_request');
  assert.equal(
    Object.hasOwn(ok(await f.call('GetAsset', { asset_id: source.id })), 'bearing_measurement'),
    false,
  );
  assert.deepEqual(
    ok(await f.call('GetObservation', { observation_id: observationId })),
    withdrawn.observation,
  );

  const mixed = report(f.core.dataset, observationId, origin, 7, {
    bearing_measurement: sighting(3),
    telemetry: telemetry(origin, 52),
  });
  const located = ok(await submit(mixed));
  assert.deepEqual(located.observation.bearing_measurement, sourced(mixed, 'known'));
  assert.equal(located.track.telemetry.value.position.latitude, 52);
  assert.equal(Object.hasOwn(located.track, 'bearing_measurement'), false);
  for (const readings of [
    await positions('GetObservationMovementHistory', observationId),
    await positions('GetTrackMovementHistory', trackId),
  ])
    assert.deepEqual(
      readings.map((reading) => reading.value.latitude),
      [52],
      'Only reported Telemetry becomes position history',
    );
});
