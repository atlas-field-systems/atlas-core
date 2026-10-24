import * as s from './samples.mjs';

export function runReviewFixes(p) {
  let checks = 0;
  const failures = [];
  const check = (name, run) => {
    checks++;
    try {
      run();
    } catch (error) {
      failures.push({ name, code: error.code ?? error.message });
    }
  };
  const assert = (value, message) => {
    if (!value) throw new Error(message);
  };
  const encode = (value) => new TextEncoder().encode(JSON.stringify(value));
  const headers = () =>
    new Headers({
      'Atlas-Dataset-ID': s.id,
      'Atlas-Protocol-Version': '0.1.0',
      Authorization: `Bearer ${'A'.repeat(43)}`,
      'Content-Type': 'application/json',
    });
  const received = (data, committed = true) => ({
    status: 200,
    headers: headers(),
    body: encode({ dataset_id: s.id, data, ...(committed ? { commit_cursor: 'cursor' } : {}) }),
  });
  const refuses = (run, code, issue) => {
    try {
      run();
    } catch (error) {
      assert(
        error instanceof p.ProtocolError && error.code === code,
        `Expected ${code}, received ${error.code ?? error.message}`,
      );
      if (issue)
        assert(
          JSON.stringify(error.issues) === JSON.stringify([issue]),
          `Wrong diagnostic ${JSON.stringify(error.issues)}`,
        );
      return;
    }
    throw new Error(`Accepted instead of ${code}`);
  };
  const cancellation = { request_id: s.requestId, task_id: s.taskId };
  const cancel = (task, committed = true) =>
    p.readHttp(p.exchanges.RequestTaskCancellation, received(task, committed), {
      request: cancellation,
    });
  check('nonterminal cancellation proves this request and its commit', () => {
    const task = { ...s.task, cancellation_request_id: s.requestId };
    assert(
      cancel(task).body.data.cancellation_request_id === s.requestId,
      'Cancellation intent lost',
    );
    assert(cancel(task).body.commit_cursor === 'cursor', 'Exact retry lost its cursor');
    refuses(() => cancel(s.task), 'invalid_http');
    refuses(() => cancel({ ...task, cancellation_request_id: s.id }), 'invalid_http');
    refuses(() => cancel(task, false), 'invalid_http');
    refuses(
      () => p.readHttp(p.exchanges.RequestTaskCancellation, received(s.task)),
      'invalid_http',
    );
  });
  for (const state of ['completed', 'failed', 'cancelled'])
    check(`terminal ${state} cancellation retains the outcome without a new effect`, () => {
      const task = { ...s.task, execution_state: state };
      assert(cancel(task, false).body.data.execution_state === state, 'Terminal outcome changed');
    });
  check('revocation response proves the key is revoked', () => {
    const request = s.examples.RevokeApiKey[0];
    const result = p.readHttp(
      p.exchanges.RevokeApiKey,
      received({ ...s.apiKey, revoked_at: s.time }),
      { request },
    );
    assert(result.body.data.revoked_at === s.time, 'Revocation time lost');
    refuses(
      () => p.readHttp(p.exchanges.RevokeApiKey, received(s.apiKey), { request }),
      'invalid_http',
    );
    refuses(() => p.readHttp(p.exchanges.RevokeApiKey, received(s.apiKey)), 'invalid_http');
  });
  check('creation preserves supplied immutable publisher subject', () => {
    const subject = { id: 'subject', lifetime_id: s.requestId };
    const request = { ...s.examples.CreateObservation[0], publisher_subject: subject };
    const result = (publisher_subject) => ({
      observation: { ...s.observation, ...(publisher_subject ? { publisher_subject } : {}) },
      track: s.track,
    });
    assert(
      p.readHttp(p.exchanges.CreateObservation, received(result(subject)), { request }).body.data
        .observation.publisher_subject.id === 'subject',
      'Subject lost',
    );
    for (const changed of [
      undefined,
      { ...subject, id: 'other' },
      { ...subject, lifetime_id: s.id },
    ])
      refuses(
        () => p.readHttp(p.exchanges.CreateObservation, received(result(changed)), { request }),
        'invalid_http',
      );
    p.readHttp(
      p.exchanges.CreateObservation,
      received(result({ lifetime_id: s.requestId, id: 'subject' })),
      { request },
    );
  });
  check('request context observes byte, value, depth and geometry admission', () => {
    const reply = received(s.task, false);
    const read = (request, budget) => p.readHttp(p.exchanges.GetTask, reply, { request, budget });
    refuses(() => read({ task_id: s.taskId, extra: 'x'.repeat(1048576) }), 'payload_too_large');
    refuses(() => read({ task_id: s.taskId, extra: Array(65536).fill(null) }), 'resource_limit');
    let deep = null;
    for (let i = 0; i < 33; i++) deep = [deep];
    refuses(() => read({ task_id: s.taskId, extra: deep }), 'resource_limit');
    const geometry = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    };
    const request = { ...s.examples.CreateGeofeature[0], geometry };
    refuses(
      () =>
        p.readHttp(p.exchanges.CreateGeofeature, received({ ...s.geofeature, geometry }), {
          request,
          budget: { maxGeometryWork: 0 },
        }),
      'resource_limit',
    );
  });
  for (const boundary of ['request context', 'serialization']) {
    const consume = (binding, request, data, budget) =>
      boundary === 'request context'
        ? p.readHttp(binding, received(data), { request, budget })
        : p.writeJson(binding.request, request, budget);
    const polygonRequest = () => ({
      ...s.examples.CreateGeofeature[0],
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
    });
    const geofeature = (request) => ({
      ...s.geofeature,
      geometry: structuredClone(request.geometry),
    });
    check(`${boundary} refuses hidden oversized allocation context`, () => {
      const request = { ...s.snapshotFirst, allocation_context: 'x'.repeat(1048576) };
      const run = () => consume(p.exchanges.ReadSnapshot, request, s.snapshot);
      refuses(run, 'payload_too_large');
      Object.defineProperty(request, 'allocation_context', { enumerable: false });
      refuses(run, 'invalid_value');
    });
    check(`${boundary} refuses hidden polygon before geometry work`, () => {
      const request = polygonRequest();
      const run = () =>
        consume(p.exchanges.CreateGeofeature, request, s.geofeature, { maxGeometryWork: 0 });
      refuses(run, 'resource_limit');
      Object.defineProperty(request, 'geometry', { enumerable: false });
      refuses(run, 'invalid_value');
    });
    check(`${boundary} refuses hidden fields and accessors without invoking getters`, () => {
      const fields = [
        (request) => [request, 'geometry'],
        (request) => [request.geometry, 'coordinates'],
        (request) => [request.geometry.coordinates, '0'],
        (request) => [request.geometry.coordinates[0][0], '0'],
        (request) => [request.geometry.coordinates, 'extra'],
      ];
      for (const field of fields)
        for (const kind of ['hidden data', 'hidden getter', 'enumerable getter']) {
          const request = polygonRequest();
          const data = geofeature(request);
          const [target, key] = field(request);
          const value = Object.getOwnPropertyDescriptor(target, key)?.value ?? [];
          let reads = 0;
          const descriptor =
            kind === 'hidden data'
              ? { value, enumerable: false }
              : {
                  get() {
                    reads++;
                    return value;
                  },
                  enumerable: kind === 'enumerable getter',
                };
          Object.defineProperty(target, key, descriptor);
          refuses(() => consume(p.exchanges.CreateGeofeature, request, data), 'invalid_value');
          assert(reads === 0, `${kind} getter ran for ${key}`);
        }
    });
    check(`${boundary} preserves plain and null-prototype objects and ordinary arrays`, () => {
      for (const prototype of [Object.prototype, null]) {
        const request = polygonRequest();
        Object.setPrototypeOf(request, prototype);
        Object.setPrototypeOf(request.geometry, prototype);
        const data = geofeature(request);
        const result = consume(p.exchanges.CreateGeofeature, request, data);
        if (boundary === 'request context')
          assert(
            JSON.stringify(result.body.data.geometry) === JSON.stringify(data.geometry),
            'Geometry changed',
          );
        else
          assert(
            JSON.stringify(p.readJson(p.exchanges.CreateGeofeature.request, result)) ===
              JSON.stringify(request),
            'Constructed facts changed',
          );
      }
    });
    check(`${boundary} refuses extra array properties and sparse entries`, () => {
      const request = polygonRequest();
      const data = geofeature(request);
      request.geometry.coordinates.extra = [];
      refuses(() => consume(p.exchanges.CreateGeofeature, request, data), 'invalid_value');
      delete request.geometry.coordinates.extra;
      delete request.geometry.coordinates[0][1];
      refuses(() => consume(p.exchanges.CreateGeofeature, request, data), 'invalid_value');
    });
  }
  const inbound = () => ({
    method: 'POST',
    path: p.exchanges.GetTask.path,
    headers: headers(),
    body: encode({ task_id: s.taskId }),
  });
  for (const [name, value, message] of [
    ['Atlas-Dataset-ID', null, 'missing'],
    ['Atlas-Dataset-ID', 'bad', 'invalid'],
    ['Atlas-Protocol-Version', null, 'missing'],
    ['Atlas-Protocol-Version', '0.2.0', 'mismatch'],
    ['Authorization', null, 'missing'],
    ['Authorization', 'Bearer private-invalid-secret', 'invalid'],
  ])
    check(`inbound ${name} ${message} has a fixed safe diagnostic`, () => {
      const input = inbound();
      if (value === null) input.headers.delete(name);
      else input.headers.set(name, value);
      refuses(() => p.readHttpRequest(p.exchanges.GetTask, input), 'invalid_http', {
        path: `header.${name}`,
        message,
      });
    });
  for (const [field, value, message] of [
    ['method', 'PUT', 'mismatch'],
    ['path', '/private-path', 'mismatch'],
    ['media', 'text/plain', 'unsupported'],
  ])
    check(`inbound ${field} has a fixed safe diagnostic`, () => {
      const input = inbound();
      if (field === 'media') input.headers.set('Content-Type', value);
      else input[field] = value;
      refuses(() => p.readHttpRequest(p.exchanges.GetTask, input), 'invalid_http', {
        path: field,
        message,
      });
    });
  check('invalid content identity and media grammar retain safe refusal locations', () => {
    refuses(
      () =>
        p.readHttpRequest(p.exchanges.ReadObjectContent, {
          method: 'GET',
          path: `/objects/${'-'.repeat(36)}/content?disposition=inline`,
          headers: headers(),
        }),
      'invalid_http',
      { path: 'path', message: 'invalid' },
    );
    const input = inbound();
    input.headers.set('Content-Type', 'application/json; private=secret');
    refuses(() => p.readHttpRequest(p.exchanges.GetTask, input), 'invalid_http', {
      path: 'media',
      message: 'invalid',
    });
    input.headers.delete('Content-Type');
    refuses(() => p.readHttpRequest(p.exchanges.GetTask, input), 'invalid_http', {
      path: 'media',
      message: 'missing',
    });
  });
  check('malformed diagnostic correlation remains nonfatal', () => {
    const input = inbound();
    input.headers.set('Atlas-Request-ID', 'bad');
    input.headers.set('Atlas-Attempt-ID', 'bad');
    assert(
      p.readHttpRequest(p.exchanges.GetTask, input).task_id === s.taskId,
      'Correlation blocked request',
    );
    assert(Object.keys(p.correlation(input.headers)).length === 0, 'Malformed correlation escaped');
  });
  return { checks, passed: checks - failures.length, failures };
}
