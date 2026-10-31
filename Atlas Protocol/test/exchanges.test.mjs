import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as p from '../dist/index.js';
import * as s from './samples.mjs';
import { z } from 'zod';

const encode = (value) => new TextEncoder().encode(JSON.stringify(value));
const requestHeaders = () =>
  new Headers({
    'Atlas-Dataset-ID': s.id,
    'Atlas-Protocol-Version': '0.4.0',
    Authorization: `Bearer ${'A'.repeat(43)}`,
    'Content-Type': 'application/json',
  });
const responseHeaders = () =>
  new Headers({
    'Atlas-Dataset-ID': s.id,
    'Atlas-Protocol-Version': '0.4.0',
    'Atlas-Request-ID': s.requestId,
    'Content-Type': 'application/json',
  });
const refuses = (fn, code) =>
  assert.throws(fn, (error) => error instanceof p.ProtocolError && (!code || error.code === code));

test('HTTP consumes each successful body through its authoritative schema once', () => {
  let validations = 0;
  const base = p.exchanges.CreateGeofeature;
  const success = base.success.superRefine(() => {
    validations++;
  });
  const response = p.contract(
    z.union([
      z.strictObject({ kind: z.literal('success'), status: z.literal(200), body: success }),
      p.HttpError,
    ]),
    'http_response',
  );
  const result = p.readHttp(
    { ...base, success, response },
    {
      status: 200,
      headers: responseHeaders(),
      body: encode({ dataset_id: s.id, data: s.geofeature, commit_cursor: 'cursor' }),
    },
    { request: s.examples.CreateGeofeature[0] },
  );
  assert.deepEqual(result.body.data, s.geofeature);
  assert.equal(validations, 1);
});

test('all 66 HTTP examples cover the authoritative exchange inventory', () => {
  assert.equal(Object.keys(s.examples).length, 66);
  assert.deepEqual(Object.keys(p.exchanges).sort(), Object.keys(s.examples).sort());
});

test('HTTP rejects wrong context, compression, status, media and mismatched response identities', () => {
  assert.deepEqual(
    p.readHttpRequest(
      p.exchanges.GetHealth,
      { method: 'GET', path: '/health', headers: requestHeaders() },
      { maxBytes: 0, maxValues: 0 },
    ),
    {},
  );
  const definition = p.exchanges.GetTask;
  const received = {
    status: 200,
    headers: responseHeaders(),
    body: encode({ dataset_id: s.id, data: s.task }),
  };
  assert.equal(
    p.readHttp(definition, received, { request: { task_id: s.taskId } }).kind,
    'success',
  );
  refuses(
    () => p.readHttp(definition, received, { request: { task_id: s.requestId } }),
    'invalid_http',
  );
  for (const [header, value] of [
    ['Atlas-Dataset-ID', s.requestId],
    ['Atlas-Protocol-Version', '0.1.0'],
    ['Content-Type', 'text/plain'],
    ['Content-Encoding', 'gzip'],
    ['Content-Length', '1'],
  ]) {
    const headers = new Headers(received.headers);
    headers.set(header, value);
    refuses(() => p.readHttp(definition, { ...received, headers }));
  }
  refuses(() => p.readHttp(definition, { ...received, status: 201 }));
  const diagnostic = new Headers(received.headers);
  diagnostic.set('Atlas-Request-ID', 'bad');
  assert.equal(p.readHttp(definition, { ...received, headers: diagnostic }).kind, 'success');
  assert.deepEqual(p.correlation(diagnostic), {});
  const error = {
    dataset_id: s.id,
    error: { code: 'unauthorized', message: '', request_id: s.requestId },
  };
  refuses(() =>
    p.readHttp(definition, { status: 409, headers: responseHeaders(), body: encode(error) }),
  );
  error.error.details = { stack: 'private' };
  refuses(() =>
    p.readHttp(definition, { status: 401, headers: responseHeaders(), body: encode(error) }),
  );
  const taskReply = (task) => ({
    status: 200,
    headers: responseHeaders(),
    body: encode({ dataset_id: s.id, data: task, commit_cursor: 'cursor' }),
  });
  refuses(() =>
    p.readHttp(p.exchanges.CreateTask, taskReply({ ...s.task, asset_id: s.id }), {
      request: s.createTask,
    }),
  );
  refuses(() =>
    p.readHttp(
      p.exchanges.CreateTask,
      taskReply({
        ...s.task,
        inputs: { target: { kind: 'position', position: { latitude: 1, longitude: 0 } } },
      }),
      { request: s.createTask },
    ),
  );
  const uploadReply = {
    status: 200,
    headers: responseHeaders(),
    body: encode({
      dataset_id: s.id,
      data: { ...s.object, sha256: 'a'.repeat(64) },
      commit_cursor: 'cursor',
    }),
  };
  refuses(() =>
    p.readHttp(p.exchanges.UploadObject, uploadReply, { request: s.examples.UploadObject[0] }),
  );
  const mismatchedDataset = {
    dataset_id: s.id,
    error: {
      code: 'dataset_mismatch',
      message: '',
      request_id: s.requestId,
      details: { dataset_id: s.taskId },
    },
  };
  refuses(() =>
    p.readHttp(definition, {
      status: 409,
      headers: responseHeaders(),
      body: encode(mismatchedDataset),
    }),
  );
});

test('Task terminals and Command inputs remain disjoint without serialized cancellation overlays', () => {
  assert.equal(
    p.Task.safeParse({
      ...s.task,
      execution_state: 'completed',
      cancellation_request_id: s.requestId,
    }).success,
    false,
  );
  for (const field of ['state', 'cancellation_requested', 'execution_evidence'])
    assert.equal(
      p.Task.safeParse({ ...s.task, [field]: field === 'cancellation_requested' ? true : {} })
        .success,
      false,
    );
  assert.equal(
    p.Task.safeParse({
      ...s.task,
      execution_state: 'pending',
      cancellation_request_id: s.requestId,
    }).success,
    true,
  );
  assert.equal(p.CreateTask.safeParse({ ...s.createTask, expires_at: s.later }).success, false);
  assert.equal(
    p.Capabilities.safeParse({ commands: [{ command: 'move_to', scheduling: ['immediate'] }] })
      .success,
    false,
  );
  const declaration = { object_id: s.requestId, required: true };
  assert.equal(
    p.ReportTaskResults.safeParse({
      evidence: s.evidence({ task_id: s.taskId, declarations: [declaration, declaration] }),
    }).success,
    true,
  );
  assert.equal(
    p.ReportTaskResults.safeParse({
      evidence: s.evidence({
        task_id: s.taskId,
        declarations: [declaration, { ...declaration, required: false }],
      }),
    }).success,
    false,
  );
  assert.equal(
    p.ErrorObject.safeParse({ code: 'cursor_expired', message: '', request_id: s.id }).success,
    false,
  );
});

test('Power time maps enforce closure, actual membership, kind restrictions and cardinality', () => {
  const section = {
    state: 'value',
    classification: 'dated_measurement',
    observed_at: null,
    value: { external_power: null, reserves: [{ id: s.id, kind: 'fuel', remaining_percent: 0 }] },
    source_times: { reserves: { [s.id]: { remaining_percent: null } } },
  };
  assert.equal(p.inputSections.power.safeParse(section).success, true);
  for (const times of [
    { [s.requestId]: { remaining_percent: null } },
    { [s.id]: { voltage_volts: null } },
    { [s.id]: { extra: null } },
    { bad: {} },
  ])
    assert.equal(
      p.inputSections.power.safeParse({ ...section, source_times: { reserves: times } }).success,
      false,
    );
  const reserves = Array.from({ length: 17 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    kind: 'fuel',
    remaining_percent: null,
  }));
  assert.equal(
    p.Power.safeParse({ external_power: null, reserves: reserves.slice(0, 16) }).success,
    true,
  );
  assert.equal(p.Power.safeParse({ external_power: null, reserves }).success, false);
  assert.equal(
    p.PowerTimes.safeParse({
      reserves: Object.fromEntries(reserves.map((reserve) => [reserve.id, {}])),
    }).success,
    false,
  );
});

test('complete WSS authentication, controls, replies, replay, changes and errors', () => {
  const context = { dataset_id: s.id, protocol_version: '0.4.0' };
  const control = (type, data) => ({ type, ...context, request_id: s.requestId, data });
  const event = (type, data) => ({ type, ...context, data });
  const frames = [
    control('authenticated', { core_run_id: s.requestId, limits: s.limits }),
    control('read_snapshot_result', s.snapshot),
    control('read_changes_result', s.replay),
    control('snapshot_released', { released: true }),
    control('subscribed', s.wssExamples.SubscribeChanges[1]),
    control('unsubscribed', { subscription_id: s.requestId }),
    event('progress', {
      subscription_id: s.requestId,
      previous_cursor: 'before',
      through_cursor: 'after',
    }),
    event('handoff_complete', { subscription_id: s.requestId, handoff_cursor: 'handoff' }),
    event('gap', {
      subscription_id: s.requestId,
      reason: 'resource_limit',
      earliest_recoverable_cursor: 'cursor',
    }),
    {
      type: 'error',
      ...context,
      error: { code: 'resource_limit', message: '', request_id: s.requestId },
    },
  ];
  for (const [kind, image] of [
    ['asset', s.asset],
    ['track', s.track],
    ['geofeature', s.geofeature],
    ['task', s.task],
    ['object', s.object],
  ]) {
    const change = {
      kind: 'put',
      resource_kind: kind,
      resource_id: image.id ?? image.task_id ?? image.object_id,
      version: image.version,
      image,
    };
    for (const mismatch of [{ resource_id: s.processId }, { version: '1' }])
      refuses(
        () => p.readJson(p.contract(p.Put), encode({ ...change, ...mismatch })),
        'invalid_value',
      );
    frames.push(
      event('change_batch', {
        subscription_id: s.requestId,
        previous_cursor: 'before',
        commit_cursor: 'after',
        changes: [change],
      }),
    );
  }
  for (const frame of frames) assert.deepEqual(p.readJson(p.wss.serverFrame, encode(frame)), frame);
  const authenticate = {
    type: 'authenticate',
    ...context,
    request_id: s.requestId,
    api_key: 'A'.repeat(43),
  };
  assert.deepEqual(p.readJson(p.wss.clientFrame, encode(authenticate)), authenticate);
  for (const type of [
    'read_snapshot',
    'read_changes',
    'release_snapshot',
    'subscribe_changes',
    'unsubscribe_changes',
  ]) {
    const names = {
      read_snapshot: 'ReadSnapshot',
      read_changes: 'ReadChanges',
      release_snapshot: 'ReleaseSnapshot',
      subscribe_changes: 'SubscribeChanges',
      unsubscribe_changes: 'UnsubscribeChanges',
    };
    const frame = control(type, (s.examples[names[type]] ?? s.wssExamples[names[type]])[0]);
    assert.deepEqual(p.readJson(p.wss.clientFrame, encode(frame)), frame);
    refuses(() => p.readJson(p.wss.clientFrame, encode({ ...frame, request_id: undefined })));
  }
  const replay = {
    replay_boundary: 'end',
    messages: [
      { type: 'progress', data: { previous_cursor: 'start', through_cursor: 'mid' } },
      { type: 'progress', data: { previous_cursor: 'mid', through_cursor: 'end' } },
    ],
    through_cursor: 'end',
    next_page_token: null,
  };
  assert.equal(p.ReplayPage.safeParse(replay).success, true);
  replay.messages[1].data.previous_cursor = 'gap';
  assert.equal(p.ReplayPage.safeParse(replay).success, false);
  refuses(() => p.readWssServer(encode({ ...frames[0], protocol_version: 'other-version' })));
  refuses(() => p.writeWssServer(null));
  const proofOnly = { ...s.report, sections: {}, contact_proof: { challenge_id: s.requestId } };
  assert.equal(p.AssetReport.safeParse(proofOnly).success, true);
});

test('frozen history page order uses nanoseconds and complete source identity', () => {
  const reading = (readingId, observed, timeStatus = 'known') => ({
    source_entity_kind: 'observation',
    source_entity_id: s.observationId,
    quantity: 'position',
    value: null,
    source_evidence: {
      origin: { kind: 'publisher', publisher_id: s.processId },
      reading_id: readingId,
    },
    observed_at: observed,
    time_status: timeStatus,
    track_ids: [s.trackId],
  });
  const a = reading(s.requestId, '2026-10-23T00:00:00.000000001Z');
  const b = reading(s.taskId, '2026-10-23T00:00:00.000000002Z');
  const unknown = reading(s.id, null, 'unknown');
  assert.equal(
    p.HistoryPage.safeParse({ ...s.historyPage, readings: [a, b, unknown] }).success,
    true,
  );
  assert.equal(p.HistoryPage.safeParse({ ...s.historyPage, readings: [b, a] }).success, false);
  assert.equal(
    p.HistoryPage.safeParse({ ...s.historyPage, readings: [unknown, a] }).success,
    false,
  );
  assert.equal(p.HistoryPage.safeParse({ ...s.historyPage, readings: [a, a] }).success, false);
  const sameInstant = { ...b, observed_at: '2026-10-23T00:00:00.000000001Z' };
  assert.equal(
    p.HistoryPage.safeParse({ ...s.historyPage, readings: [a, sameInstant] }).success,
    true,
  );
  assert.equal(
    p.HistoryPage.safeParse({ ...s.historyPage, readings: [sameInstant, a] }).success,
    false,
  );
  assert.equal(p.HistoryQuery.safeParse({ page_token: 'token', page_size: 10 }).success, false);
  assert.equal(
    p.exchanges.GetAssignedTasks.request.schema.safeParse({ page_token: 'token', read_id: s.id })
      .success,
    false,
  );
});

test('moving lists, assigned pages and snapshots retain their declared order', () => {
  const first = { ...s.task, task_id: s.id, request_id: s.id };
  const page = (tasks) => ({
    status: 200,
    headers: responseHeaders(),
    body: encode({ dataset_id: s.id, data: { items: tasks, next_page_token: null } }),
  });
  assert.equal(p.readHttp(p.exchanges.ListTasks, page([first, s.task])).kind, 'success');
  refuses(() => p.readHttp(p.exchanges.ListTasks, page([s.task, first])));
  const assigned = { ...s.examples.GetAssignedTasks[1], tasks: [first, s.task] };
  assert.equal(p.AssignedTasks.safeParse(assigned).success, true);
  assert.equal(p.AssignedTasks.safeParse({ ...assigned, tasks: [s.task, first] }).success, false);
  const put = (image) => ({
    kind: 'put',
    resource_kind: 'task',
    resource_id: image.task_id,
    version: image.version,
    image,
  });
  assert.equal(
    p.SnapshotPage.safeParse({ ...s.snapshot, items: [put(first), put(s.task)] }).success,
    true,
  );
  assert.equal(
    p.SnapshotPage.safeParse({ ...s.snapshot, items: [put(s.task), put(first)] }).success,
    false,
  );
});
