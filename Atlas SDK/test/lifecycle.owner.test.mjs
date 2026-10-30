import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { exchanges, readHttp } from '@atlas/protocol';
import { Session } from '../dist/connection.js';
import { Operations } from '../dist/prepared.js';
import { exchange, receive } from '../dist/http.js';
import { fixture, barrier, uuid, secret, task } from './harness.mjs';

function success(result) {
  assert.equal(result.kind, 'response', JSON.stringify(result));
  assert.equal(result.response.kind, 'success', JSON.stringify(result));
  return result.response.body;
}
async function sessionFor(t, f, options = {}) {
  const session = new Session({ baseUrl: f.proxyUrl, credentials: () => f.apiKey, ...options });
  t.after(() => session.close());
  success(await session.discover());
  return session;
}

test('accepted health refresh preserves same-Dataset reads and persistent WSS ownership', async (t) => {
  const f = await fixture(t);
  const session = await sessionFor(t, f);
  let socket;
  let cleanup = 0;
  const lease = session.ownSocket(async () => {
    cleanup++;
    const stopped = once(socket, 'close');
    socket.close();
    await stopped;
  });
  socket = new WebSocket(new URL('/changes', f.address.replace('https:', 'wss:')));
  await once(socket, 'open');
  const captured = barrier(),
    release = barrier();
  f.once('/readiness', async ({ forward }) => {
    captured.resolve();
    await release.promise;
    forward();
  });
  const read = session.read(exchanges.GetReadiness)({});
  await captured.promise;
  const generation = session.state.generation;
  const original = session.state.health.allocation_context;
  success(await session.refreshHealth());
  assert.equal(session.state.generation, generation);
  assert.notEqual(session.state.health.allocation_context, original);
  assert.equal(lease.current(), true);
  assert.equal(cleanup, 0);
  release.resolve();
  success(await read);
  const closing = session.close();
  assert.equal(lease.signal.aborted, true);
  await closing;
  assert.equal(cleanup, 1);
  assert.equal(socket.readyState, WebSocket.CLOSED);
  await lease.release();
  assert.equal(cleanup, 1);
});

test('persistent admission remains charged through asynchronous cleanup and close waits', async (t) => {
  const f = await fixture(t);
  const session = await sessionFor(t, f, { limits: { concurrentAttempts: 1 } });
  const started = barrier(),
    finish = barrier();
  const lease = session.ownSocket(async () => {
    started.resolve();
    await finish.promise;
  });
  const release = lease.release();
  await started.promise;
  assert.equal((await session.read(exchanges.GetReadiness)({})).code, 'capacity');
  let closed = false;
  const closing = session.close().then(() => {
    closed = true;
  });
  await new Promise(setImmediate);
  assert.equal(closed, false);
  finish.resolve();
  await Promise.all([release, closing]);
  assert.equal(closed, true);
});

test('validated authority rejection fences leases and awaited cleanup failures remain visible', async (t) => {
  const f = await fixture(t);
  const session = new Session({ baseUrl: f.proxyUrl, credentials: () => f.apiKey });
  success(await session.discover());
  let stopped = 0;
  const lease = session.ownSocket(() => {
    stopped++;
    throw new Error('private path and secret');
  });
  const states = [];
  const remove = session.observe((state) => states.push(state.kind));
  session.observeAuthority(lease.generation - 1, 'unauthorized');
  assert.equal(lease.current(), true);
  session.observeAuthority(lease.generation, 'unauthorized');
  assert.equal(lease.current(), false);
  assert.equal(lease.signal.aborted, true);
  const before = f.traffic.length;
  assert.equal((await session.refreshHealth()).code, 'authorization_required');
  assert.equal((await session.read(exchanges.GetReadiness)({})).code, 'authorization_required');
  assert.equal(f.traffic.length, before);
  remove();
  await assert.rejects(session.close(), { code: 'network' });
  assert.equal(stopped, 1);
  assert.deepEqual(states, ['authorization-required']);
  await assert.rejects(session.close(), { code: 'network' });
});

test('fresh health contexts fence old Core-run and Dataset owners but not ordinary network errors', async (t) => {
  const f = await fixture(t);
  const session = await sessionFor(t, f);
  const first = session.ownSocket(() => {});
  f.once('/health', ({ outgoing }) => outgoing.destroy());
  assert.equal((await session.refreshHealth()).kind, 'failed');
  assert.equal(first.current(), true);
  await f.restart();
  success(await session.refreshHealth());
  assert.equal(first.current(), false);
  const second = session.ownSocket(() => {});
  const epoch = session.datasetEpoch;
  await f.reset();
  success(await session.refreshHealth());
  assert.equal(second.current(), false);
  assert.ok(session.datasetEpoch > epoch);
  await session.close();
});

test('later recovery fences a health refresh and validated version changes stop owners', async (t) => {
  const f = await fixture(t);
  let candidate = f.apiKey;
  const session = await sessionFor(t, f, { credentials: () => candidate });
  const admin = f.client();
  success(await admin.connect());
  const key = { api_key_id: uuid(), request_id: uuid(), secret: secret() };
  success((await admin.apiKeys.create(key).send()).attempt);
  const captured = barrier(),
    release = barrier();
  f.once('/health', async ({ forward }) => {
    captured.resolve();
    await release.promise;
    forward();
  });
  const older = session.refreshHealth();
  await captured.promise;
  candidate = key.secret;
  success(await session.discover(true));
  release.resolve();
  assert.equal((await older).code, 'superseded');
  const lease = session.ownSocket(() => {});
  f.once('/health', ({ body, headers, forward }) => {
    const altered = JSON.parse(body);
    altered.data.protocol_version = '0.2.0';
    forward(Buffer.from(JSON.stringify(altered)), 200, {
      ...headers,
      'atlas-protocol-version': '0.2.0',
    });
  });
  assert.equal((await session.refreshHealth()).kind, 'failed');
  assert.equal(session.state.kind, 'blocked');
  assert.equal(lease.current(), false);
});

test('one bounded non-JSON path owns real upload retries and shared effect evidence', async (t) => {
  const f = await fixture(t);
  const session = await sessionFor(t, f);
  const operations = new Operations(session);
  const bytes = new TextEncoder().encode('owned upload bytes');
  const prepare = operations.bindTransport(
    exchanges.UploadObject,
    {
      kind: 'mutation',
      identity: (input) => input.request_id,
      noEffect: () => false,
    },
    (input, options) =>
      session.startNetwork(
        'UploadObject',
        async (lease) => {
          const started = performance.now();
          const form = new FormData();
          form.set('descriptor', new TextDecoder().decode(input.bytes));
          form.set('file', new Blob([bytes], { type: 'application/octet-stream' }), 'content');
          const response = await fetch(new URL('/objects', lease.baseUrl), {
            method: 'POST',
            body: form,
            signal: lease.signal,
            redirect: 'error',
            headers: {
              Authorization: `Bearer ${lease.credential}`,
              'Atlas-Dataset-ID': lease.datasetId,
              'Atlas-Protocol-Version': '0.3.0',
              'Atlas-Attempt-ID': lease.attemptId,
            },
          });
          const body = await receive(response, session.responseBudget.maxBytes, () => {});
          const validated = readHttp(
            exchanges.UploadObject,
            { status: response.status, headers: response.headers, body },
            { datasetId: lease.datasetId, request: input.facts, budget: session.responseBudget },
          );
          return {
            kind: 'response',
            response: validated,
            context: {
              attemptId: lease.attemptId,
              requestId: response.headers.get('Atlas-Request-ID'),
              receivedBytes: body.byteLength,
              elapsedMs: performance.now() - started,
            },
          };
        },
        options,
      ),
  );
  const descriptor = {
    object_id: uuid(),
    request_id: uuid(),
    byte_length: String(bytes.byteLength),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    content_type: 'application/octet-stream',
    metadata: { associations: [] },
  };
  const first = prepare(descriptor),
    same = prepare(descriptor);
  f.once('/objects', ({ outgoing }) => outgoing.destroy());
  assert.equal((await first.send()).outcome.kind, 'unknown_outcome');
  const recovered = await same.send();
  assert.equal(recovered.outcome.kind, 'accepted');
  assert.equal(first.outcome.kind, 'accepted');
  assert.equal(success(recovered.attempt).data.object_id, descriptor.object_id);
  const facts = { facts: {}, bytes: new TextEncoder().encode('{}') };
  success(
    await session.startNetwork('GetReadiness', (lease) =>
      exchange(exchanges.GetReadiness, facts, lease, session.responseBudget),
    ).settled,
  );
  await session.close();
});

test('superseded validated key rejection remains rejected without revoking newer authority', async (t) => {
  const f = await fixture(t);
  let candidate = f.apiKey;
  const session = await sessionFor(t, f, { credentials: () => candidate });
  const admin = f.client();
  success(await admin.connect());
  const replacement = { api_key_id: uuid(), request_id: uuid(), secret: secret() };
  success((await admin.apiKeys.create(replacement).send()).attempt);
  const captured = barrier(),
    release = barrier();
  f.once('/health', async ({ status, forward }) => {
    assert.equal(status, 401);
    captured.resolve();
    await release.promise;
    forward();
  });
  const rejected = secret();
  candidate = rejected;
  const older = session.discover(true);
  await captured.promise;
  const provider = barrier();
  candidate = provider.promise;
  const newer = session.discover(true);
  release.resolve();
  assert.equal((await older).code, 'superseded');
  provider.resolve(replacement.secret);
  success(await newer);
  assert.equal(session.state.kind, 'ready');
  const before = f.traffic.length;
  candidate = rejected;
  assert.equal((await session.discover(true)).code, 'unchanged_credential');
  assert.equal(f.traffic.length, before);
  success(await session.read(exchanges.GetReadiness)({}));
  await session.close();
});

test('a transport refusal before transmission preserves not_submitted evidence', async (t) => {
  const f = await fixture(t);
  const session = await sessionFor(t, f);
  const operations = new Operations(session);
  const prepare = operations.bindTransport(
    exchanges.CreateTask,
    { kind: 'mutation', identity: (input) => input.request_id, noEffect: () => false },
    (_input, options) =>
      session.startNetwork(
        'CreateTask',
        async (lease) => ({
          kind: 'not_sent',
          code: 'invalid_value',
          attemptId: lease.attemptId,
        }),
        options,
      ),
  );
  const before = f.traffic.length;
  const operation = prepare(task(uuid()));
  assert.equal((await operation.send()).outcome.kind, 'not_submitted');
  assert.equal(operation.outcome.kind, 'not_submitted');
  assert.equal(f.traffic.length, before);
  await session.close();
});
