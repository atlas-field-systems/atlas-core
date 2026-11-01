import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, registration, task, uuid, secret, barrier } from './harness.mjs';
import { sourceAsset } from './public-helpers.mjs';

function success(result) {
  assert.equal(result.kind, 'response', JSON.stringify(result));
  assert.equal(result.response.kind, 'success', JSON.stringify(result));
  return result.response.body;
}
async function ready(f, diagnostics) {
  const client = f.client({ diagnostics });
  success(await client.connect());
  return client;
}
const { SdkError } = await import(process.env.ATLAS_SDK_ENTRY ?? '../dist/index.js');
const requests = (events, operation) =>
  events.filter((event) => event.kind === 'request' && event.operation === operation);

test('Summary correlates a real lost commit and deliberate retry without exposing caller data', async (t) => {
  const f = await fixture(t),
    events = [];
  const client = await ready(f, { mode: 'summary', observer: (event) => events.push(event) });
  const facts = registration('SENTINEL-OPERATIONAL-FILENAME');
  facts.secret = secret();
  const asset = success((await client.assets.register(facts).send()).attempt).data.asset;
  const operation = client.tasks.create(task(asset.id));
  f.once('/messages/create_task', ({ outgoing }) => outgoing.destroy());
  const lost = await operation.send();
  assert.equal(lost.outcome.kind, 'unknown_outcome');
  const retry = await operation.send();
  assert.equal(retry.outcome.kind, 'accepted');
  success(retry.attempt);
  await delay(20);
  const attempts = requests(events, 'CreateTask');
  assert.equal(attempts.length, 2);
  assert.deepEqual(
    attempts.map((event) => event.operationOutcome),
    ['unknown_outcome', 'accepted'],
  );
  assert.deepEqual(
    attempts.map((event) => event.attemptNumber),
    [1, 2],
  );
  assert.deepEqual(
    attempts.map((event) => event.intentionalRetry),
    [false, true],
  );
  assert.equal(attempts[1].resolution, true);
  assert.equal(attempts[0].retryId, operation.submission.identity);
  assert.equal(attempts[1].retryId, operation.submission.identity);
  assert.equal(attempts[0].attemptId, lost.attempt.context.attemptId);
  assert.equal(attempts[1].attemptId, retry.attempt.context.attemptId);
  assert.equal(attempts[1].requestId, retry.attempt.context.requestId);
  assert.equal(attempts[1].bytes.received, retry.attempt.context.receivedBytes);
  assert.equal(
    attempts[1].bytes.supplied,
    new TextEncoder().encode(JSON.stringify(operation.submission.facts)).byteLength,
  );
  assert.equal(attempts[1].bytes.observedTransport, null);
  assert.equal(success(await client.tasks.list({}).next()).data.items.length, 1);
  for (const event of events) {
    assert.equal(event.release, '0.6.0');
    assert.equal(event.mode, 'http');
    assert.match(event.timestamp, /^\d{4}-\d\d-\d\dT.*Z$/);
    assert.match(event.instanceId, /^[0-9a-f-]{36}$/);
    if (event.kind === 'request') assert.ok(event.elapsedMs >= 0);
  }
  assert.equal(attempts[1].datasetId, f.datasetId);
  assert.equal(attempts[1].generation, client.state.generation);
  const serialized = JSON.stringify(events);
  for (const sentinel of [
    facts.alias,
    facts.secret,
    f.apiKey,
    f.proxyUrl,
    'Authorization',
    'inputs',
    'position',
    'geometry',
  ])
    assert.equal(serialized.includes(sentinel), false, sentinel);
  assert.equal(serialized.includes('stack'), false);
});

test('diagnostic delivery follows effect evidence, and throwing observers cannot change real requests', async (t) => {
  const f = await fixture(t),
    events = [];
  let operation;
  const client = await ready(f, {
    mode: 'debug',
    observer(event) {
      if (event.kind === 'request' && event.operation === 'CreateOperator') {
        assert.equal(operation.outcome.kind, 'accepted');
        events.push(event);
      }
      throw new Error('SENTINEL-SECRET /absolute/host/file');
    },
  });
  operation = client.operators.create({ operator_id: uuid(), request_id: uuid(), name: 'Pilot' });
  const result = await operation.send();
  assert.equal(result.outcome.kind, 'accepted');
  const operator = success(result.attempt).data;
  assert.equal(
    success(await client.operators.get({ operator_id: operator.operator_id })).data.name,
    'Pilot',
  );
  await delay(20);
  assert.equal(events.length, 1);
  assert.equal(events[0].operationOutcome, 'accepted');
  assert.equal(client.state.kind, 'ready');
});

test('Debug failures retain Core identities and safe unavailable frames, without error details', async (t) => {
  const f = await fixture(t),
    events = [];
  const client = await ready(f, { mode: 'debug', observer: (event) => events.push(event) });
  const missing = await client.tasks.get({ task_id: uuid() });
  assert.equal(missing.response.kind, 'error');
  f.once('/readiness', ({ outgoing }) => outgoing.destroy(new Error('SENTINEL-EXCEPTION')));
  assert.equal((await client.readiness({})).kind, 'failed');
  await delay(20);
  const denied = requests(events, 'GetTask')[0];
  assert.equal(denied.requestId, missing.context.requestId);
  assert.equal(denied.code, missing.response.body.error.code);
  assert.equal(denied.source, 'http');
  assert.deepEqual(denied.frames, [{ kind: 'unavailable' }]);
  assert.deepEqual(requests(events, 'GetReadiness')[0].frames, [{ kind: 'unavailable' }]);
  assert.equal(JSON.stringify(events).includes('SENTINEL'), false);
  for (const event of events) {
    assert.equal('message' in event, false);
    assert.equal('headers' in event, false);
    assert.equal('body' in event, false);
    assert.equal('stack' in event, false);
  }
});

test('cancelled waits record uncertainty and matching late success records its later resolution', async (t) => {
  const f = await fixture(t),
    events = [];
  const client = await ready(f, { mode: 'summary', observer: (event) => events.push(event) });
  const asset = success((await client.assets.register(registration()).send()).attempt).data.asset;
  const operation = client.tasks.create(task(asset.id));
  const captured = barrier(),
    release = barrier();
  f.once('/messages/create_task', async ({ forward }) => {
    captured.resolve();
    await release.promise;
    forward();
  });
  const running = operation.start(),
    cancel = new AbortController();
  const caller = running.wait(cancel.signal);
  await captured.promise;
  cancel.abort();
  assert.equal((await caller).kind, 'cancelled');
  assert.equal(operation.outcome.kind, 'unknown_outcome');
  await delay(20);
  const waiting = requests(events, 'CreateTask')[0];
  assert.equal(waiting.phase, 'wait');
  assert.equal(waiting.operationOutcome, 'unknown_outcome');
  release.resolve();
  success(await running.settled);
  await delay(20);
  const completed = requests(events, 'CreateTask').find((event) => event.phase === 'attempt');
  assert.equal(completed.operationOutcome, 'accepted');
  assert.equal(completed.resolution, true);
  assert.equal(completed.attemptId, waiting.attemptId);
});

test('disabled diagnostics and close produce no observer deliveries', async (t) => {
  const f = await fixture(t);
  let disabled = 0;
  const client = await ready(f, {
    mode: 'disabled',
    observer() {
      disabled++;
    },
  });
  success(await client.readiness({}));
  await delay(20);
  assert.equal(disabled, 0);
  const events = [];
  const enabled = await ready(f, { mode: 'debug', observer: (event) => events.push(event) });
  await delay(20);
  events.length = 0;
  success(await enabled.readiness({}));
  await enabled.close();
  await delay(20);
  assert.deepEqual(events, []);
  assert.equal(enabled.state.kind, 'closed');
  assert.throws(() => f.client({ diagnostics: { mode: 'summary' } }), { code: 'invalid_options' });
});

test('Summary reports real read and report aggregates once after 30 seconds, then stays idle', async (t) => {
  const f = await fixture(t),
    events = [];
  const client = await ready(f, { mode: 'summary', observer: (event) => events.push(event) });
  const created = success(
    (
      await client.observations
        .create({
          request_id: uuid(),
          observation_id: uuid(),
          publisher_id: uuid(),
          source_asset_id: await sourceAsset(client.http),
        })
        .send()
    ).attempt,
  ).data;
  const observation = created.observation;
  const report = client.observations.report({
    observation_id: observation.id,
    publisher_id: observation.publisher_id,
    report: {
      report_id: uuid(),
      dataset_id: f.datasetId,
      entity_id: observation.id,
      origin: { kind: 'publisher', publisher_id: observation.publisher_id },
      sequence: '1',
      generated_at: new Date().toISOString(),
      mode: 'current',
      sections: {
        type: { state: 'withdrawn', classification: 'state_until_changed', observed_at: null },
      },
    },
  });
  success((await report.send()).attempt);
  success(await client.readiness({}));
  success(await client.observations.get({ observation_id: observation.id }));
  success(await client.tasks.list({}).next());
  await delay(30_100);
  assert.equal(requests(events, 'GetReadiness').length, 0);
  assert.equal(requests(events, 'GetObservation').length, 0);
  assert.equal(requests(events, 'ListTasks').length, 0);
  assert.equal(requests(events, 'ReportObservation').length, 0);
  const summaries = events.filter((event) => event.kind === 'summary');
  assert.equal(summaries.length, 1);
  const summary = summaries[0];
  for (const name of [
    'GetHealth',
    'GetReadiness',
    'GetObservation',
    'ListTasks',
    'ReportObservation',
  ]) {
    const counter = summary.operations.find((entry) => entry.operation === name);
    assert.equal(counter.attempts, 1, name);
    assert.equal(counter.successes, 1, name);
    assert.equal(counter.sources.http, 1, name);
    assert.equal(
      counter.durationBuckets.reduce((sum, value) => sum + value, 0),
      1,
      name,
    );
    assert.ok(counter.receivedBytes > 0, name);
    assert.equal(counter.observedTransportBytes, null, name);
    assert.equal(counter.unavailableTransportSamples, 1, name);
  }
  assert.equal(summary.omitted, 0);
  const count = events.length;
  await delay(50);
  assert.equal(events.length, count);
});

test('credential-provider exceptions cannot smuggle arbitrary error-code strings into diagnostics', async (t) => {
  const f = await fixture(t),
    events = [];
  const client = f.client({
    credentials: () => {
      throw new SdkError('SENTINEL-SECRET-CODE');
    },
    diagnostics: { mode: 'debug', observer: (event) => events.push(event) },
  });
  assert.equal((await client.connect()).code, 'network');
  await delay(20);
  assert.equal(f.traffic.length, 0);
  assert.equal(JSON.stringify(events).includes('SENTINEL'), false);
  assert.equal(requests(events, 'GetHealth')[0].code, 'network');
});
