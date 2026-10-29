import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, uuid, registration, task, barrier } from './harness.mjs';
import { publicClient, success, sent, reading, telemetry } from './public-helpers.mjs';

async function observation(t, f) {
  const owned = await publicClient(t, f);
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

test('closing unallocated history and contact handles releases their capacity without HTTP', async (t) => {
  const f = await fixture(t);
  const { http } = await publicClient(t, f, {}, { handles: 1 });
  const asset = registration();
  sent(await http.assets.register(asset).send());
  const before = f.traffic.length;
  for (let i = 0; i < 3; i++) {
    const view = http.assets.history({ entity_id: asset.asset_id, query_id: uuid() });
    assert.equal((await view.next({ signal: AbortSignal.abort() })).code, 'cancelled');
    assert.deepEqual(await view.close(), { kind: 'abandoned', evidence: 'unallocated' });
    const contact = http.assets.contact({
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
  const { http } = await publicClient(t, f, {}, { handles: 1 });
  const asset = registration();
  sent(await http.assets.register(asset).send());
  const view = http.assets.history({ entity_id: asset.asset_id, query_id: uuid() });
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
  const replacement = http.assets.history({ entity_id: asset.asset_id, query_id: uuid() });
  assert.deepEqual(await replacement.close(), { kind: 'abandoned', evidence: 'unallocated' });
});

test('HTTP history freezes pages and repeats exact allocation after a lost reply, while a fresh query sees later readings', async (t) => {
  const f = await fixture(t);
  const { client, report, observation_id, pair, http } = await observation(t, f);
  const selection = {
    entity_id: observation_id,
    query_id: uuid(),
    page_size: 1,
    time_groups: ['known'],
  };
  const view = http.observations.history(selection);
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
  const fresh = http.tracks.history({ entity_id: pair.track.id, query_id: uuid(), page_size: 1 });
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
  await client.close();
});

test('history refuses switched page context without advancing or retaining the foreign view', async (t) => {
  const f = await fixture(t);
  const { http, observation_id } = await observation(t, f);
  const view = http.observations.history({
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
  const { http, observation_id } = await observation(t, f);
  const view = http.observations.history({
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
  const { http, client, observation_id } = await observation(t, f);
  const view = http.observations.history({
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
  const old = http.observations.history({
    entity_id: observation_id,
    query_id: uuid(),
    page_size: 1,
  });
  success(await old.next());
  await f.restart();
  success(await client.connect());
  const before = f.traffic.length;
  assert.equal((await old.next()).code, 'superseded');
  assert.equal(old.releaseEvidence, 'owner-ended');
  assert.equal(f.traffic.length, before);
  const reset = http.observations.history({
    entity_id: observation_id,
    query_id: uuid(),
    page_size: 1,
  });
  success(await reset.next());
  await f.reset();
  success(await client.connect());
  assert.equal((await reset.next()).code, 'dataset_invalidated');
});

test('authorization pause sends no history continuation or release and keeps lost allocations bounded', async (t) => {
  const f = await fixture(t);
  let credential = f.apiKey;
  const { client, http } = await publicClient(
    t,
    f,
    { credentials: () => credential },
    { handles: 1 },
  );
  const asset = registration();
  sent(await http.assets.register(asset).send());
  const query = { entity_id: asset.asset_id, query_id: uuid(), page_size: 1 };
  const view = http.assets.history(query);
  f.once('/messages/get_asset_movement_history', ({ outgoing }) => outgoing.destroy());
  assert.equal((await view.next()).kind, 'failed');
  assert.throws(() => http.assets.history({ ...query, query_id: uuid() }), { code: 'capacity' });
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
  assert.throws(() => http.assets.history({ ...query, query_id: uuid() }), { code: 'capacity' });
  await client.close();
});

test('assigned instructions retain process, read and Core run across actual endpoint pages', async (t) => {
  const f = await fixture(t);
  const { http, client } = await publicClient(t, f);
  const asset = registration();
  sent(await http.assets.register(asset).send());
  const tasks = [task(asset.asset_id), task(asset.asset_id)];
  for (const input of tasks) sent(await http.tasks.create(input).send());
  const assigned = http.tasks.assigned({
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
  const stale = http.tasks.assigned({
    asset_id: asset.asset_id,
    process_generation: asset.process_generation,
    read_id: uuid(),
  });
  success(await stale.next());
  await f.restart();
  success(await client.connect());
  assert.equal((await stale.next()).code, 'superseded');
});

test(
  'closed contact handles release known expired challenges while lost replies retain their reservation',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const { http } = await publicClient(t, f, {}, { handles: 1 });
    const { http: uncertain } = await publicClient(t, f);
    const asset = registration(),
      other = registration();
    sent(await http.assets.register(asset).send());
    sent(await uncertain.assets.register(other).send());
    const request = (registered) => ({
      request_id: uuid(),
      asset_id: registered.asset_id,
      process_generation: registered.process_generation,
      mode: 'current',
    });
    const contact = http.assets.contact(request(asset));
    const challenge = success(await contact.read());
    const expiry = performance.now() + 10_200;
    const lost = uncertain.assets.contact(request(other));
    f.once('/messages/begin_asset_contact', ({ outgoing }) => outgoing.destroy());
    assert.equal((await lost.read()).kind, 'failed');
    assert.deepEqual(await lost.close(), { kind: 'abandoned', evidence: 'unacknowledged' });

    await delay(5_000);
    assert.deepEqual(success(await contact.read()), challenge);
    assert.deepEqual(await contact.close(), { kind: 'abandoned', evidence: 'unacknowledged' });
    assert.throws(() => http.assets.contact(request(asset)), { code: 'capacity' });
    await delay(Math.max(0, expiry - performance.now()));

    assert.throws(() => uncertain.assets.contact(request(other)), { code: 'identity_conflict' });
    assert.equal(lost.releaseEvidence, 'unacknowledged');
    const fresh = http.assets.contact(request(asset));
    const replacement = success(await fresh.read());
    assert.notEqual(replacement.challenge_id, challenge.challenge_id);
    assert.equal(replacement.asset_id, asset.asset_id);
    assert.notEqual(fresh.allocation.allocationContext, contact.allocation.allocationContext);
    const traffic = f.traffic.length;
    assert.equal((await contact.read()).code, 'closed');
    await contact.close();
    assert.equal(f.traffic.length, traffic);
    assert.deepEqual(success(await fresh.read()), replacement);
  },
);

test('contact retries the original challenge, proves current contact, and replacement changes only the requested process', async (t) => {
  const f = await fixture(t);
  const { reporting, http } = await publicClient(t, f);
  const asset = registration();
  sent(await http.assets.register(asset).send());
  const contact = http.assets.contact({
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
  const replacement = http.assets.contact({
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

test('allocation context refusal keeps exact original facts and never silently obtains a replacement', async (t) => {
  const f = await fixture(t);
  const { http } = await publicClient(t, f);
  const asset = registration();
  sent(await http.assets.register(asset).send());
  const view = http.assets.history({ entity_id: asset.asset_id, query_id: uuid() });
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

test('remote handle and byte capacity is checked before allocation and returned contexts are also bounded', async (t) => {
  const f = await fixture(t);
  const { http } = await publicClient(t, f, {}, { handles: 1, retainedBytes: 64000 });
  const asset = registration();
  sent(await http.assets.register(asset).send());
  const before = f.traffic.length;
  assert.throws(() =>
    http.assets.history({
      entity_id: asset.asset_id,
      query_id: uuid(),
      unexpected: 'x'.repeat(1000000),
    }),
  );
  assert.equal(f.traffic.length, before);
  const view = http.assets.history({ entity_id: asset.asset_id, query_id: uuid() });
  assert.throws(
    () =>
      http.tasks.assigned({
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
  const { client, http } = await publicClient(t, f);
  const asset = registration();
  sent(await http.assets.register(asset).send());
  const view = http.assets.history({ entity_id: asset.asset_id, query_id: uuid() });
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
  await client.close();
});

test('Asset movement history preserves exact source times and distinct unknown and uncertain groups', async (t) => {
  const f = await fixture(t);
  const { http, reporting } = await publicClient(t, f);
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
  const history = http.assets.history({
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
  const known = http.assets.history({
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

test('release caller cancellation ends its wait while paging and bounded release continue under Session ownership', async (t) => {
  const f = await fixture(t);
  const { http, observation_id } = await observation(t, f);
  const view = http.observations.history({
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

test('two concurrent first history pages on an idle ready HTTP client', async (t) => {
  const f = await fixture(t);
  const { http } = await publicClient(t, f);
  const asset = registration();
  sent(await http.assets.register(asset).send());
  const a = http.assets.history({ entity_id: asset.asset_id, query_id: uuid() });
  const b = http.assets.history({ entity_id: asset.asset_id, query_id: uuid() });
  const [ra, rb] = await Promise.all([a.next(), b.next()]);
  const summary = (r) =>
    r.kind === 'response' ? `${r.kind}/${r.response.kind}` : `${r.kind}/${r.code}`;
  await Promise.all([a.close(), b.close()]);
  assert.equal(summary(ra), 'response/success');
  assert.equal(summary(rb), 'response/success');
});

test('history first page concurrent with contact read', async (t) => {
  const f = await fixture(t);
  const { http } = await publicClient(t, f);
  const asset = registration();
  sent(await http.assets.register(asset).send());
  const view = http.assets.history({ entity_id: asset.asset_id, query_id: uuid() });
  const contact = http.assets.contact({
    asset_id: asset.asset_id,
    process_generation: asset.process_generation,
    mode: 'current',
    request_id: uuid(),
  });
  const [rv, rc] = await Promise.all([view.next(), contact.read()]);
  const summary = (r) =>
    r.kind === 'response' ? `${r.kind}/${r.response.kind}` : `${r.kind}/${r.code}`;
  await Promise.all([view.close(), contact.close()]);
  assert.equal(summary(rv), 'response/success');
  assert.equal(summary(rc), 'response/success');
});
