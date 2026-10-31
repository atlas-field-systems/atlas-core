import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Asset,
  PROTOCOL_VERSION,
  exchanges,
  readHttp,
  readSections,
  inputSections,
  ProtocolError,
  contract,
  readJson,
  writeJson,
} from '../dist/index.js';
import * as s from './samples.mjs';

test('an Asset read retains reported tags only with its own source evidence', () => {
  const evidence = {
    dataset_id: s.asset.dataset_id,
    entity_id: s.asset.id,
    origin: s.origin,
    report_id: s.requestId,
    sequence: '1',
    section: 'tags',
  };
  const tags = {
    state: 'value',
    classification: 'state_until_changed',
    observed_at: null,
    value: { tags: ['simulated'] },
    evidence,
    time_status: { tags: 'unknown' },
  };
  assert.deepEqual(Asset.parse({ ...s.asset, tags }).tags, tags);
  assert.equal(Object.hasOwn(Asset.parse(s.asset), 'tags'), false);
  for (const [name, invalid] of Object.entries({
    'source-free value': { ...tags, evidence: null },
    'another Asset': { ...tags, evidence: { ...evidence, entity_id: s.requestId } },
    'another section': { ...tags, evidence: { ...evidence, section: 'status' } },
    'missing status': { ...tags, time_status: {} },
  }))
    assert.equal(Asset.safeParse({ ...s.asset, tags: invalid }).success, false, name);
});

test('current readers require Core-assigned statuses for each effective quantity time', () => {
  const input = {
    state: 'value',
    classification: 'dated_measurement',
    observed_at: s.time,
    source_times: { altitude: null, airspeed: s.later },
    value: { position: null, altitude: null, ground_speed: 8, airspeed: 4 },
    constituents: Object.fromEntries(
      ['position', 'altitude', 'ground_speed', 'airspeed'].map((key) => [
        key,
        { origin: s.origin, reading_id: s.requestId },
      ]),
    ),
  };
  const current = {
    ...input,
    evidence: {
      dataset_id: s.id,
      entity_id: s.assetId,
      origin: s.origin,
      report_id: s.requestId,
      sequence: '1',
      section: 'telemetry',
    },
    time_status: {
      position: 'uncertain',
      altitude: 'unknown',
      ground_speed: 'known',
      airspeed: 'uncertain',
    },
  };
  const read = (telemetry, version = PROTOCOL_VERSION) =>
    readHttp(
      exchanges.GetAsset,
      {
        status: 200,
        headers: new Headers({
          'Content-Type': 'application/json',
          'Atlas-Dataset-ID': s.id,
          'Atlas-Protocol-Version': version,
        }),
        body: new TextEncoder().encode(
          JSON.stringify({ dataset_id: s.id, data: { ...s.asset, telemetry } }),
        ),
      },
      { datasetId: s.id, request: { asset_id: s.assetId } },
    );
  assert.deepEqual(read(current).body.data.telemetry, current);
  assert.throws(() => read(current, '0.1.0'));
  const { time_status, ...missing } = current;
  assert.throws(() => read(missing));
  for (const invalid of [
    { ...time_status, altitude: 'known' },
    { ...time_status, position: 'unknown' },
    { position: 'known', altitude: 'unknown', ground_speed: 'known' },
    { ...time_status, heading: 'known' },
  ])
    assert.throws(() => read({ ...current, time_status: invalid }));
  assert.equal(inputSections.telemetry.safeParse(input).success, true);
  assert.equal(inputSections.telemetry.safeParse({ ...input, time_status }).success, false);
  const withoutAirspeed = structuredClone(current);
  delete withoutAirspeed.value.airspeed;
  delete withoutAirspeed.constituents.airspeed;
  delete withoutAirspeed.source_times.airspeed;
  assert.throws(() => read(withoutAirspeed));
  delete withoutAirspeed.time_status.airspeed;
  read(withoutAirspeed);
});

test('nested Power and section failures preserve complete time metadata', () => {
  const evidence = (section) => ({
    dataset_id: s.id,
    entity_id: s.assetId,
    origin: s.origin,
    report_id: s.requestId,
    sequence: '1',
    section,
  });
  const power = {
    state: 'value',
    classification: 'dated_measurement',
    observed_at: s.time,
    evidence: evidence('power'),
    source_times: { reserves: { [s.id]: { current_amperes: null } } },
    value: {
      external_power: null,
      reserves: [
        {
          id: s.id,
          kind: 'battery',
          remaining_percent: 50,
          voltage_volts: 12,
          current_amperes: null,
        },
      ],
    },
    time_status: {
      external_power: 'uncertain',
      reserves: {
        [s.id]: {
          remaining_percent: 'known',
          voltage_volts: 'uncertain',
          current_amperes: 'unknown',
        },
      },
    },
  };
  assert.equal(readSections.power.safeParse(power).success, true);
  for (const malformed of [
    { ...power.value, reserves: [...power.value.reserves, ...power.value.reserves] },
    { ...power.value, reserves: [{ ...power.value.reserves[0], remaining_percent: 101 }] },
  ]) {
    const invalid = { ...power, value: malformed };
    assert.equal(readSections.power.safeParse(invalid).success, false);
    const definition = contract(readSections.power, 'http_response');
    const bytes = new TextEncoder().encode(JSON.stringify(invalid));
    for (const validate of [
      () => readJson(definition, bytes),
      () => writeJson(definition, invalid),
      () =>
        readHttp(
          exchanges.GetAsset,
          {
            status: 200,
            headers: new Headers({
              'Content-Type': 'application/json',
              'Atlas-Dataset-ID': s.id,
              'Atlas-Protocol-Version': PROTOCOL_VERSION,
            }),
            body: new TextEncoder().encode(
              JSON.stringify({ dataset_id: s.id, data: { ...s.asset, power: invalid } }),
            ),
          },
          { datasetId: s.id, request: { asset_id: s.assetId } },
        ),
    ])
      assert.throws(
        validate,
        (error) => error instanceof ProtocolError && error.code === 'invalid_value',
      );
  }
  for (const edit of [
    (value) => {
      delete value.time_status.reserves[s.id].voltage_volts;
    },
    (value) => {
      value.time_status.reserves[s.id].current_amperes = 'known';
    },
    (value) => {
      value.time_status.reserves[s.requestId] = value.time_status.reserves[s.id];
    },
    (value) => {
      value.value.reserves[0] = { id: s.id, kind: 'fuel', remaining_percent: 50 };
    },
  ]) {
    const changed = structuredClone(power);
    edit(changed);
    assert.equal(readSections.power.safeParse(changed).success, false);
  }
  for (const state of ['error', 'withdrawn']) {
    const result = {
      state,
      classification: 'dated_measurement',
      observed_at: null,
      evidence: evidence('camera'),
      time_status: 'unknown',
      ...(state === 'error' ? { error: { code: 'offline' } } : {}),
    };
    assert.equal(readSections.camera.safeParse(result).success, true);
    assert.equal(readSections.camera.safeParse({ ...result, time_status: 'known' }).success, false);
    assert.equal(
      readSections.camera.safeParse({ ...result, observed_at: s.time, time_status: 'uncertain' })
        .success,
      true,
    );
  }
  assert.equal(
    readSections.status.safeParse({ ...s.asset.status, time_status: { condition: 'known' } })
      .success,
    false,
  );
});
