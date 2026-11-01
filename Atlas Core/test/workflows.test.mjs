import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { exchanges, readHttp } from '@atlas/protocol';
import { fixture, uuid, secret, report, telemetry, registration } from './helpers.mjs';

function ok(result) {
  assert.equal(result.status, 200, JSON.stringify(result.json));
  return result.json.data;
}
async function listItems(f, name, query) {
  const items = [],
    tokens = new Set();
  let request = { ...query, page_size: 1 };
  for (let page = 0; page < 100; page++) {
    const response = await f.call(name, request);
    ok(response);
    const data = readHttp(
      exchanges[name],
      { status: response.status, headers: new Headers(response.headers), body: response.bytes },
      { datasetId: f.core.dataset, request },
    ).body.data;
    assert.ok(data.items.length <= 1, name);
    items.push(...data.items);
    if (data.next_page_token === null) return items;
    assert.equal(tokens.has(data.next_page_token), false, `${name} repeated a continuation`);
    tokens.add(data.next_page_token);
    request = { page_token: data.next_page_token };
  }
  assert.fail(`${name} did not complete`);
}
async function listIds(f, name, query, expected, key = 'id') {
  const items = await listItems(f, name, query);
  assert.deepEqual(
    items.map((item) => item[key]).sort(),
    expected.toSorted(),
    `${name} ${JSON.stringify(query)}`,
  );
}

test('Entity selections preserve AND filters, OR alternatives and completeness across one-item pages', async (t) => {
  const f = await fixture(t),
    assets = [],
    pairs = [],
    features = [];
  const aliases = ['Straße', 'Alpha', 'Distractor'];
  const publisher = uuid();
  for (let i = 0; i < 3; i++) {
    const asset = { ...registration(aliases[i]), type: { kind: [null, 'tracker', 'other'][i] } };
    ok(await f.call('RegisterAsset', asset));
    assets.push(asset.asset_id);
    const origin = { kind: 'publisher', publisher_id: i < 2 ? publisher : uuid() },
      observation_id = uuid();
    const pair = ok(
      await f.call('CreateObservation', {
        request_id: uuid(),
        observation_id,
        publisher_id: origin.publisher_id,
        source_asset_id: assets[i],
        alias: `Observation ${aliases[i]}`,
        report: report(f.core.dataset, observation_id, origin, 1, {
          type: {
            state: 'value',
            classification: 'state_until_changed',
            observed_at: null,
            value: { kind: [null, 'person', 'animal'][i] },
          },
        }),
      }),
    );
    ok(
      await f.call('EditTrack', {
        request_id: uuid(),
        track_id: pair.track.id,
        expected_edit_revision: '0',
        edits: { alias: `Track ${aliases[i]}` },
      }),
    );
    pairs.push({
      observation_id,
      track_id: pair.track.id,
      publisher_id: origin.publisher_id,
      source_asset_id: assets[i],
    });
    const geofeature_id = uuid();
    features.push(geofeature_id);
    ok(
      await f.call('CreateGeofeature', {
        request_id: uuid(),
        geofeature_id,
        alias: `Geofeature ${aliases[i]}`,
        type: { kind: [null, 'route', 'boundary'][i] },
        geometry: { type: 'Point', coordinates: [i, i] },
      }),
    );
  }
  const selections = [
    {
      name: 'ListAssets',
      ids: assets,
      filters: {
        ids: assets.slice(0, 2),
        aliases: ['STRASSE', 'ALPHA'],
        kinds: [null, 'tracker'],
        health: ['offline'],
      },
      wrong: { ids: uuid(), aliases: 'absent', kinds: 'security_camera', health: 'degraded' },
    },
    {
      name: 'ListObservations',
      ids: pairs.map((p) => p.observation_id),
      filters: {
        ids: pairs.slice(0, 2).map((p) => p.observation_id),
        aliases: ['OBSERVATION STRASSE', 'OBSERVATION ALPHA'],
        kinds: [null, 'person'],
        publisher_ids: [publisher],
        source_asset_ids: assets.slice(0, 2),
        track_ids: pairs.slice(0, 2).map((p) => p.track_id),
      },
      wrong: {
        ids: uuid(),
        aliases: 'absent',
        kinds: 'aircraft',
        publisher_ids: uuid(),
        source_asset_ids: uuid(),
        track_ids: uuid(),
      },
    },
    {
      name: 'ListTracks',
      ids: pairs.map((p) => p.track_id),
      filters: {
        ids: pairs.slice(0, 2).map((p) => p.track_id),
        aliases: ['TRACK STRASSE', 'TRACK ALPHA'],
        kinds: [null, 'person'],
      },
      wrong: { ids: uuid(), aliases: 'absent', kinds: 'aircraft' },
    },
    {
      name: 'ListGeofeatures',
      ids: features,
      filters: {
        ids: features.slice(0, 2),
        aliases: ['GEOFEATURE STRASSE', 'GEOFEATURE ALPHA'],
        kinds: [null, 'route'],
      },
      wrong: { ids: uuid(), aliases: 'absent', kinds: 'search_area' },
    },
  ];
  for (const { name, ids, filters, wrong } of selections) {
    await listIds(f, name, {}, ids);
    await listIds(f, name, { filters }, ids.slice(0, 2));
    for (const [field, value] of Object.entries(wrong)) {
      await listIds(f, name, { filters: { ...filters, [field]: [value] } }, []);
      await listIds(f, name, { filters: { ...filters, [field]: [] } }, []);
      await listIds(
        f,
        name,
        { filters: { ...filters, [field]: [value, ...filters[field]] } },
        ids.slice(0, 2),
      );
    }
  }
  for (const pair of pairs) {
    const query = {
      track_id: pair.track_id,
      publisher_ids: [uuid(), pair.publisher_id],
      source_asset_ids: [uuid(), pair.source_asset_id],
    };
    await listIds(f, 'GetTrackObservations', query, [pair.observation_id]);
    for (const field of ['publisher_ids', 'source_asset_ids']) {
      await listIds(f, 'GetTrackObservations', { ...query, [field]: [] }, []);
      await listIds(f, 'GetTrackObservations', { ...query, [field]: [uuid()] }, []);
    }
  }
});

test('Task selections distinguish cancellation requests from execution states', async (t) => {
  const f = await fixture(t),
    assets = [registration(), registration()],
    tasks = [];
  for (const asset of assets) ok(await f.call('RegisterAsset', asset));
  for (let i = 0; i < 4; i++) {
    const task = {
      request_id: uuid(),
      task_id: uuid(),
      asset_id: assets[i % 2].asset_id,
      command: i === 3 ? 'pause' : 'move_to',
      scheduling: i === 3 ? 'immediate' : 'queued',
      inputs:
        i === 3 ? {} : { target: { kind: 'position', position: { latitude: i, longitude: 0 } } },
    };
    ok(await f.call('CreateTask', task));
    tasks.push(task);
  }
  ok(await f.call('RequestTaskCancellation', { request_id: uuid(), task_id: tasks[2].task_id }));
  const filters = {
    ids: tasks.slice(0, 2).map((task) => task.task_id),
    asset_ids: assets.map((a) => a.asset_id),
    commands: ['move_to'],
    states: ['pending'],
  };
  const expected = tasks.slice(0, 2).map((task) => task.task_id);
  await listIds(
    f,
    'ListTasks',
    {},
    tasks.map((task) => task.task_id),
    'task_id',
  );
  await listIds(f, 'ListTasks', { filters }, expected, 'task_id');
  for (const [field, wrong] of Object.entries({
    ids: uuid(),
    asset_ids: uuid(),
    commands: 'resume',
    states: 'completed',
  })) {
    await listIds(f, 'ListTasks', { filters: { ...filters, [field]: [wrong] } }, [], 'task_id');
    await listIds(f, 'ListTasks', { filters: { ...filters, [field]: [] } }, [], 'task_id');
    await listIds(
      f,
      'ListTasks',
      { filters: { ...filters, [field]: [wrong, ...filters[field]] } },
      expected,
      'task_id',
    );
  }
  await listIds(
    f,
    'ListTasks',
    { filters: { states: ['pending'], commands: ['move_to'] } },
    expected,
    'task_id',
  );
  await listIds(
    f,
    'ListTasks',
    { filters: { states: ['cancellation_requested'] } },
    [tasks[2].task_id],
    'task_id',
  );
  await listIds(
    f,
    'ListTasks',
    { filters: { states: ['cancellation_requested', 'pending'] } },
    tasks.map((task) => task.task_id),
    'task_id',
  );
});

test('administrative selections page exact Operators, bound keys, resource kinds and activity', async (t) => {
  const f = await fixture(t),
    operators = [],
    keys = [];
  for (let i = 0; i < 3; i++) {
    const request = { request_id: uuid(), operator_id: uuid(), name: `Operator ${i}` };
    const created = await f.call('CreateOperator', request);
    ok(created);
    operators.push(request.operator_id);
    assert.equal(
      (await f.call('CreateOperator', request)).json.commit_cursor,
      created.json.commit_cursor,
    );
  }
  for (let i = 0; i < 4; i++) {
    const request = {
      request_id: uuid(),
      api_key_id: uuid(),
      secret: secret(),
      ...(i < 3 ? { operator_id: operators[i] } : {}),
    };
    ok(await f.call('CreateApiKey', request));
    keys.push(request.api_key_id);
  }
  await listIds(f, 'ListOperators', {}, operators, 'operator_id');
  await listIds(
    f,
    'ListOperators',
    { filters: { ids: [uuid(), ...operators.slice(0, 2)] } },
    operators.slice(0, 2),
    'operator_id',
  );
  await listIds(f, 'ListOperators', { filters: { ids: [] } }, [], 'operator_id');
  await listIds(f, 'ListOperators', { filters: { ids: [uuid()] } }, [], 'operator_id');
  const filters = { ids: keys, operator_ids: operators.slice(0, 2) };
  await listIds(f, 'ListApiKeys', { filters }, keys.slice(0, 2), 'api_key_id');
  for (const field of ['ids', 'operator_ids']) {
    await listIds(f, 'ListApiKeys', { filters: { ...filters, [field]: [] } }, [], 'api_key_id');
    await listIds(
      f,
      'ListApiKeys',
      { filters: { ...filters, [field]: [uuid()] } },
      [],
      'api_key_id',
    );
    await listIds(
      f,
      'ListApiKeys',
      { filters: { ...filters, [field]: [uuid(), ...filters[field]] } },
      keys.slice(0, 2),
      'api_key_id',
    );
  }
  await listIds(f, 'ListApiKeys', { filters: { ids: keys } }, keys, 'api_key_id');
  await listIds(f, 'ListResources', {}, ['objects', 'temporary_receipts'], 'kind');
  await listIds(
    f,
    'ListResources',
    { filters: { kinds: ['absent', 'temporary_receipts', 'objects'] } },
    ['objects', 'temporary_receipts'],
    'kind',
  );
  await listIds(f, 'ListResources', { filters: { kinds: ['objects'] } }, ['objects'], 'kind');
  await listIds(f, 'ListResources', { filters: { kinds: ['absent'] } }, [], 'kind');
  await listIds(f, 'ListResources', { filters: { kinds: [] } }, [], 'kind');
  const operatorActivity = Array(3).fill('operator:Operator created');
  const credentialActivity = [
    'credential:Local administrator created credential',
    ...Array(4).fill('credential:Credential created'),
  ];
  const label = (item) => `${item.category}:${item.message}`;
  for (const [categories, expected] of [
    [['operator'], operatorActivity],
    [['credential'], credentialActivity],
    [
      ['absent', 'operator', 'credential'],
      [...operatorActivity, ...credentialActivity],
    ],
    [[], []],
    [['absent'], []],
  ]) {
    const items = await listItems(f, 'ReadActivity', { filters: { categories } });
    assert.deepEqual(items.map(label).sort(), expected.toSorted());
    assert.equal(new Set(items.map((item) => item.activity_id)).size, items.length);
  }
});
test('Track Observation membership validates unknown references independently of unrelated records', async (t) => {
  const f = await fixture(t);
  const unknown = uuid();
  assert.equal(
    (await f.call('GetTrackObservations', { track_id: unknown })).json.error.code,
    'entity_not_found',
  );
  const pairs = [];
  for (let i = 0; i < 8; i++)
    pairs.push(
      ok(
        await f.call('CreateObservation', {
          source_asset_id: await f.sourceAssetId(),
          request_id: uuid(),
          observation_id: uuid(),
          publisher_id: uuid(),
        }),
      ),
    );
  assert.equal(
    (await f.call('GetTrackObservations', { track_id: unknown })).json.error.code,
    'entity_not_found',
  );
  for (const pair of pairs) {
    assert.deepEqual(
      ok(await f.call('GetTrackObservations', { track_id: pair.track.id })).items.map(
        (item) => item.id,
      ),
      [pair.observation.id],
    );
    assert.deepEqual(
      ok(await f.call('GetTrackObservations', { track_id: pair.track.id, publisher_ids: [uuid()] }))
        .items,
      [],
    );
    await listIds(
      f,
      'GetTrackObservations',
      {
        track_id: pair.track.id,
        publisher_ids: [pair.observation.publisher_id],
        source_asset_ids: [uuid()],
      },
      [],
    );
  }
  await listIds(
    f,
    'ListObservations',
    {
      filters: {
        publisher_ids: pairs.map((pair) => pair.observation.publisher_id),
        source_asset_ids: [uuid()],
      },
    },
    [],
  );
});
test('Object selections and parent associations retain exact membership across pages', async (t) => {
  const f = await fixture(t),
    parents = [],
    objects = [];
  for (let i = 0; i < 2; i++) {
    const asset = registration(),
      observation_id = uuid(),
      task_id = uuid();
    ok(await f.call('RegisterAsset', asset));
    const pair = ok(
      await f.call('CreateObservation', {
        request_id: uuid(),
        observation_id,
        publisher_id: uuid(),
        source_asset_id: asset.asset_id,
      }),
    );
    const geofeature_id = uuid();
    ok(
      await f.call('CreateGeofeature', {
        request_id: uuid(),
        geofeature_id,
        geometry: { type: 'Point', coordinates: [i, i] },
      }),
    );
    ok(
      await f.call('CreateTask', {
        request_id: uuid(),
        task_id,
        asset_id: asset.asset_id,
        command: 'move_to',
        scheduling: 'queued',
        inputs: { target: { kind: 'position', position: { latitude: i, longitude: 0 } } },
      }),
    );
    parents.push({
      asset: asset.asset_id,
      observation: observation_id,
      track: pair.track.id,
      geofeature: geofeature_id,
      task: task_id,
      generation: asset.process_generation,
    });
  }
  for (let i = 0; i < 4; i++) {
    const bytes = Buffer.from(`associated content ${i}`);
    const selectedParents = i === 1 ? parents : i === 3 ? [] : [parents[i === 0 ? 0 : 1]];
    const associations = selectedParents.flatMap((parent) =>
      ['asset', 'observation', 'track', 'geofeature'].map((kind) => ({ kind, id: parent[kind] })),
    );
    const descriptor = {
      request_id: uuid(),
      object_id: uuid(),
      byte_length: String(bytes.length),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      content_type: ['text/plain', 'image/png', 'text/plain', 'application/octet-stream'][i],
      metadata: { associations },
    };
    const uploaded = await f.upload(descriptor, bytes);
    ok(uploaded);
    objects.push(descriptor.object_id);
    assert.equal(
      (await f.upload(descriptor, bytes)).json.commit_cursor,
      uploaded.json.commit_cursor,
    );
  }
  const filters = { ids: objects.slice(0, 3), content_types: ['text/plain', 'image/png'] };
  await listIds(f, 'ListObjects', {}, objects, 'object_id');
  await listIds(f, 'ListObjects', { filters }, objects.slice(0, 3), 'object_id');
  await listIds(
    f,
    'ListObjects',
    { filters: { content_types: ['text/plain'] } },
    [objects[0], objects[2]],
    'object_id',
  );
  for (const [field, wrong] of Object.entries({ ids: uuid(), content_types: 'application/json' })) {
    await listIds(f, 'ListObjects', { filters: { ...filters, [field]: [wrong] } }, [], 'object_id');
    await listIds(f, 'ListObjects', { filters: { ...filters, [field]: [] } }, [], 'object_id');
    await listIds(
      f,
      'ListObjects',
      { filters: { ...filters, [field]: [wrong, ...filters[field]] } },
      objects.slice(0, 3),
      'object_id',
    );
  }
  for (let i = 0; i < parents.length; i++) {
    const parent = parents[i],
      expected = i === 0 ? objects.slice(0, 2) : objects.slice(1, 3);
    const evidence = {
      dataset_id: f.core.dataset,
      asset_id: parent.asset,
      origin: { kind: 'asset_process', process_generation: parent.generation },
      report_id: uuid(),
      sequence: '1',
      generated_at: null,
      payload: {
        task_id: parent.task,
        declarations: expected.map((object_id) => ({ object_id, required: false })),
      },
    };
    ok(await f.call('ReportTaskResults', { evidence }));
    assert.equal(
      ok(await f.call('ReportTaskResults', { evidence })).evidence_disposition,
      'duplicate',
    );
    for (const family of ['Asset', 'Observation', 'Track', 'Geofeature', 'Task']) {
      const kind = family.toLowerCase();
      await listIds(
        f,
        `Get${family}Objects`,
        { [`${kind}_id`]: parent[kind] },
        expected,
        'object_id',
      );
      const unknown = await f.call(`Get${family}Objects`, { [`${kind}_id`]: uuid() });
      assert.equal(unknown.status, 404);
      assert.equal(unknown.json.error.code, 'entity_not_found');
    }
  }
});

test('history selections retain exact nanosecond bounds and separate known, unknown and uncertain positions', async (t) => {
  const f = await fixture(t);
  const asset = registration();
  ok(await f.call('RegisterAsset', asset));
  const publisher_id = uuid(),
    observation_id = uuid();
  const pair = ok(
    await f.call('CreateObservation', {
      source_asset_id: await f.sourceAssetId(),
      request_id: uuid(),
      observation_id,
      publisher_id,
    }),
  );
  const facts = [
    ['2026-10-21T12:00:00.099999999Z', 'known'],
    ['2026-10-21T12:00:00.1Z', 'known'],
    ['2026-10-21T12:00:00.100000000Z', 'known'],
    ['2026-10-21T12:00:00.100000001Z', 'known'],
    ['2026-10-21T12:00:00.100000002Z', 'known'],
    [null, 'unknown'],
    ['9999-01-01T00:00:00Z', 'uncertain'],
  ].map(([observed_at, time_status], i) => ({
    observed_at,
    time_status,
    reading_id: `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    latitude: i,
  }));
  const sources = [
    {
      kind: 'Asset',
      id: asset.asset_id,
      origin: { kind: 'asset_process', process_generation: asset.process_generation },
      tracks: [],
    },
    {
      kind: 'Observation',
      id: observation_id,
      origin: { kind: 'publisher', publisher_id },
      tracks: [pair.track.id],
    },
  ];
  for (const source of sources) {
    for (const [i, fact] of facts.entries()) {
      const input = report(f.core.dataset, source.id, source.origin, i + 1, {
        telemetry: telemetry(source.origin, fact.latitude, fact.observed_at, fact.reading_id),
      });
      const name = source.kind === 'Asset' ? 'UpdateAsset' : 'ReportObservation';
      const request =
        source.kind === 'Asset'
          ? { asset_id: source.id, request_id: uuid(), report: input }
          : { observation_id, publisher_id, report: input };
      ok(await f.call(name, request));
    }
  }
  const allocation_context = ok(await f.call('GetHealth')).allocation_context;
  const bounds = {
    source_time_from: '2026-10-21T12:00:00.100000000Z',
    source_time_before: '2026-10-21T12:00:00.100000002Z',
  };
  const selections = [
    [{ time_groups: ['known'], ...bounds }, [1, 2, 3]],
    [{ time_groups: ['known'], source_time_from: bounds.source_time_from }, [1, 2, 3, 4]],
    [{ time_groups: ['known'], source_time_before: bounds.source_time_before }, [0, 1, 2, 3]],
    [{ time_groups: ['unknown'], ...bounds }, [5]],
    [{ time_groups: ['uncertain'], ...bounds }, [6]],
    [{ time_groups: ['unknown', 'uncertain'], ...bounds }, [5, 6]],
    [{ time_groups: ['known', 'unknown'], ...bounds }, [1, 2, 3, 5]],
    [{ time_groups: ['known', 'uncertain'], ...bounds }, [1, 2, 3, 6]],
    [bounds, [1, 2, 3, 5, 6]],
    [{ time_groups: [], ...bounds }, []],
    [{}, [0, 1, 2, 3, 4, 5, 6]],
  ];
  for (const source of [...sources, { ...sources[1], kind: 'Track', id: pair.track.id }]) {
    const name = `Get${source.kind}MovementHistory`;
    for (const [selection, indices] of selections) {
      let request = {
        entity_id: source.id,
        query_id: uuid(),
        allocation_context,
        page_size: 1,
        ...selection,
      };
      const readings = [],
        tokens = new Set();
      let context;
      try {
        for (let page = 0; ; page++) {
          assert.ok(page <= facts.length, `${name} must finish`);
          const response = await f.call(name, request);
          ok(response);
          const data = readHttp(
            exchanges[name],
            {
              status: response.status,
              headers: new Headers(response.headers),
              body: response.bytes,
            },
            { datasetId: f.core.dataset, request },
          ).body.data;
          const { readings: pageReadings, next_page_token, ...pageContext } = data;
          if (context === undefined) context = pageContext;
          else assert.deepEqual(pageContext, context);
          assert.ok(pageReadings.length <= 1);
          readings.push(...pageReadings);
          if (next_page_token === null) break;
          assert.equal(tokens.has(next_page_token), false);
          tokens.add(next_page_token);
          request = { page_token: next_page_token };
        }
        assert.deepEqual(
          readings,
          indices.map((index) => {
            const fact = facts[index];
            return {
              source_entity_kind: source.kind === 'Asset' ? 'asset' : 'observation',
              source_entity_id: source.kind === 'Asset' ? asset.asset_id : observation_id,
              quantity: 'position',
              value: { latitude: fact.latitude, longitude: -1 },
              observed_at: fact.observed_at,
              time_status: fact.time_status,
              source_evidence: { origin: source.origin, reading_id: fact.reading_id },
              track_ids: source.tracks,
            };
          }),
          `${name} ${JSON.stringify(selection)}`,
        );
      } finally {
        if (context)
          ok(await f.call('ReleaseHistoryView', { release_token: context.release_token }));
      }
    }
  }
});

test(
  'every HTTP exchange succeeds through HTTPS, the worker, SQLite and files',
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    let health = ok(await f.call('GetHealth'));
    assert.equal(health.healthy, true);
    assert.equal(ok(await f.call('GetReadiness')).ready, true);
    const reference = await f.call('GetReference');
    assert.equal(reference.status, 200);
    assert.equal(reference.json.openapi, '3.1.0');
    const op = { operator_id: uuid(), request_id: uuid(), name: 'Pilot' };
    ok(await f.call('CreateOperator', op));
    ok(await f.call('GetOperator', { operator_id: op.operator_id }));
    ok(
      await f.call('EditOperator', {
        operator_id: op.operator_id,
        request_id: uuid(),
        expected_edit_revision: '0',
        edits: { description: 'Crew' },
      }),
    );
    const key = {
      api_key_id: uuid(),
      request_id: uuid(),
      secret: secret(),
      operator_id: op.operator_id,
    };
    ok(await f.call('CreateApiKey', key));
    ok(await f.call('ListApiKeys'));
    ok(await f.call('ListOperators'));
    const registrationRequest = registration('Straße');
    let asset = ok(await f.call('RegisterAsset', registrationRequest)).asset;
    assert.equal(asset.status.value.condition, 'unknown');
    assert.equal(asset.communications.health, 'offline');
    for (const [name, input] of [
      ['ListAssets', {}],
      ['GetAsset', { asset_id: asset.id }],
      ['GetAssetByAlias', { alias: 'STRASSE' }],
      ['GetAssetStatus', { asset_id: asset.id }],
    ])
      ok(await f.call(name, input));
    const origin = { kind: 'asset_process', process_generation: asset.process_generation };
    const contact = ok(
      await f.call('BeginAssetContact', {
        request_id: uuid(),
        allocation_context: health.allocation_context,
        asset_id: asset.id,
        process_generation: asset.process_generation,
        mode: 'current',
      }),
    );
    const first = report(f.core.dataset, asset.id, origin, 1, { telemetry: telemetry(origin, 51) });
    first.contact_proof = { challenge_id: contact.challenge_id };
    asset = ok(
      await f.call('UpdateAsset', { asset_id: asset.id, request_id: uuid(), report: first }),
    ).asset;
    assert.equal(asset.communications.health, 'healthy');
    const publisher = uuid(),
      observationId = uuid(),
      publisherOrigin = { kind: 'publisher', publisher_id: publisher };
    const create = {
      observation_id: observationId,
      request_id: uuid(),
      publisher_id: publisher,
      source_asset_id: asset.id,
      alias: 'Detection',
      report: report(f.core.dataset, observationId, publisherOrigin, 11, {
        telemetry: telemetry(publisherOrigin, 51.001),
      }),
    };
    let pair = ok(await f.call('CreateObservation', create));
    assert.notEqual(pair.observation.id, pair.track.id);
    const trackId = pair.track.id;
    ok(
      await f.call('ReportObservation', {
        observation_id: observationId,
        publisher_id: publisher,
        report: report(f.core.dataset, observationId, publisherOrigin, 10, {
          telemetry: telemetry(publisherOrigin, 51, '2026-10-21T12:00:00.0000001Z'),
        }),
      }),
    );
    ok(
      await f.call('EditObservation', {
        observation_id: observationId,
        request_id: uuid(),
        expected_edit_revision: '0',
        edits: { description: { name: 'Subject' } },
      }),
    );
    ok(
      await f.call('EditTrack', {
        track_id: trackId,
        request_id: uuid(),
        expected_edit_revision: '0',
        edits: { alias: 'Target' },
      }),
    );
    for (const [name, input] of [
      ['ListObservations', {}],
      ['GetObservation', { observation_id: observationId }],
      ['GetObservationByAlias', { alias: 'detection' }],
      ['ListTracks', {}],
      ['GetTrack', { track_id: trackId }],
      ['GetTrackByAlias', { alias: 'target' }],
      ['GetTrackObservations', { track_id: trackId }],
    ])
      ok(await f.call(name, input));
    const featureId = uuid();
    ok(
      await f.call('CreateGeofeature', {
        geofeature_id: featureId,
        request_id: uuid(),
        alias: 'Rally',
        geometry: { type: 'Point', coordinates: [-1, 51] },
      }),
    );
    ok(
      await f.call('EditGeofeature', {
        geofeature_id: featureId,
        request_id: uuid(),
        expected_edit_revision: '0',
        edits: { type: { kind: 'route' } },
      }),
    );
    for (const [name, input] of [
      ['ListGeofeatures', {}],
      ['GetGeofeature', { geofeature_id: featureId }],
      ['GetGeofeatureByAlias', { alias: 'rally' }],
    ])
      ok(await f.call(name, input));
    const task = ok(
      await f.call('CreateTask', {
        task_id: uuid(),
        request_id: uuid(),
        asset_id: asset.id,
        command: 'move_to',
        scheduling: 'queued',
        inputs: { target: { kind: 'geofeature', geofeature_id: featureId } },
      }),
    );
    ok(await f.call('ListTasks'));
    ok(await f.call('GetTask', { task_id: task.task_id }));
    asset = ok(await f.call('GetAsset', { asset_id: asset.id }));
    ok(
      await f.call('SetTaskOrder', {
        request_id: uuid(),
        asset_id: asset.id,
        expected_queue_revision: asset.task_queue.revision,
        task_ids: [task.task_id],
      }),
    );
    const assigned = ok(
      await f.call('GetAssignedTasks', {
        asset_id: asset.id,
        process_generation: asset.process_generation,
        read_id: uuid(),
      }),
    );
    const evidence = (payload) => ({
      dataset_id: f.core.dataset,
      asset_id: asset.id,
      origin,
      report_id: uuid(),
      sequence: '1',
      generated_at: new Date().toISOString(),
      payload,
    });
    ok(
      await f.call('ConfirmTaskOrder', {
        evidence: evidence({ queue_revision: assigned.task_queue.revision }),
      }),
    );
    const cancelId = uuid();
    ok(await f.call('RequestTaskCancellation', { task_id: task.task_id, request_id: cancelId }));
    ok(
      await f.call('ReportTaskExecution', {
        evidence: evidence({
          task_id: task.task_id,
          event: 'state',
          state: 'cancelled',
          cancellation_request_id: cancelId,
        }),
      }),
    );
    const bytes = Buffer.from('immutable content\u0000\u00ff');
    const descriptor = {
      request_id: uuid(),
      object_id: uuid(),
      byte_length: String(bytes.byteLength),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      content_type: 'application/octet-stream',
      metadata: {
        associations: [
          { kind: 'asset', id: asset.id },
          { kind: 'observation', id: observationId },
          { kind: 'track', id: trackId },
          { kind: 'geofeature', id: featureId },
        ],
      },
    };
    ok(await f.upload(descriptor, bytes, true));
    ok(
      await f.call('ReportTaskResults', {
        evidence: evidence({
          task_id: task.task_id,
          declarations: [{ object_id: descriptor.object_id, required: false }],
        }),
      }),
    );
    for (const [name, input] of [
      ['ListObjects', {}],
      ['GetObject', { object_id: descriptor.object_id }],
      ['GetAssetObjects', { asset_id: asset.id }],
      ['GetObservationObjects', { observation_id: observationId }],
      ['GetTrackObjects', { track_id: trackId }],
      ['GetGeofeatureObjects', { geofeature_id: featureId }],
      ['GetTaskObjects', { task_id: task.task_id }],
    ])
      assert.ok(ok(await f.call(name, input)).items?.length ?? true);
    const content = await f.call('ReadObjectContent', {
      object_id: descriptor.object_id,
      disposition: 'attachment',
    });
    assert.equal(content.status, 200);
    assert.deepEqual(content.bytes, bytes);
    ok(
      await f.call('EditObject', {
        object_id: descriptor.object_id,
        request_id: uuid(),
        expected_edit_revision: '0',
        edits: { name: 'Frame' },
      }),
    );
    health = ok(await f.call('GetHealth'));
    for (const [name, entity] of [
      ['GetAssetMovementHistory', asset.id],
      ['GetObservationMovementHistory', observationId],
      ['GetTrackMovementHistory', trackId],
    ]) {
      const history = ok(
        await f.call(name, {
          entity_id: entity,
          query_id: uuid(),
          allocation_context: health.allocation_context,
        }),
      );
      assert.ok(history.readings.length > 0);
      ok(await f.call('ReleaseHistoryView', { release_token: history.release_token }));
    }
    const limits = { max_message_bytes: 4194304, max_json_values: 262144, max_changes: 1000 };
    const snapshot = ok(
      await f.call('ReadSnapshot', {
        load_id: uuid(),
        allocation_context: health.allocation_context,
        page_size: 100,
        ...limits,
      }),
    );
    assert.ok(snapshot.items.some((item) => item.resource_kind === 'track'));
    assert.ok(snapshot.items.every((item) => item.resource_kind !== 'observation'));
    ok(await f.call('ReadChanges', { from_cursor: snapshot.baseline_cursor, ...limits }));
    ok(await f.call('ReleaseSnapshot', { release_token: snapshot.release_token }));
    const replacement = uuid();
    const challenge = ok(
      await f.call('BeginAssetContact', {
        request_id: uuid(),
        allocation_context: health.allocation_context,
        asset_id: asset.id,
        process_generation: replacement,
        expected_process_generation: asset.process_generation,
        mode: 'replace',
      }),
    );
    const replacementReport = report(
      f.core.dataset,
      asset.id,
      { kind: 'asset_process', process_generation: replacement },
      1,
      {},
    );
    replacementReport.contact_proof = { challenge_id: challenge.challenge_id };
    ok(
      await f.call('ReplaceAssetProcess', {
        request_id: uuid(),
        asset_id: asset.id,
        expected_process_generation: asset.process_generation,
        process_generation: replacement,
        challenge_id: challenge.challenge_id,
        first_report: replacementReport,
      }),
    );
    ok(await f.call('DeleteObject', { object_id: descriptor.object_id, request_id: uuid() }));
    ok(await f.call('DeleteGeofeature', { geofeature_id: featureId, request_id: uuid() }));
    ok(await f.call('DeleteAsset', { asset_id: asset.id, request_id: uuid() }));
    ok(await f.call('RevokeApiKey', { api_key_id: key.api_key_id, request_id: uuid() }));
    ok(await f.call('DeleteOperator', { operator_id: op.operator_id, request_id: uuid() }));
    ok(await f.call('ListResources'));
    ok(await f.call('ReadActivity'));
    assert.deepEqual([...f.seen].sort(), Object.keys(exchanges).sort());
  },
);
