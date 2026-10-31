import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Position, Telemetry, Counter, inputSections, exchanges } from '@atlas/protocol';
const { component, commandCatalog } = await import(
  process.env.ATLAS_SDK_ENTRY ?? '../dist/index.js'
);
import { fixture, uuid, registration, barrier } from './harness.mjs';
import { publicClient, success, sent, reading, telemetry } from './public-helpers.mjs';

test('component construction preserves exact values, null and omission and refuses hostile constructed values', () => {
  const position = { latitude: 51.50000000000001, longitude: -0.1 };
  const copy = component(Position, position);
  position.latitude = 0;
  assert.equal(copy.latitude, 51.50000000000001);
  assert.ok(Object.isFrozen(copy));
  const telem = component(Telemetry, { position: null, altitude: null, ground_speed: 0 });
  assert.equal(telem.position, null);
  assert.equal(Object.hasOwn(telem, 'airspeed'), false);
  assert.throws(() => component(Telemetry, { ...telem, airspeed: undefined }));
  assert.equal(component(Counter, Counter.parse('9007199254740993')), '9007199254740993');
  let called = false;
  assert.throws(() =>
    component(Position, {
      get latitude() {
        called = true;
        return 1;
      },
      longitude: 0,
    }),
  );
  assert.equal(called, false);
  assert.throws(() => component(Position, { latitude: 91, longitude: 0 }));
  assert.throws(() => component(Position, copy, { maxBytes: 1 }));
  assert.deepEqual(Object.keys(commandCatalog), ['move_to', 'pause', 'resume']);
  assert.equal(
    component(commandCatalog.pause, { command: 'pause', scheduling: 'immediate', inputs: {} })
      .command,
    'pause',
  );
  assert.throws(() =>
    component(commandCatalog.move_to, { command: 'move_to', scheduling: 'immediate', inputs: {} }),
  );
  assert.throws(() =>
    component(commandCatalog.resume, { command: 'resume', scheduling: 'immediate', inputs: {} }),
  );
});

test('report helpers retain one Observation, report, reading and Core Track across lost replies and deliberate retries', async (t) => {
  const f = await fixture(t);
  const { reporting, http } = await publicClient(t, f);
  const input = {
    observation_id: uuid(),
    request_id: uuid(),
    publisher_id: uuid(),
    alias: 'Remote detection',
  };
  const { creation, reporter } = reporting.createObservation(input);
  f.once('/messages/create_observation', ({ outgoing }) => outgoing.destroy());
  assert.equal((await creation.send()).outcome.kind, 'unknown_outcome');
  const created = sent(await creation.send());
  assert.equal(created.observation.id, input.observation_id);
  assert.equal(created.track.id, created.observation.track_id);
  const origin = { kind: 'publisher', publisher_id: input.publisher_id };
  const first = reading(1, { telemetry: telemetry(origin, 51, '2026-10-21T12:00:01.0000001Z') });
  const frozen = structuredClone(first);
  const operation = reporter.report(first);
  first.sections.telemetry.value.position.latitude = 0;
  let originalRequest;
  f.once('/messages/report_observation', ({ request, outgoing }) => {
    originalRequest = request;
    outgoing.destroy();
  });
  assert.equal((await operation.send()).outcome.kind, 'unknown_outcome');
  assert.equal(success(await reporter.reconcile()).telemetry.value.position.latitude, 51);
  assert.equal(operation.outcome.kind, 'unknown_outcome');
  const same = http.observations.report(operation.submission.facts);
  assert.equal(same.outcome.kind, 'unknown_outcome');
  const reported = sent(await same.send());
  assert.equal(reported.evidence_disposition, 'duplicate');
  assert.equal(reported.track.id, created.track.id);
  assert.equal(operation.outcome.kind, 'accepted');
  assert.equal(reported.observation.telemetry.value.position.latitude, 51);
  assert.equal(reported.observation.telemetry.evidence.report_id, frozen.report_id);
  assert.equal(operation.submission.facts.report.generated_at, frozen.generated_at);
  assert.equal(
    operation.submission.facts.report.sections.telemetry.observed_at,
    '2026-10-21T12:00:01.0000001Z',
  );
  assert.deepEqual(JSON.parse(originalRequest).report.sections, frozen.sections);
  assert.throws(() => reporter.report({ ...frozen, generated_at: null }), {
    code: 'identity_conflict',
  });
  const conflicting = structuredClone(frozen);
  conflicting.report_id = uuid();
  conflicting.sequence = '2';
  conflicting.sections.telemetry.value.position.latitude = 52;
  const refusal = await reporter.report(conflicting).send();
  assert.equal(refusal.attempt.response.body.error.code, 'constituent_conflict');
  const actual = success(await reporter.reconcile());
  assert.equal(actual.id, input.observation_id);
  assert.equal(actual.telemetry.value.position.latitude, 51);
  const track = success(await reporter.recordedTrack());
  assert.equal(track.id, created.track.id);
  const observations = http.observations.list({ page_size: 10 });
  assert.equal(success(await observations.next()).items.length, 1);
  const tracks = http.tracks.list({ page_size: 10 });
  assert.equal(success(await tracks.next()).items.length, 1);
});

test('stale reporting reads return Dataset refusals before and after Reset discovery', async (t) => {
  const f = await fixture(t);
  const { client, reporting, http } = await publicClient(t, f);
  const input = { observation_id: uuid(), publisher_id: uuid(), request_id: uuid() };
  const { creation, reporter } = reporting.createObservation(input);
  const created = sent(await creation.send());
  assert.equal(success(await reporter.reconcile()).id, input.observation_id);
  assert.equal(success(await reporter.recordedTrack()).id, created.track.id);
  const originalDataset = client.state.datasetId;
  await f.reset();
  assert.equal((await client.readiness({})).response.body.error.code, 'dataset_mismatch');
  assert.equal(client.state.datasetId, originalDataset);
  for (const reconnected of [false, true]) {
    if (reconnected) {
      success(await client.connect());
      assert.notEqual(client.state.datasetId, originalDataset);
    }
    const count = f.traffic.length;
    for (const result of [await reporter.reconcile(), await reporter.recordedTrack()]) {
      assert.equal(result.kind, 'not_sent');
      assert.equal(result.code, 'dataset_invalidated');
    }
    assert.throws(() => reporter.report(reading(1, {})), { code: 'dataset_invalidated' });
    assert.equal(f.traffic.length, count);
  }
  const current = await http.observations.get({ observation_id: input.observation_id });
  assert.equal(current.kind, 'response');
  assert.equal(current.response.status, 404);
});

test('Asset helper preserves registration identity, revision conditions, omitted fields and explicit clears', async (t) => {
  const f = await fixture(t);
  const { reporting, http } = await publicClient(t, f);
  const input = registration('Camera');
  input.description = { name: 'Camera A' };
  const { registration: operation, reporter } = reporting.register(input);
  f.once('/messages/register_asset', ({ outgoing }) => outgoing.destroy());
  assert.equal((await operation.send()).outcome.kind, 'unknown_outcome');
  let asset = sent(await operation.send()).asset;
  assert.equal(asset.id, input.asset_id);
  const originalRevision = asset.edit_revision;
  const clear = reporter.update({
    request_id: uuid(),
    expected_edit_revision: originalRevision,
    alias: null,
  });
  input.alias = 'Mutated';
  asset = sent(await clear.send()).asset;
  assert.equal(Object.hasOwn(asset, 'alias'), false);
  assert.equal(asset.description.name, 'Camera A');
  const failed = await reporter
    .update({ request_id: uuid(), expected_edit_revision: originalRevision, description: null })
    .send();
  assert.equal(failed.attempt.response.kind, 'error');
  assert.equal(success(await http.assets.get({ asset_id: asset.id })).description.name, 'Camera A');
  assert.throws(() => reporter.update({ request_id: uuid(), alias: 'No precondition' }));
  let invoked = false;
  assert.throws(() =>
    reporter.update({
      request_id: uuid(),
      get alias() {
        invoked = true;
        return null;
      },
    }),
  );
  assert.equal(invoked, false);
  const status = component(inputSections.status, {
    state: 'value',
    classification: 'state_until_changed',
    observed_at: null,
    value: { condition: 'healthy' },
  });
  const report = reporter.update({ request_id: uuid() }, reading(1, { status }));
  assert.equal(sent(await report.send()).asset.status.value.condition, 'healthy');
  const removed = reporter.update({
    request_id: uuid(),
    expected_edit_revision: asset.edit_revision,
    description: null,
  });
  assert.equal(Object.hasOwn(sent(await removed.send()).asset, 'description'), false);
});

test('report wait cancellation retains the bounded attempt and late shared evidence', async (t) => {
  const f = await fixture(t);
  const { reporting } = await publicClient(t, f);
  const { reporter, creation } = reporting.createObservation({
    observation_id: uuid(),
    request_id: uuid(),
    publisher_id: uuid(),
  });
  sent(await creation.send());
  const operation = reporter.report(
    reading(1, {
      type: {
        state: 'value',
        classification: 'state_until_changed',
        observed_at: null,
        value: { kind: 'person' },
      },
    }),
  );
  const captured = barrier(),
    forwardReply = barrier();
  f.once('/messages/report_observation', async ({ forward }) => {
    captured.resolve();
    await forwardReply.promise;
    forward();
  });
  const attempt = operation.start();
  await captured.promise;
  const controller = new AbortController();
  const wait = attempt.wait(controller.signal);
  controller.abort();
  assert.equal((await wait).kind, 'cancelled');
  assert.equal(operation.outcome.kind, 'unknown_outcome');
  forwardReply.resolve();
  success(await attempt.settled);
  assert.equal(operation.outcome.kind, 'accepted');
});

test('report sections preserve omission and withdrawals and source queries retain recorded Asset attribution', async (t) => {
  const f = await fixture(t);
  const { reporting, http } = await publicClient(t, f);
  const source = registration();
  sent(await http.assets.register(source).send());
  const publisher_id = uuid(),
    observation_id = uuid();
  const { creation, reporter } = reporting.createObservation({
    request_id: uuid(),
    observation_id,
    publisher_id,
    source_asset_id: source.asset_id,
  });
  const pair = sent(await creation.send());
  const origin = { kind: 'publisher', publisher_id };
  const measurement = reading(1, {
    telemetry: telemetry(origin, 17, '2026-10-21T12:00:01Z'),
    type: {
      state: 'value',
      classification: 'state_until_changed',
      observed_at: null,
      value: { kind: 'person' },
    },
  });
  sent(await reporter.report(measurement).send());
  sent(
    await reporter
      .report(
        reading(2, {
          type: { state: 'withdrawn', classification: 'state_until_changed', observed_at: null },
        }),
      )
      .send(),
  );
  const result = success(await reporter.reconcile());
  assert.equal(result.type.state, 'withdrawn');
  assert.equal(result.telemetry.value.position.latitude, 17);
  assert.equal(result.telemetry.evidence.report_id, measurement.report_id);
  const track = success(await reporter.recordedTrack());
  assert.equal(track.type.state, 'withdrawn');
  assert.equal(track.telemetry.value.position.latitude, 17);
  sent(await http.assets.delete({ asset_id: source.asset_id, request_id: uuid() }).send());
  const filtered = success(
    await http.observations
      .list({ filters: { source_asset_ids: [source.asset_id], publisher_ids: [publisher_id] } })
      .next(),
  );
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.items[0].id, observation_id);
  const sources = success(
    await http.tracks
      .observations({ track_id: pair.track.id, source_asset_ids: [source.asset_id] })
      .next(),
  );
  assert.equal(sources.items.length, 1);
  assert.equal(sources.items[0].source_asset_id, source.asset_id);
  const empty = success(
    await http.observations.list({ filters: { source_asset_ids: [uuid()] } }).next(),
  );
  assert.equal(empty.items.length, 0);
  const history = http.observations.history({ entity_id: observation_id, query_id: uuid() });
  const page = success(await history.next());
  assert.equal(page.readings.length, 1);
  assert.equal(page.readings[0].observed_at, '2026-10-21T12:00:01Z');
  assert.deepEqual(page.readings[0].track_ids, [pair.track.id]);
  success(await history.close());
});

for (const [budget, limits] of [
  ['operation count', { preparedOperations: 1 }],
  ['prepared bytes', { preparedOperations: 64, preparedBytes: 16384 }],
])
  test(`explicit operation close reclaims ${budget} without automatic evidence eviction`, async (t) => {
    const f = await fixture(t);
    const { reporting, http } = await publicClient(t, f, { limits });
    const publisher_id = uuid(),
      observation_id = uuid();
    const { creation, reporter } = reporting.createObservation({
      request_id: uuid(),
      publisher_id,
      observation_id,
    });
    sent(await creation.send());
    creation.close();
    const origin = { kind: 'publisher', publisher_id };
    for (let sequence = 1; sequence <= 16; sequence++) {
      const facts = reading(sequence, {
        telemetry: telemetry(
          origin,
          sequence,
          new Date(Date.UTC(2026, 9, 21, 12) + sequence * 1000).toISOString(),
        ),
      });
      const operation = reporter.report(facts);
      sent(await operation.send());
      const accepted = operation.outcome;
      assert.throws(
        () => reporter.report({ ...facts, report_id: uuid(), sequence: String(sequence + 1) }),
        { code: 'capacity' },
      );
      operation.close();
      operation.close();
      const traffic = f.traffic.length;
      assert.equal((await operation.start().settled).code, 'closed');
      assert.equal((await operation.send()).attempt.code, 'closed');
      assert.equal(f.traffic.length, traffic);
      assert.deepEqual(operation.outcome, accepted);
    }
    assert.equal(success(await http.observations.get({ observation_id })).id, observation_id);
  });

test('Asset Tags report through the existing helper and reach HTTP, Full snapshot and live reads', async (t) => {
  const f = await fixture(t);
  const { reporting, http } = await publicClient(t, f);
  const { registration: operation, reporter } = reporting.register(registration());
  const registered = sent(await operation.send()).asset;
  assert.equal(Object.hasOwn(registered, 'tags'), false);
  const tags = {
    state: 'value',
    classification: 'state_until_changed',
    observed_at: null,
    value: { presets: ['simulated'] },
  };
  for (const value of [
    { presets: ['unknown'] },
    { presets: ['simulated', 'simulated'] },
    { presets: null },
    { presets: [], extra: true },
  ]) {
    const count = f.traffic.length;
    assert.throws(
      () => reporter.update({ request_id: uuid() }, reading(1, { tags: { ...tags, value } })),
      { code: 'invalid_value' },
    );
    assert.equal(f.traffic.length, count);
  }
  const update = reporter.update({ request_id: uuid() }, reading(1, { tags }));
  const accepted = sent(await update.send()).asset;
  assert.equal(accepted.edit_revision, registered.edit_revision);
  assert.deepEqual(success(await http.assets.get({ asset_id: registered.id })).tags.value.presets, [
    'simulated',
  ]);
  const { client: full } = await publicClient(t, f, { mode: 'full' });
  async function waitFor(predicate) {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, 'Tags did not reach the Full picture');
      await delay(10);
    }
  }
  await waitFor(() => full.picture.status.kind === 'synchronized');
  const snapshot = full.assets.get({ asset_id: registered.id });
  assert.equal(snapshot.kind, 'available');
  assert.deepEqual(snapshot.value.tags, accepted.tags);
  const clear = reporter.update(
    { request_id: uuid() },
    reading(2, { tags: { ...tags, value: { presets: [] } } }),
  );
  const cleared = sent(await clear.send()).asset;
  await waitFor(() => {
    const local = full.assets.get({ asset_id: registered.id });
    return local.kind === 'available' && local.value.version === cleared.version;
  });
  const count = f.traffic.length;
  assert.deepEqual(full.assets.get({ asset_id: registered.id }).value.tags.value.presets, []);
  assert.equal(f.traffic.length, count, 'Full reads remain local');
  assert.deepEqual(success(await http.assets.get({ asset_id: registered.id })).tags, cleared.tags);
  for (const corrupt of [
    (value) => {
      value.value.presets = ['unknown'];
    },
    (value) => {
      value.time_status = {};
    },
    (value) => {
      value.evidence.entity_id = uuid();
    },
  ]) {
    f.once('/messages/get_asset', ({ body, forward }) => {
      const response = JSON.parse(body);
      corrupt(response.data.tags);
      forward(Buffer.from(JSON.stringify(response)));
    });
    const invalid = await http.assets.get({ asset_id: registered.id });
    assert.equal(invalid.kind, 'failed');
    assert.equal(invalid.code, 'invalid_value');
  }
});
