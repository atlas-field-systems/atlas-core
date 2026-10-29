import test from 'node:test';
import assert from 'node:assert/strict';
import { Diagnostics, createDiagnostics } from '../dist/diagnostics.js';
import { receive } from '../dist/http.js';
import { Session } from '../dist/connection.js';
import { Operations } from '../dist/prepared.js';
import { exchanges } from '@atlas/protocol';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, registration, task, barrier } from './harness.mjs';

const request = (overrides = {}) => ({
  kind: 'request',
  operation: 'GetTask',
  source: 'http',
  phase: 'attempt',
  outcome: 'failed',
  elapsedMs: 12,
  attemptId: 'attempt',
  code: 'network',
  ...overrides,
});

test('optional diagnostics creates no disabled owner, and active summaries stop after one interval', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal(createDiagnostics(undefined), undefined);
  assert.equal(createDiagnostics({ mode: 'disabled' }), undefined);
  const events = [],
    diagnostics = new Diagnostics({ mode: 'summary', observer: (event) => events.push(event) });
  t.mock.timers.tick(90_000);
  assert.deepEqual(events, []);
  diagnostics.record(request({ outcome: 'success' }));
  t.mock.timers.tick(30_001);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'summary');
  t.mock.timers.tick(90_000);
  assert.equal(events.length, 1);
  diagnostics.record(request());
  diagnostics.close();
  t.mock.timers.tick(90_000);
  assert.equal(events.length, 1);
});

test('Summary bounds queued records to 128 and exposes exact known omissions', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [],
    diagnostics = new Diagnostics({ mode: 'summary', observer: (event) => events.push(event) });
  for (let i = 0; i < 1_000; i++) diagnostics.record(request({ attemptId: String(i) }));
  assert.equal(events.length, 0);
  t.mock.timers.tick(1);
  assert.equal(events.length, 128);
  t.mock.timers.tick(30_001);
  const summary = events.find((event) => event.kind === 'summary');
  assert.equal(summary.omitted, 872);
  assert.equal(summary.operations.find((entry) => entry.operation === 'GetTask').attempts, 1_000);
  diagnostics.close();
});

test('Debug uses a sliding 100-record rate bound, safe frames, and omission markers for IDs', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const events = [],
    diagnostics = new Diagnostics({ mode: 'debug', observer: (event) => events.push(event) });
  const frames = Array.from({ length: 20 }, (_, i) => ({
    kind: 'location',
    module: i === 0 ? '/private/SENTINEL.ts?secret' : 'http.ts',
    function: 'exchange',
    line: 2,
    column: 1,
  }));
  diagnostics.record(
    request({
      attemptId: 'x'.repeat(257),
      requestId: 'y'.repeat(256),
      frames,
      payload: 'SENTINEL',
      headers: { Authorization: 'SENTINEL' },
      exception: new Error('SENTINEL'),
    }),
  );
  for (let i = 1; i < 200; i++) diagnostics.record(request());
  t.mock.timers.tick(1);
  assert.equal(events.length, 100);
  assert.equal(events[0].attemptId, '[omitted]');
  assert.equal(events[0].requestId.length, 256);
  assert.equal(events[0].frames.length, 16);
  assert.deepEqual(events[0].frames[0], { kind: 'unavailable' });
  assert.deepEqual(events[0].frames[1], {
    kind: 'location',
    module: 'http.ts',
    function: 'exchange',
    line: 2,
    column: 1,
  });
  assert.equal(JSON.stringify(events).includes('SENTINEL'), false);
  now = 999;
  diagnostics.record(request());
  t.mock.timers.tick(1);
  assert.equal(events.length, 100);
  now = 1000;
  diagnostics.record(request());
  t.mock.timers.tick(1);
  assert.equal(events.length, 101);
  now = 30_000;
  t.mock.timers.tick(30_000);
  const summary = events.find((event) => event.kind === 'summary');
  assert.equal(summary.omitted, 107);
  diagnostics.close();
});

test('typed picture and transfer hooks aggregate without a second event mechanism', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [],
    diagnostics = new Diagnostics({ mode: 'summary', observer: (event) => events.push(event) });
  diagnostics.record(
    request({
      phase: 'read',
      operation: 'picture',
      source: 'picture',
      outcome: 'success',
      stale: true,
    }),
  );
  diagnostics.record({
    kind: 'synchronization',
    phase: 'apply',
    generation: 3,
    datasetId: 'dataset',
    elapsedMs: 7,
    receivedCommits: 2,
    appliedCommits: 2,
    bytes: { received: 41 },
    pages: 1,
  });
  diagnostics.record(
    request({
      phase: 'transfer',
      operation: 'UploadObject',
      source: 'upload',
      outcome: 'success',
      bytes: { supplied: 99, observedTransport: null },
    }),
  );
  diagnostics.record({
    kind: 'synchronization',
    phase: 'rebuild',
    generation: 4,
    reason: 'expired_replay',
  });
  t.mock.timers.tick(30_001);
  const summary = events.find((event) => event.kind === 'summary');
  const picture = summary.operations.find((entry) => entry.operation === 'picture');
  assert.equal(picture.reads, 1);
  assert.equal(picture.staleReads, 1);
  assert.equal(picture.receivedBytes, 41);
  assert.equal(picture.localWorkMs, 7);
  const upload = summary.operations.find((entry) => entry.operation === 'UploadObject');
  assert.equal(upload.suppliedBytes, 99);
  assert.equal(upload.observedTransportBytes, null);
  assert.equal(upload.unavailableTransportSamples, 1);
  assert.equal(summary.appliedCommits, 2);
  assert.equal(summary.receivedCommits, 2);
  assert.equal(summary.pages, 1);
  assert.equal(summary.reasons.find((entry) => entry.reason === 'expired_replay').count, 1);
  diagnostics.close();
});

test('generic transport attempts preserve primary and body cancellation failures in diagnostics', async (t) => {
  const f = await fixture(t),
    events = [];
  const session = new Session({
    baseUrl: f.proxyUrl,
    credentials: () => f.apiKey,
    diagnostics: { mode: 'debug', observer: (event) => events.push(event) },
  });
  t.after(() => assert.rejects(session.close(), { code: 'network' }));
  await session.discover();
  let cancellations = 0;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(2));
    },
    cancel() {
      cancellations++;
      throw new Error('SENTINEL private body failure');
    },
  });
  const result = await session.startNetwork('ReadObjectContent', async () => {
    await receive(new Response(stream), 1, () => {});
    assert.fail('Oversized content must fail');
  }).settled;
  assert.equal(result.kind, 'failed');
  assert.equal(result.code, 'payload_too_large');
  assert.equal(result.context.cleanupFailure, 'network');
  assert.equal(cancellations, 1);
  await delay(20);
  const record = events.find(
    (event) => event.kind === 'request' && event.operation === 'ReadObjectContent',
  );
  assert.equal(record.code, 'payload_too_large');
  assert.equal(record.cleanupFailure, 'network');
  assert.equal(JSON.stringify(events).includes('SENTINEL'), false);
  await assert.rejects(session.close(), { code: 'network' });
});

test('a late validated mutation reply refines original evidence after Dataset invalidation', async (t) => {
  const f = await fixture(t);
  const session = new Session({ baseUrl: f.proxyUrl, credentials: () => f.apiKey });
  t.after(() => session.close());
  await session.discover();
  const operations = new Operations(session);
  const registered = await operations
    .bind(exchanges.RegisterAsset, {
      kind: 'mutation',
      identity: (input) => input.request_id,
      noEffect: () => false,
    })(registration())
    .send();
  const facts = task(registered.attempt.response.body.data.asset.id);
  const captured = barrier(),
    release = barrier();
  let original;
  const prepare = operations.bindTransport(
    exchanges.CreateTask,
    { kind: 'mutation', identity: (input) => input.request_id, noEffect: () => false },
    (input, options) =>
      session.startNetwork(
        'CreateTask',
        async (lease) => {
          const { exchange } = await import('../dist/http.js');
          const result = await exchange(exchanges.CreateTask, input, lease, session.responseBudget);
          captured.resolve();
          await release.promise;
          return result;
        },
        options,
      ),
  );
  original = prepare(facts);
  const running = original.start();
  await captured.promise;
  const oldDataset = session.datasetId;
  await f.reset();
  await session.refreshHealth();
  assert.equal(original.outcome.kind, 'dataset_invalidated');
  assert.equal(original.outcome.evidence.kind, 'unknown_outcome');
  release.resolve();
  assert.equal((await running.settled).response.kind, 'success');
  assert.equal(original.outcome.originalDatasetId, oldDataset);
  assert.equal(original.outcome.evidence.kind, 'accepted');
  assert.equal((await original.send()).attempt.code, 'dataset_invalidated');
  assert.notEqual(session.datasetId, oldDataset);
});
