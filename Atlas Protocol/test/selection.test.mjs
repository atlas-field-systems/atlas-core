import test from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION, exchanges, readHttp } from '../dist/index.js';
import * as s from './samples.mjs';
const reply = (name, request, data) =>
  readHttp(
    exchanges[name],
    {
      status: 200,
      headers: new Headers({
        'Content-Type': 'application/json',
        'Atlas-Dataset-ID': s.id,
        'Atlas-Protocol-Version': PROTOCOL_VERSION,
      }),
      body: new TextEncoder().encode(JSON.stringify({ dataset_id: s.id, data })),
    },
    { datasetId: s.id, request },
  );
const page = (item) => ({ items: item === undefined ? [] : [item], next_page_token: null });
const refuses = (run) => assert.throws(run, { code: 'invalid_http' });

test('public list readers enforce AND across filters and OR within each array', () => {
  const cases = [
    [
      'ListAssets',
      { ...s.asset, alias: 'Straße' },
      { ids: s.assetId, aliases: 'STRASSE', kinds: null, health: 'offline' },
      { ids: s.id, aliases: 'other', kinds: 'tracker', health: 'healthy' },
    ],
    [
      'ListObservations',
      { ...s.observation, alias: 'O', source_asset_id: s.assetId },
      {
        ids: s.observationId,
        aliases: 'o',
        kinds: null,
        publisher_ids: s.processId,
        source_asset_ids: s.assetId,
        track_ids: s.trackId,
      },
      {
        ids: s.id,
        aliases: 'other',
        kinds: 'person',
        publisher_ids: s.id,
        source_asset_ids: s.id,
        track_ids: s.id,
      },
    ],
    [
      'ListTracks',
      { ...s.track, alias: 'T' },
      { ids: s.trackId, aliases: 't', kinds: null },
      { ids: s.id, aliases: 'other', kinds: 'person' },
    ],
    [
      'ListGeofeatures',
      { ...s.geofeature, alias: 'G' },
      { ids: s.requestId, aliases: 'g', kinds: null },
      { ids: s.id, aliases: 'other', kinds: 'route' },
    ],
    [
      'ListTasks',
      s.task,
      { ids: s.taskId, asset_ids: s.assetId, commands: 'move_to', states: 'pending' },
      { ids: s.id, asset_ids: s.id, commands: 'pause', states: 'completed' },
    ],
    [
      'ListObjects',
      s.object,
      { ids: s.requestId, content_types: 'application/octet-stream' },
      { ids: s.id, content_types: 'text/plain' },
    ],
    [
      'ListApiKeys',
      { ...s.apiKey, operator_id: s.processId },
      { ids: s.requestId, operator_ids: s.processId },
      { ids: s.id, operator_ids: s.id },
    ],
    ['ListOperators', s.operator, { ids: s.requestId }, { ids: s.id }],
    [
      'ListResources',
      s.examples.ListResources[1].items[0],
      { kinds: 'storage' },
      { kinds: 'other' },
    ],
    [
      'ReadActivity',
      s.examples.ReadActivity[1].items[0],
      { categories: 'core_started' },
      { categories: 'other' },
    ],
  ];
  for (const [name, item, matching, different] of cases) {
    const filters = Object.fromEntries(
      Object.entries(matching).map(([key, value]) => [key, [value]]),
    );
    reply(name, { filters }, page(item));
    for (const [key, wrong] of Object.entries(different)) {
      refuses(() => reply(name, { filters: { ...filters, [key]: [wrong] } }, page(item)));
      reply(name, { filters: { ...filters, [key]: [wrong, matching[key]] } }, page(item));
      refuses(() => reply(name, { filters: { ...filters, [key]: [] } }, page(item)));
      reply(name, { filters: { ...filters, [key]: [] } }, page());
    }
    reply(name, { page_token: 'opaque' }, page(item));
    reply(name, { filters }, page()); // A page cannot prove completeness.
  }
  const cancelled = { ...s.task, cancellation_request_id: s.requestId };
  reply('ListTasks', { filters: { states: ['cancellation_requested'] } }, page(cancelled));
  refuses(() => reply('ListTasks', { filters: { states: ['pending'] } }, page(cancelled)));
  refuses(() =>
    reply('ListAssets', { filters: { aliases: ['é'] } }, page({ ...s.asset, alias: 'e\u0301' })),
  );
  refuses(() =>
    reply('ListAssets', { filters: { aliases: ['A'] } }, page({ ...s.asset, alias: 'А' })),
  );
  refuses(() => reply('ListApiKeys', { filters: { operator_ids: [s.processId] } }, page(s.apiKey)));
});

test('Track source and Entity Object readers enforce known parent selections', () => {
  const item = { ...s.observation, source_asset_id: s.assetId };
  const request = {
    track_id: s.trackId,
    publisher_ids: [s.processId],
    source_asset_ids: [s.assetId],
  };
  reply('GetTrackObservations', request, page(item));
  for (const key of ['publisher_ids', 'source_asset_ids']) {
    refuses(() => reply('GetTrackObservations', { ...request, [key]: [s.id] }, page(item)));
    refuses(() => reply('GetTrackObservations', { ...request, [key]: [] }, page(item)));
  }
  refuses(() => reply('GetTrackObservations', request, page(s.observation)));
  for (const family of ['Asset', 'Observation', 'Track', 'Geofeature']) {
    const name = `Get${family}Objects`,
      [query, data] = s.examples[name];
    reply(name, query, data);
    refuses(() => reply(name, query, page(s.object)));
    reply(name, { page_token: 'opaque' }, page(s.object));
  }
});

test('history readers select exact time groups and nanosecond half-open known bounds', () => {
  for (const kind of ['Asset', 'Observation', 'Track']) {
    const name = `Get${kind}MovementHistory`,
      query = s.examples[name][0];
    const reading = {
      source_entity_kind: kind === 'Asset' ? 'asset' : 'observation',
      source_entity_id: kind === 'Asset' ? s.assetId : s.observationId,
      quantity: 'position',
      value: null,
      observed_at: '2026-10-23T00:00:00.100000000Z',
      time_status: 'known',
      source_evidence: {
        origin: kind === 'Asset' ? s.origin : { kind: 'publisher', publisher_id: s.processId },
        reading_id: s.requestId,
      },
      track_ids: kind === 'Asset' ? [] : [s.trackId],
    };
    const read = (selection, item = reading) =>
      reply(name, { ...query, ...selection }, { ...s.historyPage, readings: [item] });
    const bounds = {
      source_time_from: '2026-10-23T00:00:00.1Z',
      source_time_before: '2026-10-23T00:00:00.100000001Z',
    };
    assert.equal(
      read({ ...bounds, time_groups: ['known'] }).body.data.readings[0].observed_at,
      reading.observed_at,
    );
    refuses(() => read({ source_time_from: bounds.source_time_before }));
    refuses(() => read({ source_time_before: bounds.source_time_from }));
    refuses(() => read({ time_groups: [] }));
    for (const status of ['unknown', 'uncertain']) {
      const item = {
        ...reading,
        time_status: status,
        observed_at: status === 'unknown' ? null : s.later,
      };
      refuses(() => read({ time_groups: ['known'], ...bounds }, item));
      read({ time_groups: ['known', status], ...bounds }, item);
      read({ ...bounds }, item); // Bounds apply only to the known group.
    }
  }
});
