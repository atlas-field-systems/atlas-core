import { harness } from './harness.mjs';
import * as s from './samples.mjs';

export function runSynchronizationRegressions(p) {
  const { check, assert, refuses, encode, result } = harness(p);
  const context = { dataset_id: s.id, protocol_version: p.PROTOCOL_VERSION };
  const reply = (name, data, request) =>
    p.readHttp(
      p.exchanges[name],
      {
        status: 200,
        headers: new Headers({
          'Atlas-Dataset-ID': s.id,
          'Atlas-Protocol-Version': p.PROTOCOL_VERSION,
          'Content-Type': 'application/json',
        }),
        body: encode({ dataset_id: s.id, data }),
      },
      { datasetId: s.id, request },
    ).body.data;
  const batch = (previous_cursor, commit_cursor, changes) => ({
    type: 'change_batch',
    data: { previous_cursor, commit_cursor, changes },
  });
  const progress = (previous_cursor, through_cursor) => ({
    type: 'progress',
    data: { previous_cursor, through_cursor },
  });
  const deletion = (resource_kind) => ({
    kind: 'delete',
    resource_kind,
    resource_id: s.requestId,
    version: '1',
  });
  const put = (resource_kind, image) => ({
    kind: 'put',
    resource_kind,
    resource_id: resource_kind === 'task' ? image.task_id : image.id,
    version: image.version,
    image,
  });
  const page = (messages, through_cursor = 'end', next_page_token = null) => ({
    replay_boundary: 'end',
    messages,
    through_cursor,
    next_page_token,
  });
  const live = (message) => ({
    ...message,
    ...context,
    data: { ...message.data, subscription_id: s.requestId },
  });
  const replayFrame = (data) => ({
    type: 'read_changes_result',
    ...context,
    request_id: s.requestId,
    data,
  });
  const readLive = (message) =>
    p.readWssServer(encode(live(message)), { datasetId: s.id, subscriptionId: s.requestId });
  const readReplay = (data) => reply('ReadChanges', data, { from_cursor: 'start', ...s.limits });
  const checkSchema = (schema, value, expected) =>
    assert(
      schema.safeParse(value).success === expected,
      `Schema acceptance differs from ${expected}`,
    );
  const changeReaders = {
    'Delete schema': (change) => p.readJson(p.contract(p.Delete), encode(change)),
    'Change schema': (change) => p.readJson(p.contract(p.Change), encode(change)),
    'HTTP replay': (change) => readReplay(page([batch('start', 'end', [change])])),
    'WSS live': (change) => readLive(batch('start', 'end', [change])),
    'WSS replay': (change) =>
      p.readWssServer(encode(replayFrame(page([batch('start', 'end', [change])])))),
  };
  for (const kind of ['asset', 'geofeature', 'object', 'task', 'track']) {
    const allowed = !['task', 'track'].includes(kind);
    check(`exported Delete schema ${allowed ? 'accepts' : 'rejects'} ${kind}`, () =>
      checkSchema(p.Delete, deletion(kind), allowed),
    );
    for (const [boundary, read] of Object.entries(changeReaders))
      check(`${boundary} ${allowed ? 'accepts' : 'rejects'} ${kind} deletion`, () => {
        if (allowed) read(deletion(kind));
        else refuses(() => read(deletion(kind)), 'invalid_value');
      });
  }
  for (const [kind, image] of [
    ['task', s.task],
    ['track', s.track],
  ])
    check(`retained ${kind} remains readable in HTTP replay and WSS live`, () => {
      const message = batch('start', 'end', [put(kind, image)]);
      const replay = readReplay(page([message]));
      assert(replay.messages[0].data.changes[0].image.version === image.version, 'HTTP image lost');
      const decoded = readLive(message);
      assert(decoded.data.changes[0].resource_kind === kind, 'WSS image lost');
    });

  const batchReaders = {
    'ReplayBatch schema': (message) => p.readJson(p.contract(p.ReplayBatch), encode(message)),
    'HTTP replay': (message) => readReplay(page([message], message.data.commit_cursor, 'next')),
    'WSS live': readLive,
    'WSS replay': (message) =>
      p.readWssServer(encode(replayFrame(page([message], message.data.commit_cursor, 'next')))),
  };
  for (const [boundary, read] of Object.entries(batchReaders)) {
    check(`${boundary} accepts an advancing batch`, () =>
      read(batch('start', 'end', [deletion('asset')])),
    );
    check(`${boundary} rejects a batch at the same cursor`, () =>
      refuses(() => read(batch('start', 'start', [deletion('asset')])), 'invalid_value'),
    );
  }

  const replayReaders = {
    'ReplayPage schema': (data) => p.readJson(p.contract(p.ReplayPage), encode(data)),
    'HTTP replay': readReplay,
    'WSS replay': (data) => p.readWssServer(encode(replayFrame(data))),
  };
  const advancing = batch('start', 'middle', [deletion('geofeature')]);
  const replayCases = [
    [
      'ordered batches',
      [advancing, batch('middle', 'end', [deletion('object')])],
      'end',
      null,
      true,
    ],
    [
      'repeated no-op progress between advances',
      [
        progress('start', 'start'),
        progress('start', 'start'),
        advancing,
        progress('middle', 'middle'),
        progress('middle', 'middle'),
        progress('middle', 'end'),
        progress('end', 'end'),
      ],
      'end',
      null,
      true,
    ],
    [
      'partial no-op progress',
      [progress('start', 'start'), progress('start', 'start')],
      'start',
      'next',
      true,
    ],
    [
      'progress cycle to initial position',
      [progress('start', 'middle'), progress('middle', 'start'), progress('start', 'end')],
      'end',
      null,
      false,
    ],
    [
      'progress reuses an intermediate position',
      [progress('start', 'a'), progress('a', 'b'), progress('b', 'a'), progress('a', 'end')],
      'end',
      null,
      false,
    ],
    [
      'mixed batch and progress cycle',
      [advancing, progress('middle', 'start'), progress('start', 'end')],
      'end',
      null,
      false,
    ],
    [
      'batch cycle',
      [advancing, batch('middle', 'start', [deletion('object')])],
      'start',
      'next',
      false,
    ],
    [
      'replayed batch in one page',
      [advancing, progress('middle', 'start'), advancing],
      'middle',
      'next',
      false,
    ],
  ];
  for (const [name, messages, through, token, allowed] of replayCases)
    for (const [boundary, read] of Object.entries(replayReaders))
      check(`${boundary} ${allowed ? 'accepts' : 'rejects'} ${name}`, () => {
        const data = page(messages, through, token);
        if (allowed) read(data);
        else refuses(() => read(data), 'invalid_value');
        checkSchema(p.ReplayPage, data, allowed);
      });
  check('WSS live preserves repeated no-op progress', () => {
    const message = progress('current', 'current');
    const decoded = readLive(message);
    assert(decoded.data.through_cursor === 'current', 'No-op progress changed');
    p.readWssServer(p.writeWssServer(decoded));
  });

  const resume = (accepted_at, expires_at, execution_state = 'pending') => ({
    ...s.task,
    command: 'resume',
    scheduling: 'immediate',
    inputs: {},
    accepted_at,
    expires_at,
    execution_state,
    execution_summary:
      execution_state === 'pending'
        ? null
        : {
            origin: s.origin,
            report_id: s.requestId,
            sequence: '1',
            generated_at: null,
            event: 'state',
            state: execution_state,
          },
  });
  const taskReaders = {
    'Task schema': (task) => p.readJson(p.contract(p.Task), encode(task)),
    'HTTP Task': (task) => reply('GetTask', task, { task_id: s.taskId }),
    'HTTP snapshot': (task) =>
      reply('ReadSnapshot', { ...s.snapshot, items: [put('task', task)] }, s.snapshotFirst),
    'WSS live Task': (task) => readLive(batch('start', 'end', [put('task', task)])),
    'WSS snapshot Task': (task) =>
      p.readWssServer(
        encode({
          type: 'read_snapshot_result',
          ...context,
          request_id: s.requestId,
          data: { ...s.snapshot, items: [put('task', task)] },
        }),
      ),
  };
  const accepted = '2026-12-31T23:59:59.999999999Z';
  const intervalCases = [
    ['one nanosecond', accepted, '2027-01-01T00:00:00Z', true],
    ['exactly sixty seconds', accepted, '2027-01-01T00:00:59.999999999Z', true],
    ['same instant', accepted, accepted, false],
    [
      'same instant with another precision',
      '2026-10-23T00:00:00.1Z',
      '2026-10-23T00:00:00.100000000Z',
      false,
    ],
    ['one nanosecond before admission', accepted, '2026-12-31T23:59:59.999999998Z', false],
    ['sixty seconds plus one nanosecond', accepted, '2027-01-01T00:01:00Z', false],
    ['invalid admission time', '2026-02-30T00:00:00Z', '2026-03-01T00:00:30Z', false],
    ['invalid expiry', accepted, 'invalid', false],
  ];
  for (const [name, admitted, expiry, allowed] of intervalCases)
    for (const [boundary, read] of Object.entries(taskReaders))
      check(`${boundary} ${allowed ? 'accepts' : 'rejects'} Resume ${name}`, () => {
        const task = resume(admitted, expiry);
        if (allowed) read(task);
        else refuses(() => read(task), 'invalid_value');
        checkSchema(p.Task, task, allowed);
      });
  for (const state of ['pending', 'completed'])
    check(`historical ${state} Resume remains readable without a wall clock check`, () => {
      const task = resume(
        '0001-12-31T23:59:59.999999999Z',
        '0002-01-01T00:00:59.999999999Z',
        state,
      );
      for (const read of Object.values(taskReaders)) read(task);
    });
  check('Move To and Pause keep their existing Task images', () => {
    for (const task of [
      s.task,
      { ...s.task, command: 'pause', scheduling: 'immediate', inputs: {} },
    ])
      for (const read of Object.values(taskReaders)) read(task);
  });
  return result();
}
