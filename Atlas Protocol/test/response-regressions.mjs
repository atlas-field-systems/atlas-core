import { harness } from './harness.mjs';
import * as s from './samples.mjs';

export function runResponseRegressions(p) {
  const { check, assert, refuses, encode, result } = harness(p);
  const headers = () =>
    new Headers({
      'Atlas-Dataset-ID': s.id,
      'Atlas-Protocol-Version': '0.2.0',
      'Content-Type': 'application/json',
    });
  const reply = (name, data, request, extra = {}) =>
    p.readHttp(
      p.exchanges[name],
      {
        status: 200,
        headers: headers(),
        body: encode({ dataset_id: s.id, data, commit_cursor: 'cursor' }),
      },
      { request, ...extra },
    );
  const uuid = (index) => `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  const put = (image) => ({
    kind: 'put',
    resource_kind: 'geofeature',
    resource_id: image.id,
    version: image.version,
    image,
  });
  const frame = (type, data) => ({
    type,
    dataset_id: s.id,
    protocol_version: '0.2.0',
    request_id: s.requestId,
    data,
  });
  const batch = (geometry) => ({
    type: 'change_batch',
    dataset_id: s.id,
    protocol_version: '0.2.0',
    data: {
      subscription_id: s.requestId,
      previous_cursor: 'before',
      commit_cursor: 'after',
      changes: [put({ ...s.geofeature, geometry })],
    },
  });
  const inputSection = (value) => ({
    state: 'value',
    classification: 'dated_measurement',
    observed_at: s.time,
    value,
  });
  const evidence = (section) => ({
    dataset_id: s.id,
    entity_id: s.observationId,
    origin: { kind: 'publisher', publisher_id: s.processId },
    report_id: s.requestId,
    sequence: '1',
    section,
  });
  const section = (name, value) => ({
    ...inputSection(value),
    evidence: evidence(name),
    time_status: Object.fromEntries(
      (name === 'geometry' ? ['geometry'] : Object.keys(value)).map((key) => [key, 'known']),
    ),
  });
  const geometryReaders = {
    root: (geometry) => p.readJson(p.contract(p.Geometry), encode(geometry)),
    creation: (geometry) =>
      p.readHttpRequest(p.exchanges.CreateGeofeature, {
        method: 'POST',
        path: p.exchanges.CreateGeofeature.path,
        headers: new Headers({
          ...Object.fromEntries(headers()),
          Authorization: `Bearer ${'A'.repeat(43)}`,
        }),
        body: encode({ ...s.examples.CreateGeofeature[0], geometry }),
      }),
    report: (geometry) =>
      p.readJson(
        p.exchanges.ReportObservation.request,
        encode({
          ...s.examples.ReportObservation[0],
          report: { ...s.observationReport, sections: { geometry: inputSection(geometry) } },
        }),
      ),
    inputSection: (geometry) =>
      p.readJson(p.contract(p.inputSections.geometry), encode(inputSection(geometry))),
    readSection: (geometry) =>
      p.readJson(p.contract(p.readSections.geometry), encode(section('geometry', geometry))),
    resource: (geometry) =>
      reply('GetGeofeature', { ...s.geofeature, geometry }, s.examples.GetGeofeature[0]),
    observation: (geometry) =>
      reply(
        'GetObservation',
        { ...s.observation, geometry: section('geometry', geometry) },
        s.examples.GetObservation[0],
      ),
    change: (geometry) =>
      p.readJson(p.contract(p.Change), encode(put({ ...s.geofeature, geometry }))),
    frame: (geometry) => p.readWssServer(encode(batch(geometry))),
  };
  const shapes = [
    ['invalid_geometry', { type: 'Point', coordinates: [0, 91] }],
    ['invalid_geometry', { type: 'Point', coordinates: [0] }],
    ['invalid_geometry', { type: 'Point', coordinates: [0, 0], extra: true }],
    ['invalid_geometry', { type: 'Point', coordinates: [0, 91], state: 'value' }],
    [
      'invalid_geometry',
      {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 1],
            [2, 2],
            [0, 0],
          ],
        ],
      },
    ],
    [
      'unsupported_geometry',
      {
        type: 'LineString',
        coordinates: [
          [170, 0],
          [-170, 0],
        ],
      },
    ],
    ['unsupported_geometry', { type: 'Polygon', coordinates: [[], []] }],
    [
      'geometry_limit_exceeded',
      { type: 'LineString', coordinates: Array.from({ length: 1025 }, () => [0, 0]) },
    ],
    ...[
      'Feature',
      'FeatureCollection',
      'GeometryCollection',
      'MultiPoint',
      'MultiLineString',
      'MultiPolygon',
    ].map((type) => ['unsupported_geometry', { type, coordinates: [] }]),
  ];
  for (const [boundary, read] of Object.entries(geometryReaders)) {
    check(`${boundary} accepts profile geometry`, () => read(s.geometry));
    for (const [index, [code, geometry]] of shapes.entries())
      check(`${boundary} geometry refusal ${index}`, () => refuses(() => read(geometry), code));
  }
  check('report geometry metadata retains ordinary value refusal', () =>
    refuses(
      () =>
        p.readJson(
          p.exchanges.ReportObservation.request,
          encode({
            ...s.examples.ReportObservation[0],
            report: {
              ...s.observationReport,
              sections: { geometry: { ...inputSection(s.geometry), observed_at: 'invalid' } },
            },
          }),
        ),
      'invalid_value',
    ),
  );
  check('known resource type remains closed', () =>
    refuses(
      () => reply('GetAsset', { ...s.asset, type: { kind: 'MultiPoint' } }, s.examples.GetAsset[0]),
      'invalid_value',
    ),
  );
  check('geometry source time remains a timestamp', () =>
    refuses(
      () =>
        p.readJson(
          p.exchanges.ReportObservation.request,
          encode({
            ...s.examples.ReportObservation[0],
            report: {
              ...s.observationReport,
              sections: {
                geometry: { ...inputSection(s.geometry), source_times: { geometry: 0 } },
              },
            },
          }),
        ),
      'invalid_value',
    ),
  );

  const reading = (kind, entityId, index = 0) => ({
    source_entity_kind: kind,
    source_entity_id: entityId,
    quantity: 'position',
    value: null,
    source_evidence: {
      origin: kind === 'asset' ? s.origin : { kind: 'publisher', publisher_id: s.processId },
      reading_id: uuid(index),
    },
    observed_at: null,
    time_status: 'unknown',
    track_ids: kind === 'asset' ? [] : [s.trackId],
  });
  const pageCases = Object.entries(s.examples).flatMap(([name, [request, data]]) => {
    const key = data && ['items', 'tasks', 'readings'].find((key) => Array.isArray(data[key]));
    if (!key) return [];
    const item = (index) => {
      if (key === 'readings')
        return reading(
          name === 'GetAssetMovementHistory' ? 'asset' : 'observation',
          name === 'GetTrackMovementHistory' ? s.observationId : request.entity_id,
          index,
        );
      if (name === 'ReadSnapshot') return put({ ...s.geofeature, id: uuid(index) });
      const result = { ...data[key][0] };
      for (const identity of [
        'id',
        'task_id',
        'object_id',
        'api_key_id',
        'operator_id',
        'activity_id',
      ])
        if (result[identity] !== undefined && result[identity] !== null)
          result[identity] = uuid(index);
      if (name === 'ListResources') result.kind = `resource-${String(index).padStart(3, '0')}`;
      return result;
    };
    return [{ name, request, data, key, item }];
  });
  for (const { name, request, data, key, item } of pageCases) {
    const page = (size) => ({
      ...data,
      [key]: Array.from({ length: size }, (_, index) => item(index)),
    });
    check(`${name} honors explicit first page size`, () => {
      reply(name, page(1), { ...request, page_size: 1 });
      refuses(() => reply(name, page(2), { ...request, page_size: 1 }), 'invalid_http');
      reply(name, page(0), { ...request, page_size: 1 });
    });
    check(`${name} continuation does not invent page size`, () =>
      reply(name, page(101), { page_token: 'continuation' }),
    );
    if (name !== 'ReadSnapshot')
      check(`${name} honors default first page size`, () => {
        reply(name, page(100), request);
        refuses(() => reply(name, page(101), request), 'invalid_http');
      });
  }

  for (const name of ['CreateObservation', 'ReportObservation']) {
    const [request, result] = s.examples[name];
    check(`${name} matches publisher attribution`, () => {
      reply(name, result, request);
      refuses(
        () =>
          reply(
            name,
            {
              ...result,
              observation: { ...s.observation, publisher_id: s.id },
              track: {
                ...s.track,
                sources: [{ observation_id: s.observationId, publisher_id: s.id }],
              },
            },
            request,
          ),
        'invalid_http',
      );
    });
  }
  check('creation preserves supplied source Asset and omission policy', () => {
    const request = { ...s.examples.CreateObservation[0], source_asset_id: s.assetId };
    const result = (source) => ({
      observation: { ...s.observation, ...(source ? { source_asset_id: source } : {}) },
      track: {
        ...s.track,
        sources: [{ ...s.track.sources[0], ...(source ? { source_asset_id: source } : {}) }],
      },
    });
    reply('CreateObservation', result(s.assetId), request);
    refuses(() => reply('CreateObservation', result(s.id), request), 'invalid_http');
    refuses(() => reply('CreateObservation', result(), request), 'invalid_http');
    refuses(
      () => reply('CreateObservation', result(s.assetId), s.examples.CreateObservation[0]),
      'invalid_http',
    );
  });
  for (const name of ['ReportTaskExecution', 'ReportTaskResults'])
    check(`${name} matches evidence Asset and Task`, () => {
      const [request, result] = s.examples[name];
      reply(name, result, request);
      refuses(
        () => reply(name, { ...result, task: { ...s.task, asset_id: s.id } }, request),
        'invalid_http',
      );
      refuses(
        () => reply(name, { ...result, task: { ...s.task, task_id: s.id } }, request),
        'invalid_http',
      );
    });
  check('queue confirmation matches evidence Asset', () => {
    const [request, result] = s.examples.ConfirmTaskOrder;
    reply('ConfirmTaskOrder', result, request);
    refuses(
      () => reply('ConfirmTaskOrder', { ...result, asset: { ...s.asset, id: s.id } }, request),
      'invalid_http',
    );
  });
  for (const field of ['status', 'capacity'])
    check(`abbreviated Asset ${field} enforces complete evidence scope`, () => {
      const [request, result] = s.examples.GetAssetStatus;
      const validEvidence = {
        ...evidence(field === 'status' ? 'status' : 'communications'),
        entity_id: s.assetId,
        origin: s.origin,
      };
      const data = (proof) =>
        field === 'status'
          ? { ...result, status: { ...result.status, evidence: proof } }
          : {
              ...result,
              communications: {
                ...result.communications,
                capacity: { ...result.communications.capacity, evidence: proof },
              },
            };
      reply('GetAssetStatus', result, request);
      reply('GetAssetStatus', data(validEvidence), request);
      for (const proof of [
        { ...validEvidence, entity_id: s.observationId },
        { ...validEvidence, dataset_id: s.taskId },
        { ...validEvidence, origin: { kind: 'publisher', publisher_id: s.processId } },
      ])
        refuses(
          () => reply('GetAssetStatus', data(proof), request),
          proof.dataset_id === s.taskId ? 'invalid_http' : 'invalid_value',
        );
    });
  for (const [name, kind, entityId] of [
    ['GetAssetMovementHistory', 'asset', s.assetId],
    ['GetObservationMovementHistory', 'observation', s.observationId],
    ['GetTrackMovementHistory', 'track', s.trackId],
  ])
    check(`${name} binds first-page source`, () => {
      const request = { ...s.historyFirst, entity_id: entityId };
      const good = reading(
        kind === 'asset' ? 'asset' : 'observation',
        kind === 'track' ? s.observationId : entityId,
      );
      const page = (item) => ({ ...s.historyPage, readings: [item] });
      reply(name, page(good), request);
      const wrong =
        kind === 'track' ? { ...good, track_ids: [s.id] } : { ...good, source_entity_id: s.id };
      refuses(() => reply(name, page(wrong), request), 'invalid_http');
      if (kind !== 'track')
        refuses(
          () =>
            reply(
              name,
              page(reading(kind === 'asset' ? 'observation' : 'asset', entityId)),
              request,
            ),
          'invalid_http',
        );
      reply(name, page(wrong), { page_token: 'continuation' });
    });

  const constituent = { origin: evidence('telemetry').origin, reading_id: s.requestId };
  const sections = {
    type: section('type', { kind: 'person' }),
    telemetry: {
      ...section('telemetry', {
        position: { latitude: 0, longitude: 0 },
        altitude: null,
        ground_speed: null,
      }),
      constituents: { position: constituent, altitude: constituent, ground_speed: constituent },
      source_times: { position: s.time },
    },
    attitude: section('attitude', { heading: 0, pitch: 0, roll: 0 }),
    geometry: section('geometry', s.geometry),
  };
  const mirrored = {
    observation: { ...s.observation, ...sections, alias: 'Observation' },
    track: { ...s.track, ...sections, alias: 'Track' },
    evidence_disposition: 'accepted',
  };
  const reportRequest = s.examples.ReportObservation[0];
  check('default pair mirrors exact sections while authored descriptions differ', () =>
    reply('ReportObservation', mirrored, reportRequest),
  );
  for (const key of Object.keys(sections)) {
    check(`default pair mirrors ${key} presence`, () => {
      const { [key]: removed, ...without } = mirrored.track;
      void removed;
      refuses(
        () => reply('ReportObservation', { ...mirrored, track: without }, reportRequest),
        'invalid_value',
      );
    });
    for (const [difference, change] of Object.entries({
      value: (value) => ({
        ...value,
        value:
          key === 'type'
            ? { kind: 'animal' }
            : key === 'telemetry'
              ? { ...value.value, ground_speed: 1 }
              : key === 'attitude'
                ? { ...value.value, heading: 1 }
                : { type: 'Point', coordinates: [1, 0] },
      }),
      timestamp: (value) => ({ ...value, observed_at: s.later }),
      evidence: (value) => ({ ...value, evidence: { ...value.evidence, report_id: s.id } }),
    }))
      check(`default pair mirrors ${key} ${difference}`, () =>
        refuses(
          () =>
            reply(
              'ReportObservation',
              { ...mirrored, track: { ...mirrored.track, [key]: change(sections[key]) } },
              reportRequest,
            ),
          'invalid_value',
        ),
      );
  }
  check('default pair mirrors constituents and quantity time spelling', () => {
    const telemetry = mirrored.track.telemetry;
    for (const changed of [
      {
        ...telemetry,
        constituents: { ...telemetry.constituents, position: { ...constituent, reading_id: s.id } },
      },
      { ...telemetry, source_times: { position: '2026-10-23T00:00:00.1Z' } },
    ])
      refuses(
        () =>
          reply(
            'ReportObservation',
            { ...mirrored, track: { ...mirrored.track, telemetry: changed } },
            reportRequest,
          ),
        'invalid_value',
      );
  });
  for (const state of ['error', 'withdrawn'])
    check(`default pair preserves ${state} result`, () => {
      const geometry = {
        state,
        classification: 'dated_measurement',
        observed_at: null,
        evidence: evidence('geometry'),
        time_status: 'unknown',
        ...(state === 'error' ? { error: { code: 'missing' } } : {}),
      };
      reply(
        'ReportObservation',
        {
          ...mirrored,
          observation: { ...mirrored.observation, geometry },
          track: { ...mirrored.track, geometry },
        },
        reportRequest,
      );
    });

  const snapshotReply = (data, rawSuffix = '') => ({
    status: 200,
    headers: headers(),
    body: new TextEncoder().encode(JSON.stringify({ dataset_id: s.id, data }) + rawSuffix),
  });
  check('HTTP snapshot counts all 14 values including its envelope', () => {
    const data = (max) => ({ ...s.snapshot, limits: { ...s.limits, max_json_values: max } });
    p.readHttp(p.exchanges.ReadSnapshot, snapshotReply(data(14)));
    refuses(() => p.readHttp(p.exchanges.ReadSnapshot, snapshotReply(data(13))), 'resource_limit');
  });
  check('WSS snapshot counts all 17 values including its frame', () => {
    const data = (max) =>
      frame('read_snapshot_result', {
        ...s.snapshot,
        limits: { ...s.limits, max_json_values: max },
      });
    p.readWssServer(encode(data(17)));
    p.writeWssServer(p.readWssServer(encode(data(17))));
    refuses(() => p.readWssServer(encode(data(16))), 'resource_limit');
    refuses(() => p.writeWssServer(data(16)), 'resource_limit');
  });
  for (const protocol of ['HTTP', 'WSS'])
    check(`${protocol} snapshot counts raw envelope bytes`, () => {
      const data = { ...s.snapshot, limits: { ...s.limits, max_message_bytes: 1024 } };
      const value =
        protocol === 'HTTP' ? { dataset_id: s.id, data } : frame('read_snapshot_result', data);
      const raw = JSON.stringify(value);
      const read = (body) =>
        protocol === 'HTTP'
          ? p.readHttp(p.exchanges.ReadSnapshot, { status: 200, headers: headers(), body })
          : p.readWssServer(body);
      read(new TextEncoder().encode(raw.padEnd(1024, ' ')));
      refuses(() => read(new TextEncoder().encode(raw.padEnd(1025, ' '))), 'payload_too_large');
    });
  check('snapshot enforces requested changes before expensive geometry', () => {
    const items = [put({ ...s.geofeature, id: s.id }), put(s.geofeature)];
    refuses(
      () => reply('ReadSnapshot', { ...s.snapshot, items }, { ...s.snapshotFirst, max_changes: 1 }),
      'resource_limit',
    );
    reply(
      'ReadSnapshot',
      { ...s.snapshot, items, limits: { ...s.limits, max_changes: 2 } },
      { ...s.snapshotFirst, max_changes: 2 },
    );
  });
  for (const name of ['ReadSnapshot', 'ReadChanges'])
    check(`${name} applies known requested whole-message limits`, () => {
      const [request, data] = s.examples[name];
      refuses(() => reply(name, data, { ...request, max_message_bytes: 128 }), 'payload_too_large');
      refuses(() => reply(name, data, { ...request, max_json_values: 5 }), 'resource_limit');
      reply(name, data, request, { budget: { maxBytes: 99999999 } });
      refuses(() => reply(name, data, request, { budget: { maxBytes: 128 } }), 'payload_too_large');
      reply(name, data, { page_token: 'continuation' });
      refuses(
        () => reply(name, data, { page_token: 'continuation' }, { budget: { maxValues: 5 } }),
        'resource_limit',
      );
    });
  for (const name of ['ReadSnapshot'])
    for (const [key, value] of Object.entries({
      max_message_bytes: 1024,
      max_json_values: 100,
      max_changes: 1,
    }))
      check(`${name} cannot raise negotiated ${key}`, () => {
        const [request, data] = s.examples[name];
        const limits = { ...s.limits, [key]: value };
        reply(name, { ...data, limits }, { ...request, ...limits });
        refuses(
          () =>
            reply(
              name,
              { ...data, limits: { ...limits, [key]: value + 1 } },
              { ...request, ...limits },
            ),
          'invalid_http',
        );
      });
  check('ReadChanges enforces requested aggregate changes', () => {
    const changes = [s.id, s.requestId].map((resource_id) => ({
      kind: 'delete',
      resource_kind: 'geofeature',
      resource_id,
      version: '0',
    }));
    const data = {
      replay_boundary: 'end',
      messages: [
        { type: 'change_batch', data: { previous_cursor: 'start', commit_cursor: 'end', changes } },
      ],
      through_cursor: 'end',
      next_page_token: null,
    };
    refuses(
      () => reply('ReadChanges', data, { from_cursor: 'start', ...s.limits, max_changes: 1 }),
      'resource_limit',
    );
    reply('ReadChanges', data, { from_cursor: 'start', ...s.limits, max_changes: 2 });
  });
  check('replay binds start, chain, final cursor and fixed completion', () => {
    const request = { from_cursor: 'start', ...s.limits };
    const progress = (previous_cursor, through_cursor) => ({
      type: 'progress',
      data: { previous_cursor, through_cursor },
    });
    const data = {
      replay_boundary: 'end',
      messages: [progress('start', 'mid'), progress('mid', 'end')],
      through_cursor: 'end',
      next_page_token: null,
    };
    reply('ReadChanges', data, request);
    refuses(
      () => reply('ReadChanges', { ...data, messages: [progress('wrong', 'end')] }, request),
      'invalid_http',
    );
    refuses(() => reply('ReadChanges', { ...data, messages: [] }, request), 'invalid_http');
    refuses(
      () =>
        reply(
          'ReadChanges',
          { ...data, messages: [progress('start', 'mid'), progress('gap', 'end')] },
          request,
        ),
      'invalid_value',
    );
    refuses(
      () => reply('ReadChanges', { ...data, through_cursor: 'mid' }, request),
      'invalid_value',
    );
    const partial = { ...data, messages: [progress('start', 'mid')], through_cursor: 'mid' };
    refuses(() => reply('ReadChanges', partial, request), 'invalid_value');
    reply('ReadChanges', { ...partial, next_page_token: 'continuation' }, request);
    reply(
      'ReadChanges',
      { ...data, messages: [progress('other-page', 'end')] },
      { page_token: 'continuation' },
    );
    reply(
      'ReadChanges',
      { ...data, messages: [], through_cursor: 'start', replay_boundary: 'start' },
      request,
    );
  });

  check('contact proof requires generation time through report and replacement', () => {
    const report = { ...s.report, sections: {}, contact_proof: { challenge_id: s.requestId } };
    p.readJson(p.contract(p.AssetReport), encode(report));
    refuses(
      () => p.readJson(p.contract(p.AssetReport), encode({ ...report, generated_at: null })),
      'invalid_value',
    );
    const request = s.examples.ReplaceAssetProcess[0];
    p.readJson(
      p.exchanges.ReplaceAssetProcess.request,
      encode({ ...request, first_report: report }),
    );
    refuses(
      () =>
        p.readJson(
          p.exchanges.ReplaceAssetProcess.request,
          encode({ ...request, first_report: { ...report, generated_at: null } }),
        ),
      'invalid_value',
    );
    p.readJson(p.contract(p.AssetReport), encode({ ...s.report, generated_at: null }));
  });
  check('assigned instruction interval is exactly ten seconds in nanoseconds', () => {
    const [request, data] = s.examples.GetAssignedTasks;
    const captured_at = '2026-12-31T23:59:59.999999999Z';
    reply(
      'GetAssignedTasks',
      { ...data, captured_at, instructions_valid_until: '2027-01-01T00:00:09.999999999Z' },
      request,
    );
    for (const instructions_valid_until of [
      '2027-01-01T00:00:09.999999998Z',
      '2027-01-01T00:00:10Z',
      '2027-01-01T00:00:11Z',
      'invalid',
    ])
      refuses(
        () =>
          reply('GetAssignedTasks', { ...data, captured_at, instructions_valid_until }, request),
        'invalid_value',
      );
  });
  check('challenge interval is positive and at most ten seconds', () => {
    const [request, data] = s.examples.BeginAssetContact;
    const issued_at = '2026-12-31T23:59:59.999999999Z';
    for (const expires_at of ['2027-01-01T00:00:00Z', '2027-01-01T00:00:09.999999999Z'])
      reply('BeginAssetContact', { ...data, issued_at, expires_at }, request);
    for (const expires_at of [
      issued_at,
      '2026-12-31T23:59:59.999999998Z',
      '2027-01-01T00:00:10Z',
      'invalid',
    ])
      refuses(
        () => reply('BeginAssetContact', { ...data, issued_at, expires_at }, request),
        'invalid_value',
      );
  });
  return result();
}
