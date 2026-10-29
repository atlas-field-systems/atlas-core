import test from 'node:test';
import assert from 'node:assert/strict';
import { exchanges } from '@atlas/protocol';
import { fixture, uuid, registration, task, barrier } from './harness.mjs';
import { owners, success, sent, reading, telemetry } from './remote-helpers.mjs';

test('closing unallocated history and contact handles releases their capacity without HTTP', async (t) => {
  const f = await fixture(t);
  const { remote, http } = await owners(t, f, {}, { handles: 1 });
  const asset = registration();
  sent(await http.assets.register(asset).send());
  const before = f.traffic.length;
  for (let i = 0; i < 3; i++) {
    const view = remote.history.asset({ entity_id: asset.asset_id, query_id: uuid() });
    assert.equal((await view.next({ signal: AbortSignal.abort() })).code, 'cancelled');
    assert.deepEqual(await view.close(), { kind: 'abandoned', evidence: 'unallocated' });
    const contact = remote.contact({
      asset_id: asset.asset_id,
      process_generation: asset.process_generation,
      mode: 'current',
      request_id: uuid(),
    });
    assert.deepEqual(await contact.close(), { kind: 'abandoned', evidence: 'unallocated' });
  }
  assert.equal(f.traffic.length, before);
});

test('a health context acquired during close creates no remote allocation or retained handle', async (t) => {
  const f = await fixture(t);
  const { remote, http } = await owners(t, f, {}, { handles: 1 });
  const asset = registration();
  sent(await http.assets.register(asset).send());
  const view = remote.history.asset({ entity_id: asset.asset_id, query_id: uuid() });
  const captured = barrier(),
    release = barrier();
  f.once('/health', async ({ forward }) => {
    captured.resolve();
    await release.promise;
    forward();
  });
  const pending = view.next();
  await captured.promise;
  const closing = view.close();
  release.resolve();
  assert.equal((await pending).code, 'closed');
  assert.deepEqual(await closing, { kind: 'abandoned', evidence: 'unallocated' });
  assert.equal(
    f.traffic.filter((entry) => entry.path === '/messages/get_asset_movement_history').length,
    0,
  );
  const replacement = remote.history.asset({ entity_id: asset.asset_id, query_id: uuid() });
  assert.deepEqual(await replacement.close(), { kind: 'abandoned', evidence: 'unallocated' });
});

async function observation(t, f) {
  const owned = await owners(t, f);
  const publisher_id = uuid(),
    observation_id = uuid();
  const { reporter, creation } = owned.reporting.createObservation({
    request_id: uuid(),
    publisher_id,
    observation_id,
  });
  const pair = sent(await creation.send());
  const origin = { kind: 'publisher', publisher_id };
  const report = async (sequence, latitude, at) =>
    sent(
      await reporter
        .report(reading(sequence, { telemetry: telemetry(origin, latitude, at) }))
        .send(),
    );
  await report(1, 1, '2026-10-21T12:00:01Z');
  await report(3, 3, '2026-10-21T12:00:03Z');
  return { ...owned, reporter, report, pair, observation_id, publisher_id };
}

test('HTTP history freezes pages and repeats exact allocation after a lost reply, while a fresh query sees later readings', async (t) => {
  const f = await fixture(t);
  const { remote, report, observation_id, pair, http } = await observation(t, f);
  const selection = {
    entity_id: observation_id,
    query_id: uuid(),
    page_size: 1,
    time_groups: ['known'],
  };
  const view = remote.history.observation(selection);
  selection.time_groups.length = 0;
  let allocated, original;
  f.once('/messages/get_observation_movement_history', ({ request, body, outgoing }) => {
    original = request;
    allocated = JSON.parse(body).data;
    outgoing.destroy();
  });
  assert.equal((await view.next()).kind, 'failed');
  assert.equal(view.releaseEvidence, 'unacknowledged');
  const context = view.allocation;
  let retried;
  f.once('/messages/get_observation_movement_history', ({ request, forward }) => {
    retried = request;
    forward();
  });
  const first = success(await view.next());
  assert.deepEqual(retried, original);
  assert.equal(first.view_id, allocated.view_id);
  assert.equal(first.expires_at, allocated.expires_at);
  assert.deepEqual(view.allocation, context);
  assert.equal(first.readings[0].value.latitude, 1);
  await report(2, 2, '2026-10-21T12:00:02Z');
  const second = success(await view.next());
  assert.equal(second.readings[0].value.latitude, 3);
  assert.equal(second.view_id, first.view_id);
  assert.equal(second.baseline_cursor, first.baseline_cursor);
  assert.equal(second.next_page_token, null);
  assert.deepEqual(await view.next(), { kind: 'end' });
  success(await view.release());
  success(await view.release());
  assert.equal(view.releaseEvidence, 'acknowledged');
  const fresh = remote.history.track({ entity_id: pair.track.id, query_id: uuid(), page_size: 1 });
  const values = [];
  for (;;) {
    const page = await fresh.next();
    if (page.kind === 'end') break;
    values.push(...success(page).readings.map((row) => row.value.latitude));
  }
  assert.deepEqual(values, [1, 2, 3]);
  success(await fresh.close());
  const sources = success(
    await http.tracks
      .observations({ track_id: pair.track.id, publisher_ids: [pair.observation.publisher_id] })
      .next(),
  );
  assert.equal(sources.items[0].id, observation_id);
  await remote.close();
});

test('history refuses switched page context without advancing or retaining the foreign view', async (t) => {
  const f = await fixture(t);
  const { remote, observation_id } = await observation(t, f);
  const view = remote.history.observation({
    entity_id: observation_id,
    query_id: uuid(),
    page_size: 1,
  });
  const first = success(await view.next());
  f.once('/messages/get_observation_movement_history', ({ body, forward }) => {
    const changed = JSON.parse(body);
    changed.data.view_id = uuid();
    forward(Buffer.from(JSON.stringify(changed)));
  });
  assert.equal((await view.next()).code, 'invalid_http');
  assert.equal(view.context.view_id, first.view_id);
  assert.equal(success(await view.next()).readings[0].value.latitude, 3);
  success(await view.close());
});

test('history holds admission after caller cancellation, retries its exact view and closes after release', async (t) => {
  const f = await fixture(t);
  const { remote, observation_id } = await observation(t, f);
  const view = remote.history.observation({
    entity_id: observation_id,
    query_id: uuid(),
    page_size: 1,
  });
  const captured = barrier(),
    deliver = barrier();
  f.once('/messages/get_observation_movement_history', async ({ forward }) => {
    captured.resolve();
    await deliver.promise;
    forward();
  });
  const controller = new AbortController();
  const waiting = view.next({ signal: controller.signal });
  await captured.promise;
  controller.abort();
  assert.equal((await waiting).kind, 'cancelled');
  assert.equal((await view.next()).code, 'capacity');
  deliver.resolve();
  // close waits the original bounded attempt and uses its late release token.
  success(await view.close());
  assert.equal(view.releaseEvidence, 'acknowledged');
  assert.equal((await view.next()).code, 'closed');
});

test('lost release remains unacknowledged, exact release retry resolves it, and Reset and same-Dataset restart fence owners', async (t) => {
  const f = await fixture(t);
  const { remote, session, observation_id } = await observation(t, f);
  const view = remote.history.observation({
    entity_id: observation_id,
    query_id: uuid(),
    page_size: 1,
  });
  success(await view.next());
  let releaseRequest;
  f.once('/messages/release_history_view', ({ request, outgoing }) => {
    releaseRequest = request;
    outgoing.destroy();
  });
  assert.equal((await view.release()).kind, 'failed');
  assert.equal(view.releaseEvidence, 'unacknowledged');
  f.once('/messages/release_history_view', ({ request, forward }) => {
    assert.deepEqual(request, releaseRequest);
    forward();
  });
  success(await view.release());
  const old = remote.history.observation({
    entity_id: observation_id,
    query_id: uuid(),
    page_size: 1,
  });
  success(await old.next());
  await f.restart();
  success(await session.refreshHealth());
  const before = f.traffic.length;
  assert.equal((await old.next()).code, 'superseded');
  assert.equal(old.releaseEvidence, 'owner-ended');
  assert.equal(f.traffic.length, before);
  const reset = remote.history.observation({
    entity_id: observation_id,
    query_id: uuid(),
    page_size: 1,
  });
  success(await reset.next());
  await f.reset();
  success(await session.refreshHealth());
  assert.equal((await reset.next()).code, 'dataset_invalidated');
});

test('authorization pause sends no history continuation or release and keeps lost allocations bounded', async (t) => {
  const f = await fixture(t);
  let credential = f.apiKey;
  const { session, remote, http } = await owners(
    t,
    f,
    { credentials: () => credential },
    { handles: 1 },
  );
  const asset = registration();
  sent(await http.assets.register(asset).send());
  const query = { entity_id: asset.asset_id, query_id: uuid(), page_size: 1 };
  const view = remote.history.asset(query);
  f.once('/messages/get_asset_movement_history', ({ outgoing }) => outgoing.destroy());
  assert.equal((await view.next()).kind, 'failed');
  assert.throws(() => remote.history.asset({ ...query, query_id: uuid() }), { code: 'capacity' });
  const revoked = await http.apiKeys.revoke({ api_key_id: f.apiKeyId, request_id: uuid() }).send();
  assert.equal(revoked.attempt.response.body.error.code, 'unauthorized');
  await http.assets.get({ asset_id: asset.asset_id });
  const before = f.traffic.length;
  assert.equal((await view.next()).code, 'authorization_required');
  assert.equal((await view.release()).code, 'authorization_required');
  const closed = await view.close();
  assert.equal(closed.kind, 'abandoned');
  assert.equal(closed.evidence, 'unacknowledged');
  assert.equal(f.traffic.length, before);
  assert.throws(() => remote.history.asset({ ...query, query_id: uuid() }), { code: 'capacity' });
  await remote.close();
  await session.close();
});

test('assigned instructions retain process, read and Core run across actual endpoint pages', async (t) => {
  const f = await fixture(t);
  const { remote, http, session } = await owners(t, f);
  const asset = registration();
  sent(await http.assets.register(asset).send());
  const tasks = [task(asset.asset_id), task(asset.asset_id)];
  for (const input of tasks) sent(await http.tasks.create(input).send());
  const assigned = remote.assigned({
    asset_id: asset.asset_id,
    process_generation: asset.process_generation,
    read_id: uuid(),
    page_size: 1,
  });
  const first = success(await assigned.next());
  assert.equal(first.tasks.length, 1);
  assert.equal(first.process_generation, asset.process_generation);
  const second = success(await assigned.next());
  assert.equal(second.read_id, first.read_id);
  assert.equal(second.core_run_id, first.core_run_id);
  assert.equal(second.captured_at, first.captured_at);
  assert.equal(second.instructions_valid_until, first.instructions_valid_until);
  assert.deepEqual(
    new Set([...first.tasks, ...second.tasks].map((task) => task.task_id)),
    new Set(tasks.map((task) => task.task_id)),
  );
  assert.deepEqual(await assigned.next(), { kind: 'end' });
  const stale = remote.assigned({
    asset_id: asset.asset_id,
    process_generation: asset.process_generation,
    read_id: uuid(),
  });
  success(await stale.next());
  await f.restart();
  success(await session.refreshHealth());
  assert.equal((await stale.next()).code, 'superseded');
});

test('contact retries the original challenge, proves current contact, and replacement changes only the requested process', async (t) => {
  const f = await fixture(t);
  const { remote, reporting, http } = await owners(t, f);
  const asset = registration();
  sent(await http.assets.register(asset).send());
  const contact = remote.contact({
    asset_id: asset.asset_id,
    process_generation: asset.process_generation,
    mode: 'current',
    request_id: uuid(),
  });
  let issued, original;
  f.once('/messages/begin_asset_contact', ({ request, body, outgoing }) => {
    original = request;
    issued = JSON.parse(body).data;
    outgoing.destroy();
  });
  assert.equal((await contact.read()).kind, 'failed');
  f.once('/messages/begin_asset_contact', ({ request, forward }) => {
    assert.deepEqual(request, original);
    forward();
  });
  const challenge = success(await contact.read());
  assert.equal(challenge.challenge_id, issued.challenge_id);
  assert.equal(challenge.expires_at, issued.expires_at);
  const reporter = reporting.asset({
    id: asset.asset_id,
    process_generation: asset.process_generation,
  });
  const facts = reporter.update(
    { request_id: uuid() },
    reading(
      1,
      {},
      {
        generated_at: challenge.issued_at,
        contact_proof: { challenge_id: challenge.challenge_id },
      },
    ),
  ).submission.facts;
  const checkedIn = contact.checkIn(facts);
  const current = sent(await checkedIn.send()).asset;
  assert.notEqual(current.heartbeat.last_contact_at, null);
  assert.equal(current.communications.health, 'healthy');
  await contact.close();
  const generation = uuid();
  const replacement = remote.contact({
    request_id: uuid(),
    asset_id: asset.asset_id,
    process_generation: generation,
    expected_process_generation: asset.process_generation,
    mode: 'replace',
  });
  const replacementChallenge = success(await replacement.read());
  const first_report = {
    dataset_id: facts.report.dataset_id,
    entity_id: asset.asset_id,
    origin: { kind: 'asset_process', process_generation: generation },
    ...reading(
      1,
      {},
      {
        generated_at: replacementChallenge.issued_at,
        contact_proof: { challenge_id: replacementChallenge.challenge_id },
      },
    ),
  };
  const change = replacement.replace({
    request_id: uuid(),
    asset_id: asset.asset_id,
    expected_process_generation: asset.process_generation,
    process_generation: generation,
    challenge_id: replacementChallenge.challenge_id,
    first_report,
  });
  f.once('/messages/replace_asset_process', ({ outgoing }) => outgoing.destroy());
  assert.equal((await change.send()).outcome.kind, 'unknown_outcome');
  assert.equal(sent(await change.send()).asset.process_generation, generation);
  assert.equal(replacement.releaseEvidence, 'acknowledged');
  assert.equal(
    success(await http.assets.get({ asset_id: asset.asset_id })).process_generation,
    generation,
  );
  const obsolete = reporter.update(
    { request_id: uuid() },
    reading(2, {
      status: {
        state: 'value',
        classification: 'state_until_changed',
        observed_at: null,
        value: { condition: 'healthy' },
      },
    }),
  );
  assert.equal((await obsolete.send()).attempt.response.body.error.code, 'generation_mismatch');
});

test(
  'original sixty-second barriers bound lost allocation and release, then permit explicit replacement',
  { timeout: 75000 },
  async (t) => {
    const f = await fixture(t);
    const { remote, http, session } = await owners(t, f, {}, { handles: 2 });
    const asset = registration();
    sent(await http.assets.register(asset).send());
    const lost = remote.history.asset({ entity_id: asset.asset_id, query_id: uuid() });
    let original;
    f.once('/messages/get_asset_movement_history', ({ request, outgoing }) => {
      original = JSON.parse(request);
      outgoing.destroy();
    });
    assert.equal((await lost.next()).kind, 'failed');
    const released = remote.history.asset({ entity_id: asset.asset_id, query_id: uuid() });
    success(await released.next());
    f.once('/messages/release_history_view', ({ outgoing }) => outgoing.destroy());
    assert.equal((await released.release()).kind, 'failed');
    assert.equal(lost.releaseEvidence, 'unacknowledged');
    assert.equal(released.releaseEvidence, 'unacknowledged');
    assert.throws(() => remote.history.asset({ entity_id: asset.asset_id, query_id: uuid() }), {
      code: 'capacity',
    });
    const expiry = Math.max(lost.allocation.latestExpiry, released.allocation.latestExpiry);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, expiry - performance.now()) + 100),
    );
    const before = f.traffic.length;
    assert.equal(lost.status, 'expired');
    assert.equal(released.status, 'expired');
    assert.equal((await lost.next()).code, 'superseded');
    assert.equal(lost.releaseEvidence, 'expired');
    assert.equal(released.releaseEvidence, 'expired');
    assert.equal(f.traffic.length, before);
    const explicitRetry = await session.read(exchanges.GetAssetMovementHistory)(original);
    assert.equal(explicitRetry.response.body.error.code, 'allocation_expired');
    const replacement = remote.history.asset({ entity_id: asset.asset_id, query_id: uuid() });
    success(await replacement.next());
    success(await replacement.close());
    const final = await remote.close();
    assert.ok(
      final.every(
        (entry) => entry.result.kind === 'abandoned' || entry.result.response?.kind === 'success',
      ),
    );
  },
);

test('allocation context refusal keeps exact original facts and never silently obtains a replacement', async (t) => {
  const f = await fixture(t);
  const { remote, http } = await owners(t, f);
  const asset = registration();
  sent(await http.assets.register(asset).send());
  const view = remote.history.asset({ entity_id: asset.asset_id, query_id: uuid() });
  f.once('/health', ({ body, forward }) => {
    const changed = JSON.parse(body);
    changed.data.allocation_context = 'not-a-core-context';
    forward(Buffer.from(JSON.stringify(changed)));
  });
  assert.equal((await view.next()).response.body.error.code, 'allocation_expired');
  const context = view.allocation;
  const before = f.traffic.filter((entry) => entry.path === '/health').length;
  assert.equal((await view.next()).code, 'superseded');
  assert.deepEqual(view.allocation, context);
  assert.equal(f.traffic.filter((entry) => entry.path === '/health').length, before);
  assert.equal((await view.close()).evidence, 'owner-ended');
});

test('remote close waits owned attempts to their deadlines and reports unacknowledged release failure', async (t) => {
  const f = await fixture(t);
  const { remote, http } = await owners(t, f, { timeoutMs: 500 });
  const asset = registration();
  sent(await http.assets.register(asset).send());
  const view = remote.history.asset({ entity_id: asset.asset_id, query_id: uuid() });
  success(await view.next());
  const reached = barrier(),
    finish = barrier();
  f.once('/messages/release_history_view', async ({ forward }) => {
    reached.resolve();
    await finish.promise;
    forward();
  });
  const closing = remote.close();
  await reached.promise;
  let closed = false;
  void closing.then(() => {
    closed = true;
  });
  await new Promise(setImmediate);
  assert.equal(closed, false);
  const results = await closing;
  assert.equal(results.length, 1);
  assert.equal(results[0].result.kind, 'failed');
  assert.equal(results[0].result.code, 'deadline');
  assert.equal(view.releaseEvidence, 'unacknowledged');
  finish.resolve();
});

test('remote handle and byte capacity is checked before allocation and returned contexts are also bounded', async (t) => {
  const f = await fixture(t);
  const { remote, http } = await owners(t, f, {}, { handles: 1, retainedBytes: 64000 });
  const asset = registration();
  sent(await http.assets.register(asset).send());
  const before = f.traffic.length;
  assert.throws(() =>
    remote.history.asset({
      entity_id: asset.asset_id,
      query_id: uuid(),
      unexpected: 'x'.repeat(1000000),
    }),
  );
  assert.equal(f.traffic.length, before);
  const view = remote.history.asset({ entity_id: asset.asset_id, query_id: uuid() });
  assert.throws(
    () =>
      remote.assigned({
        asset_id: asset.asset_id,
        process_generation: asset.process_generation,
        read_id: uuid(),
      }),
    { code: 'capacity' },
  );
  f.once('/messages/get_asset_movement_history', ({ body, forward }) => {
    const changed = JSON.parse(body);
    changed.data.release_token = 'x'.repeat(64000);
    forward(Buffer.from(JSON.stringify(changed)));
  });
  assert.equal((await view.next()).code, 'capacity');
  assert.equal(view.context, undefined);
  assert.equal(view.releaseEvidence, 'unacknowledged');
  assert.equal((await view.close()).evidence, 'unacknowledged');
});

test('prepared history cannot migrate to a new Core run before its first allocation', async (t) => {
  const f = await fixture(t);
  const { remote, session, http } = await owners(t, f);
  const asset = registration();
  sent(await http.assets.register(asset).send());
  const view = remote.history.asset({ entity_id: asset.asset_id, query_id: uuid() });
  await f.restart();
  const before = f.traffic.filter(
    (entry) => entry.path === '/messages/get_asset_movement_history',
  ).length;
  assert.equal((await view.next()).code, 'superseded');
  assert.equal(
    f.traffic.filter((entry) => entry.path === '/messages/get_asset_movement_history').length,
    before,
  );
  assert.equal(view.releaseEvidence, 'owner-ended');
  await session.close();
});

test('Asset movement history preserves exact source times and distinct unknown and uncertain groups', async (t) => {
  const f = await fixture(t);
  const { remote, reporting } = await owners(t, f);
  const asset = registration();
  const { registration: enrollment, reporter } = reporting.register(asset);
  sent(await enrollment.send());
  const origin = { kind: 'asset_process', process_generation: asset.process_generation };
  const times = [
    '2026-10-21T12:00:01.0000002Z',
    '2026-10-21T12:00:01.0000001Z',
    null,
    '9999-01-01T00:00:00Z',
  ];
  for (const [i, at] of times.entries())
    sent(
      await reporter
        .update(
          { request_id: uuid() },
          reading(i + 1, {
            telemetry: telemetry(
              origin,
              i + 1,
              at,
              `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
            ),
          }),
        )
        .send(),
    );
  const history = remote.history.asset({
    entity_id: asset.asset_id,
    query_id: uuid(),
    page_size: 1,
  });
  const rows = [];
  for (;;) {
    const page = await history.next();
    if (page.kind === 'end') break;
    rows.push(...success(page).readings);
  }
  assert.deepEqual(
    rows.map((row) => [row.value.latitude, row.observed_at, row.time_status]),
    [
      [2, times[1], 'known'],
      [1, times[0], 'known'],
      [3, null, 'unknown'],
      [4, times[3], 'uncertain'],
    ],
  );
  assert.ok(
    rows.every(
      (row) =>
        row.source_entity_id === asset.asset_id &&
        row.source_entity_kind === 'asset' &&
        row.source_evidence.origin.process_generation === asset.process_generation &&
        row.track_ids.length === 0,
    ),
  );
  success(await history.close());
  const known = remote.history.asset({
    entity_id: asset.asset_id,
    query_id: uuid(),
    time_groups: ['known'],
    source_time_from: times[1],
    source_time_before: times[0],
  });
  assert.deepEqual(
    success(await known.next()).readings.map((row) => row.value.latitude),
    [2],
  );
  success(await known.close());
});

test('caller cancellation during fresh health ends its wait while close awaits discovery and prevents allocation', async (t) => {
  const f = await fixture(t);
  const { remote, http } = await owners(t, f);
  const asset = registration();
  sent(await http.assets.register(asset).send());
  const view = remote.history.asset({ entity_id: asset.asset_id, query_id: uuid() });
  const reached = barrier(),
    finish = barrier();
  f.once('/health', async ({ forward }) => {
    reached.resolve();
    await finish.promise;
    forward();
  });
  const controller = new AbortController();
  const waiting = view.next({ signal: controller.signal });
  await reached.promise;
  controller.abort();
  assert.equal((await waiting).kind, 'cancelled');
  assert.equal((await view.next()).code, 'capacity');
  let closed = false;
  const closing = remote.close().then((result) => {
    closed = true;
    return result;
  });
  await new Promise(setImmediate);
  assert.equal(closed, false);
  finish.resolve();
  await closing;
  assert.equal(
    f.traffic.filter((entry) => entry.path === '/messages/get_asset_movement_history').length,
    0,
  );
});

test('assigned pages reject foreign instruction context and close awaits a cancelled caller attempt', async (t) => {
  const f = await fixture(t);
  const { remote, http } = await owners(t, f);
  const asset = registration();
  sent(await http.assets.register(asset).send());
  for (let i = 0; i < 2; i++) sent(await http.tasks.create(task(asset.asset_id)).send());
  const assigned = remote.assigned({
    asset_id: asset.asset_id,
    process_generation: asset.process_generation,
    read_id: uuid(),
    page_size: 1,
  });
  success(await assigned.next());
  const original = assigned.context;
  f.once('/messages/get_assigned_tasks', ({ body, forward }) => {
    const changed = JSON.parse(body);
    changed.data.core_run_id = uuid();
    forward(Buffer.from(JSON.stringify(changed)));
  });
  assert.equal((await assigned.next()).code, 'invalid_http');
  assert.deepEqual(assigned.context, original);
  success(await assigned.next());
  const pending = remote.assigned({
    asset_id: asset.asset_id,
    process_generation: asset.process_generation,
    read_id: uuid(),
    page_size: 1,
  });
  const reached = barrier(),
    finish = barrier();
  f.once('/messages/get_assigned_tasks', async ({ forward }) => {
    reached.resolve();
    await finish.promise;
    forward();
  });
  const controller = new AbortController();
  const wait = pending.next({ signal: controller.signal });
  await reached.promise;
  controller.abort();
  assert.equal((await wait).kind, 'cancelled');
  assert.equal((await pending.next()).code, 'capacity');
  let closed = false;
  const closing = remote.close().then((result) => {
    closed = true;
    return result;
  });
  await new Promise(setImmediate);
  assert.equal(closed, false);
  finish.resolve();
  const result = await closing;
  assert.ok(result.every((entry) => entry.result.kind === 'local'));
});

test('release caller cancellation ends its wait while paging and bounded release continue under Session ownership', async (t) => {
  const f = await fixture(t);
  const { remote, observation_id } = await observation(t, f);
  const view = remote.history.observation({
    entity_id: observation_id,
    query_id: uuid(),
    page_size: 1,
  });
  success(await view.next());
  const reached = barrier(),
    finish = barrier();
  f.once('/messages/get_observation_movement_history', async ({ forward }) => {
    reached.resolve();
    await finish.promise;
    forward();
  });
  const page = view.next();
  await reached.promise;
  const controller = new AbortController();
  const releasing = view.release({ signal: controller.signal });
  controller.abort();
  assert.equal((await releasing).kind, 'cancelled');
  const closing = view.close();
  finish.resolve();
  await page;
  success(await closing);
  assert.equal(view.releaseEvidence, 'acknowledged');
});

test('aggregate close awaits other releases and preserves preparation failures', async (t) => {
  const f = await fixture(t);
  const { remote, http } = await owners(t, f, { limits: { request: { maxBytes: 2000 } } });
  const asset = registration();
  sent(await http.assets.register(asset).send());
  const broken = remote.history.asset({ entity_id: asset.asset_id, query_id: uuid() });
  f.once('/messages/get_asset_movement_history', ({ body, forward }) => {
    const changed = JSON.parse(body);
    changed.data.release_token = 'x'.repeat(3000);
    forward(Buffer.from(JSON.stringify(changed)));
  });
  success(await broken.next());
  const badRelease = await broken.release({ signal: new AbortController().signal });
  assert.equal(badRelease.code, 'payload_too_large');
  const valid = remote.history.asset({ entity_id: asset.asset_id, query_id: uuid() });
  success(await valid.next());
  const reached = barrier(),
    finish = barrier();
  f.once('/messages/release_history_view', async ({ forward }) => {
    reached.resolve();
    await finish.promise;
    forward();
  });
  let rejected = false;
  const closing = remote.close().catch((error) => {
    rejected = true;
    return error;
  });
  await reached.promise;
  await new Promise(setImmediate);
  assert.equal(rejected, false);
  finish.resolve();
  const error = await closing;
  assert.ok(error instanceof AggregateError);
  assert.ok(error.errors.some((failure) => failure.code === 'payload_too_large'));
  assert.equal(valid.releaseEvidence, 'acknowledged');
  assert.equal(broken.releaseEvidence, 'unacknowledged');
});
