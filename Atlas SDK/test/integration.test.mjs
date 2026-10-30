import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, uuid, registration, task, barrier } from './harness.mjs';
import { success, sent, reading, telemetry } from './public-helpers.mjs';
const { createClient, ClientCloseError } = await import(
  process.env.ATLAS_SDK_ENTRY ?? '../dist/index.js'
);

async function until(predicate) {
  const end = performance.now() + 10_000;
  while (!predicate()) {
    assert.ok(performance.now() < end, 'Expected complete picture boundary');
    await delay(10);
  }
}

for (const mode of ['http', 'full'])
  test(`public ${mode} retains exact report ordering and atomic history across gateways and Restart`, async (t) => {
    const f = await fixture(t);
    const writer = f.client({ mode });
    const gateway = f.client();
    success(await writer.connect());
    success(await gateway.connect());
    const publisher_id = uuid();
    const { creation, reporter } = writer.reporting.createObservation({
      observation_id: uuid(),
      publisher_id,
      request_id: uuid(),
    });
    const pair = sent(await creation.send());
    const origin = { kind: 'publisher', publisher_id };
    const reports = [
      reading('9007199254740993', {
        telemetry: telemetry(origin, 23, '2026-10-21T12:00:01.0000003Z'),
      }),
      reading('9007199254740992', {
        telemetry: telemetry(origin, 22, '2026-10-21T12:00:01.0000002Z'),
      }),
      reading(
        '9007199254740997',
        { telemetry: telemetry(origin, 21, '2026-10-21T12:00:01.000000250Z') },
        { mode: 'history_only' },
      ),
    ];
    sent(await reporter.report(reports[0]).send());
    const older = reporter.report(reports[1]);
    const relayed = gateway.observations.report(older.submission.facts);
    f.once('/messages/report_observation', ({ outgoing }) => outgoing.destroy());
    const raced = await Promise.all([older.send(), relayed.send()]);
    assert.deepEqual(raced.map((item) => item.outcome.kind).sort(), [
      'accepted',
      'unknown_outcome',
    ]);
    assert.equal(sent(await older.send()).evidence_disposition, 'duplicate');
    assert.equal(sent(await relayed.send()).evidence_disposition, 'duplicate');
    const frozen = writer.observations.history({
      entity_id: pair.observation.id,
      query_id: uuid(),
      page_size: 1,
      time_groups: ['known'],
    });
    const first = success(await frozen.next());
    assert.equal(first.readings[0].value.latitude, 22);
    const relay = gateway.reporting.observation({ id: pair.observation.id, publisher_id });
    sent(await relay.report(reports[2]).send());
    const original = success(
      await writer.http.observations.get({
        observation_id: pair.observation.id,
      }),
    );
    assert.equal(original.telemetry.evidence.sequence, '9007199254740993');
    assert.equal(original.telemetry.value.position.latitude, 23);
    const invalid = structuredClone(reports[1]);
    invalid.report_id = uuid();
    invalid.sequence = '9007199254740995';
    invalid.sections.telemetry.value.position.latitude = 24;
    invalid.sections.telemetry.constituents.position.reading_id = uuid();
    invalid.sections.telemetry.value.altitude = { metres: 42, reference: 'wgs84_ellipsoid' };
    invalid.sections.type = {
      state: 'value',
      classification: 'state_until_changed',
      observed_at: null,
      value: { kind: 'person' },
    };
    const refused = await reporter.report(invalid).send();
    assert.equal(refused.attempt.response.kind, 'error');
    assert.equal(refused.attempt.response.body.error.code, 'constituent_conflict');
    assert.deepEqual(
      success(
        await writer.http.observations.get({
          observation_id: pair.observation.id,
        }),
      ),
      original,
    );
    const carried = {
      ...reports[0],
      report_id: uuid(),
      sequence: '9007199254740995',
    };
    const admitted = sent(await reporter.report(carried).send());
    for (const image of [admitted.observation, admitted.track]) {
      assert.equal(image.telemetry.evidence.sequence, '9007199254740995');
      assert.equal(image.telemetry.observed_at, '2026-10-21T12:00:01.0000003Z');
      assert.deepEqual(image.telemetry.value, {
        position: { latitude: 23, longitude: -1 },
        altitude: null,
        ground_speed: 0,
      });
      assert.deepEqual(image.telemetry.constituents, reports[0].sections.telemetry.constituents);
    }
    assert.deepEqual(admitted.observation.type, original.type);
    const collision = await reporter.report({ ...carried, report_id: uuid() }).send();
    assert.equal(collision.attempt.response.kind, 'error');
    assert.equal(collision.attempt.response.body.error.code, 'section_sequence_conflict');
    const last = success(await frozen.next());
    assert.equal(last.view_id, first.view_id);
    assert.equal(last.baseline_cursor, first.baseline_cursor);
    assert.equal(last.readings[0].value.latitude, 23);
    assert.deepEqual(await frozen.next(), { kind: 'end' });
    success(await frozen.close());
    if (mode === 'full') {
      await until(
        () =>
          writer.picture.status.kind === 'synchronized' &&
          writer.tracks.get({ track_id: pair.track.id }).value?.telemetry.evidence.sequence ===
            '9007199254740995',
      );
      const before = f.traffic.length;
      assert.deepEqual(writer.tracks.get({ track_id: pair.track.id }).value, admitted.track);
      assert.equal(f.traffic.length, before);
    }
    await writer.close();
    await gateway.close();
    await f.restart();
    const rebuilt = f.client({ mode });
    success(await rebuilt.connect());
    if (mode === 'full') await until(() => rebuilt.picture.status.kind === 'synchronized');
    const recovered = rebuilt.reporting.observation({ id: pair.observation.id, publisher_id });
    assert.equal(sent(await recovered.report(reports[2]).send()).evidence_disposition, 'duplicate');
    assert.equal(
      sent(
        await recovered
          .report({
            ...reports[2],
            report_id: uuid(),
            sequence: '9007199254740996',
          })
          .send(),
      ).evidence_disposition,
      'accepted',
    );
    const historyCollision = await recovered.report({ ...reports[2], report_id: uuid() }).send();
    assert.equal(historyCollision.attempt.response.kind, 'error');
    assert.equal(historyCollision.attempt.response.body.error.code, 'section_sequence_conflict');
    for (const [kind, entity_id] of [
      ['observations', pair.observation.id],
      ['tracks', pair.track.id],
    ]) {
      const before = f.traffic.length;
      const history = rebuilt[kind].history({
        entity_id,
        query_id: uuid(),
        page_size: 1,
      });
      const rows = [];
      for (let page = 0; page < 3; page++) {
        const result = await history.next();
        rows.push(...success(result).readings);
      }
      assert.deepEqual(await history.next(), { kind: 'end' });
      success(await history.close());
      const path = `/messages/get_${kind === 'observations' ? 'observation' : 'track'}_movement_history`;
      assert.equal(f.traffic.slice(before).filter((entry) => entry.path === path).length, 3);
      assert.deepEqual(
        rows.map((row) => [row.value.latitude, row.observed_at]),
        [
          [22, '2026-10-21T12:00:01.0000002Z'],
          [21, '2026-10-21T12:00:01.000000250Z'],
          [23, '2026-10-21T12:00:01.0000003Z'],
        ],
      );
      assert.deepEqual(
        rows.map((row) => row.source_entity_id),
        Array(3).fill(pair.observation.id),
      );
      assert.deepEqual(
        rows.map((row) => row.track_ids),
        Array(3).fill([pair.track.id]),
      );
    }
    const retained = success(
      await rebuilt.http.observations.get({
        observation_id: pair.observation.id,
      }),
    );
    assert.equal(retained.telemetry.evidence.sequence, '9007199254740995');
    assert.deepEqual(retained, admitted.observation);
    const before = f.traffic.length;
    const track = rebuilt.tracks.get({ track_id: pair.track.id });
    const retainedTrack = mode === 'full' ? track.value : success(await track);
    assert.equal(retainedTrack.telemetry.evidence.sequence, '9007199254740995');
    assert.deepEqual(retainedTrack, admitted.track);
    if (mode === 'full') assert.equal(f.traffic.length, before);
  });

test(
  'operator and Asset SDKs execute assigned work with independent Task evidence across Core Restart',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const operator = f.client({ mode: 'full' });
    success(await operator.connect());
    const registrationFacts = registration('Mission Asset');
    sent(await operator.assets.register(registrationFacts).send());
    const asset = f.client({ credentials: () => registrationFacts.secret });
    success(await asset.connect());
    const first = {
      ...task(registrationFacts.asset_id),
      task_id: '10000000-0000-4000-8000-000000000001',
    };
    const second = {
      ...task(registrationFacts.asset_id),
      task_id: '10000000-0000-4000-8000-000000000002',
    };
    first.inputs.target.position.latitude = 12;
    second.inputs.target.position.latitude = 34;
    sent(await operator.tasks.create(first).send());
    sent(await operator.tasks.create(second).send());
    const requestedOrder = [second.task_id, first.task_id];
    const reordered = sent(
      await operator.tasks
        .setOrder({
          request_id: uuid(),
          asset_id: registrationFacts.asset_id,
          expected_queue_revision: '2',
          task_ids: requestedOrder,
        })
        .send(),
    );
    assert.deepEqual(reordered.task_queue.requested_task_ids, requestedOrder);
    assert.equal(reordered.task_queue.revision, '3');
    const assigned = asset.tasks.assigned({
      asset_id: registrationFacts.asset_id,
      process_generation: registrationFacts.process_generation,
      read_id: uuid(),
      page_size: 1,
    });
    const firstPage = success(await assigned.next()),
      secondPage = success(await assigned.next());
    assert.deepEqual(firstPage.task_queue.requested_task_ids, requestedOrder);
    assert.deepEqual(secondPage.task_queue, firstPage.task_queue);
    assert.deepEqual(
      [...firstPage.tasks, ...secondPage.tasks].map((item) => [
        item.task_id,
        item.inputs.target.position.latitude,
      ]),
      [
        [first.task_id, 12],
        [second.task_id, 34],
      ],
    );
    assert.deepEqual(await assigned.next(), { kind: 'end' });
    assigned.close();
    const source = {
      dataset_id: asset.state.datasetId,
      asset_id: registrationFacts.asset_id,
      origin: {
        kind: 'asset_process',
        process_generation: registrationFacts.process_generation,
      },
      generated_at: '2026-10-21T12:00:00.0000001Z',
    };
    const adopted = sent(
      await asset.tasks
        .confirmOrder({
          evidence: {
            ...source,
            report_id: uuid(),
            sequence: '1',
            payload: { queue_revision: firstPage.task_queue.revision },
          },
        })
        .send(),
    );
    assert.deepEqual(adopted.asset.task_queue.confirmed, {
      revision: '3',
      process_generation: registrationFacts.process_generation,
    });
    const reportId = uuid();
    const acknowledge = (taskId) =>
      asset.tasks.reportExecution({
        evidence: {
          ...source,
          report_id: reportId,
          sequence: '1',
          payload: { task_id: taskId, event: 'state', state: 'acknowledged' },
        },
      });
    const lost = acknowledge(first.task_id);
    f.once('/messages/report_task_execution', ({ outgoing }) => outgoing.destroy());
    assert.equal((await lost.send()).outcome.kind, 'unknown_outcome');
    const other = sent(await acknowledge(second.task_id).send());
    assert.equal(other.task.task_id, second.task_id);
    assert.equal(other.task.execution_summary.report_id, reportId);
    assert.equal(lost.outcome.kind, 'unknown_outcome');
    assert.equal(sent(await lost.send()).evidence_disposition, 'duplicate');
    assert.equal(lost.outcome.kind, 'accepted');
    const cancellation = { request_id: uuid(), task_id: second.task_id };
    const requested = sent(await operator.tasks.cancel(cancellation).send());
    assert.equal(requested.cancellation_request_id, cancellation.request_id);
    assert.equal(requested.execution_state, 'acknowledged');
    const refused = sent(
      await asset.tasks
        .reportExecution({
          evidence: {
            ...source,
            report_id: uuid(),
            sequence: '2',
            payload: {
              task_id: second.task_id,
              event: 'cancellation_refused',
              state: 'acknowledged',
              cancellation_request_id: cancellation.request_id,
              reason: 'operator_requested_continue',
            },
          },
        })
        .send(),
    );
    assert.equal(refused.task.cancellation_request_id, null);
    assert.equal(refused.task.execution_state, 'acknowledged');
    const completionId = uuid();
    const completed = await asset.tasks
      .reportExecution({
        evidence: {
          ...source,
          report_id: completionId,
          sequence: '3',
          payload: { task_id: second.task_id, event: 'state', state: 'completed' },
        },
      })
      .send();
    sent(completed);
    const expectedSummary = {
      origin: source.origin,
      report_id: completionId,
      sequence: '3',
      generated_at: '2026-10-21T12:00:00.0000001Z',
      event: 'state',
      state: 'completed',
    };
    const retained = success(await asset.tasks.get({ task_id: second.task_id }));
    assert.deepEqual(retained.execution_summary, expectedSummary);
    assert.equal(retained.cancellation_request_id, null);
    await until(
      () =>
        operator.picture.status.kind === 'synchronized' &&
        operator.picture.status.cursor === completed.attempt.response.body.commit_cursor,
    );
    const beforeLocal = f.traffic.length;
    assert.deepEqual(
      operator.tasks.get({ task_id: second.task_id }).value.execution_summary,
      expectedSummary,
    );
    assert.deepEqual(
      operator.assets.get({ asset_id: registrationFacts.asset_id }).value.task_queue
        .requested_task_ids,
      [first.task_id],
    );
    assert.equal(f.traffic.length, beforeLocal);
    await operator.close();
    await f.restart();
    success(await asset.connect());
    assert.deepEqual(success(await asset.tasks.get({ task_id: second.task_id })), retained);
    const remaining = asset.tasks.assigned({
      asset_id: registrationFacts.asset_id,
      process_generation: registrationFacts.process_generation,
      read_id: uuid(),
    });
    assert.deepEqual(
      success(await remaining.next()).tasks.map((item) => item.task_id),
      [first.task_id],
    );
    remaining.close();
    const rebuilt = f.client({ mode: 'full' });
    success(await rebuilt.connect());
    await until(() => rebuilt.picture.status.kind === 'synchronized');
    const beforeRebuilt = f.traffic.length;
    assert.deepEqual(rebuilt.tasks.get({ task_id: second.task_id }).value, retained);
    assert.deepEqual(
      rebuilt.assets.get({ asset_id: registrationFacts.asset_id }).value.task_queue
        .requested_task_ids,
      [first.task_id],
    );
    assert.equal(f.traffic.length, beforeRebuilt);
    t.diagnostic(
      JSON.stringify({
        workflow: 'assigned-task-execution',
        datasetId: asset.state.datasetId,
        requestedOrder,
        confirmedRevision: '3',
        sharedReportId: reportId,
        lostReplyRetry: 'duplicate',
        completedTask: second.task_id,
        completion: expectedSummary,
        remainingTasks: [first.task_id],
        restart: 'retained HTTP and rebuilt Full state',
        localReadHttpRequests: 0,
      }),
    );
  },
);

for (const mode of ['http', 'full']) {
  test(`public ${mode} composes reporting, explicit HTTP reads, verified content and bounded close`, async (t) => {
    const f = await fixture(t);
    const client = createClient({ baseUrl: f.proxyUrl, credentials: () => f.apiKey, mode });
    t.after(() => client.close());
    success(await client.connect());
    const asset = registration('Integrated Asset');
    const registered = client.reporting.register(asset);
    sent(await registered.registration.send());
    const observationId = uuid(),
      publisherId = uuid();
    const { creation, reporter } = client.reporting.createObservation({
      observation_id: observationId,
      publisher_id: publisherId,
      source_asset_id: asset.asset_id,
      request_id: uuid(),
    });
    const pair = sent(await creation.send());
    const report = reporter.report(
      reading(1, {
        telemetry: telemetry(
          { kind: 'publisher', publisher_id: publisherId },
          25,
          '2026-10-21T12:00:01Z',
        ),
      }),
    );
    f.once('/messages/report_observation', ({ outgoing }) => outgoing.destroy());
    assert.equal((await report.send()).outcome.kind, 'unknown_outcome');
    const equivalent = client.observations.report(structuredClone(report.submission.facts));
    sent(await equivalent.send());
    assert.equal(report.outcome.kind, 'accepted');
    const bytes = Buffer.alloc(256_000, 7);
    const descriptor = {
      object_id: uuid(),
      request_id: uuid(),
      byte_length: String(bytes.length),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      content_type: 'application/octet-stream',
      metadata: { associations: [] },
    };
    const published = await client.objects.upload(descriptor, new Blob([bytes])).send();
    sent(published);
    if (client.mode === 'full') {
      await until(
        () =>
          client.picture.status.kind === 'synchronized' &&
          client.picture.status.cursor === published.attempt.response.body.commit_cursor,
      );
      const before = f.traffic.length;
      assert.equal(client.assets.get({ asset_id: asset.asset_id }).value.alias, 'Integrated Asset');
      assert.equal(client.tracks.get({ track_id: pair.track.id }).value.id, pair.track.id);
      assert.equal(
        client.objects.get({ object_id: descriptor.object_id }).value.sha256,
        descriptor.sha256,
      );
      assert.equal(client.picture.changedSince(client.picture.cursor).value.commits.length, 0);
      assert.equal(f.traffic.length, before);
    }
    const before = f.traffic.length;
    assert.equal(
      success(await client.observations.get({ observation_id: observationId })).track_id,
      pair.track.id,
    );
    const history = client.tracks.history({
      entity_id: pair.track.id,
      query_id: uuid(),
      page_size: 1,
    });
    const page = success(await history.next());
    assert.equal(page.readings[0].value.latitude, 25);
    assert.equal(history.context.baseline_cursor, page.baseline_cursor);
    assert.ok(f.traffic.length > before);
    const assigned = client.tasks.assigned({
      asset_id: asset.asset_id,
      process_generation: asset.process_generation,
      read_id: uuid(),
    });
    assert.deepEqual(success(await assigned.next()).tasks, []);
    const sourcePage = success(
      await client.observations.list({ filters: { source_asset_ids: [asset.asset_id] } }).next(),
    );
    assert.deepEqual(
      sourcePage.items.map((item) => item.id),
      [observationId],
    );
    const trackSources = success(
      await client.tracks
        .observations({ track_id: pair.track.id, publisher_ids: [publisherId] })
        .next(),
    );
    assert.deepEqual(
      trackSources.items.map((item) => item.id),
      [observationId],
    );
    const contact = client.assets.contact({
      asset_id: asset.asset_id,
      process_generation: asset.process_generation,
      request_id: uuid(),
      mode: 'current',
    });
    const challenge = success(await contact.read());
    const proof = registered.reporter.update(
      { request_id: uuid() },
      reading(
        1,
        {},
        {
          generated_at: challenge.issued_at,
          contact_proof: { challenge_id: challenge.challenge_id },
        },
      ),
    );
    const checkedIn = sent(await contact.checkIn(proof.submission.facts).send());
    assert.equal(checkedIn.asset.communications.health, 'healthy');
    assert.equal(proof.outcome.kind, 'accepted', 'Contact and reporting share prepared evidence');
    assert.equal(contact.releaseEvidence, 'acknowledged');
    await contact.close();
    const download = client.objects.content({
      object_id: descriptor.object_id,
      disposition: 'inline',
    });
    const opened = await download.open();
    assert.equal(opened.response.kind, 'content');
    const query = client.mode === 'full' ? client.assets.query({}) : undefined;
    const reached = barrier(),
      finish = barrier();
    t.after(() => finish.resolve());
    f.once('/messages/release_history_view', async ({ forward }) => {
      reached.resolve();
      await finish.promise;
      forward();
    });
    const closing = client.close();
    assert.equal(client.close(), closing);
    if (client.mode === 'full') {
      assert.equal(client.picture.status.kind, 'stopped');
      assert.equal(query.value.page().kind, 'refused');
    }
    await reached.promise;
    const traffic = f.traffic.length;
    for (const result of [
      await client.readiness({}),
      await client.connect(),
      await client.recover(),
      await client.reference('text/html'),
    ]) {
      assert.equal(result.kind, 'not_sent');
      assert.equal(result.code, 'closed');
    }
    const mutation = await client.assets
      .update({
        asset_id: asset.asset_id,
        request_id: uuid(),
        expected_edit_revision: '0',
        alias: 'Blocked',
      })
      .send();
    assert.equal(mutation.attempt.code, 'closed');
    assert.equal(mutation.outcome.kind, 'not_submitted');
    assert.equal(f.traffic.length, traffic);
    assert.equal((await download.settled).code, 'closed');
    await assert.rejects(opened.response.stream.getReader().read());
    finish.resolve();
    const closed = await closing;
    const released = closed.remote.find(
      (entry) => entry.identity === JSON.stringify(['GetTrackMovementHistory', page.query_id]),
    );
    assert.equal(released.result.kind, 'response');
    assert.equal(released.result.response.body.data.released, true);
    assert.equal(history.releaseEvidence, 'acknowledged');
    const after = f.traffic.length;
    await delay(150);
    assert.equal(f.traffic.length, after, 'No restart or delayed traffic after close');
    assert.equal(client.state.kind, 'closed');
  });
}

test('public close preserves lost-release evidence and makes no release while authorization is paused', async (t) => {
  const f = await fixture(t);
  for (const paused of [false, true]) {
    const client = createClient({ baseUrl: f.proxyUrl, credentials: () => f.apiKey });
    t.after(() => client.close());
    success(await client.connect());
    const asset = registration();
    sent(await client.assets.register(asset).send());
    const history = client.assets.history({ entity_id: asset.asset_id, query_id: uuid() });
    success(await history.next());
    if (paused) {
      await client.apiKeys.revoke({ api_key_id: f.apiKeyId, request_id: uuid() }).send();
      await client.readiness({});
      assert.equal(client.state.kind, 'authorization-required');
    } else f.once('/messages/release_history_view', ({ outgoing }) => outgoing.destroy());
    const before = f.traffic.length;
    const closed = await client.close();
    assert.equal(history.releaseEvidence, 'unacknowledged');
    assert.equal(closed.remote.length, 1);
    assert.equal(closed.remote[0].result.kind, paused ? 'abandoned' : 'failed');
    assert.equal(f.traffic.length - before, paused ? 0 : 1);
  }
});

test('public close awaits every release and drains attempts despite a cleanup preparation failure', async (t) => {
  const f = await fixture(t);
  const client = createClient({
    baseUrl: f.proxyUrl,
    credentials: () => f.apiKey,
    limits: { request: { maxBytes: 2000 } },
  });
  success(await client.connect());
  const asset = registration();
  sent(await client.assets.register(asset).send());
  const broken = client.assets.history({ entity_id: asset.asset_id, query_id: uuid() });
  f.once('/messages/get_asset_movement_history', ({ body, forward }) => {
    const changed = JSON.parse(body);
    changed.data.release_token = 'x'.repeat(3000);
    forward(Buffer.from(JSON.stringify(changed)));
  });
  success(await broken.next());
  const valid = client.assets.history({ entity_id: asset.asset_id, query_id: uuid() });
  success(await valid.next());
  const reached = barrier(),
    finish = barrier();
  t.after(() => finish.resolve());
  f.once('/messages/release_history_view', async ({ forward }) => {
    reached.resolve();
    await finish.promise;
    forward();
  });
  let ended = false;
  const closing = client.close().catch((error) => {
    ended = true;
    return error;
  });
  await reached.promise;
  assert.equal(ended, false);
  assert.equal((await client.readiness({})).code, 'closed');
  finish.resolve();
  const error = await closing;
  assert.ok(error instanceof ClientCloseError);
  assert.ok(
    error.errors.some(
      (failure) =>
        failure instanceof AggregateError &&
        failure.errors.some((inner) => inner.code === 'payload_too_large'),
    ),
  );
  assert.equal(valid.releaseEvidence, 'acknowledged');
  assert.equal(broken.releaseEvidence, 'unacknowledged');
  assert.equal(error.remote, undefined, 'Unavailable aggregate evidence is explicit');
  assert.equal(client.state.kind, 'closed');
  await assert.rejects(client.close(), ClientCloseError);
});

for (const cleanupFails of [false, true])
  test(`reentrant source cancellation joins the same public close owner with cleanup failure=${cleanupFails}`, async (t) => {
    const f = await fixture(t);
    const client = createClient({ baseUrl: f.address, credentials: () => f.apiKey });
    t.after(() =>
      cleanupFails ? assert.rejects(client.close(), ClientCloseError) : client.close(),
    );
    success(await client.connect());
    const reading = barrier();
    let reentrant;
    let cancellations = 0;
    const bytes = Buffer.from('x');
    const operation = client.objects.upload(
      {
        object_id: uuid(),
        request_id: uuid(),
        byte_length: '1',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        content_type: 'application/octet-stream',
        metadata: { associations: [] },
      },
      {
        open() {
          return new ReadableStream(
            {
              pull() {
                reading.resolve();
                return new Promise(() => {});
              },
              cancel() {
                cancellations++;
                reentrant = client.close();
                if (cleanupFails) throw new Error('source cancellation failed');
              },
            },
            { highWaterMark: 0 },
          );
        },
      },
    );
    const running = operation.start();
    await reading.promise;
    const closed = client.close();
    if (cleanupFails) {
      await assert.rejects(
        closed,
        (error) =>
          error instanceof ClientCloseError &&
          error.errors.some((failure) => failure.code === 'network'),
      );
      assert.equal((await running.settled).context.cleanupFailure, 'network');
    } else await closed;
    assert.equal(reentrant, closed);
    assert.equal(client.close(), closed);
    assert.equal(cancellations, 1);
    assert.equal((await running.settled).code, 'closed');
    assert.equal(client.state.kind, 'closed');
  });

for (const cause of ['network', 'deadline', 'close'])
  test(
    `real partial HTTP response ${cause} must drain without a fabricated cleanup error`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t);
      const client = createClient({ baseUrl: f.proxyUrl, credentials: () => f.apiKey });
      t.after(() => client.close());
      success(await client.connect());
      const partial = barrier(),
        release = barrier();
      t.after(() => release.resolve());
      f.once('/readiness', async ({ outgoing, headers, body }) => {
        outgoing.writeHead(200, headers);
        outgoing.write(body.subarray(0, 1));
        partial.resolve();
        await release.promise;
        outgoing.destroy();
      });
      const pending = client.readiness({}, cause === 'deadline' ? { timeoutMs: 500 } : {});
      await partial.promise;
      await new Promise((resolve) => setTimeout(resolve, 100));
      let closing;
      if (cause === 'close') closing = client.close();
      if (cause === 'network') release.resolve();
      const attempt = await pending;
      release.resolve();
      const [close] = await Promise.allSettled([closing ?? client.close()]);

      assert.equal(attempt.context.cleanupFailure, undefined);
      assert.equal(attempt.kind, 'failed');
      assert.equal(attempt.code, cause === 'close' ? 'closed' : cause);
      assert.ok(
        attempt.context.receivedBytes > 0,
        'the body-read failure boundary must actually run',
      );
      assert.equal(
        close.status,
        'fulfilled',
        'A completed primary HTTP-body failure must not be reported as failed shutdown cleanup',
      );
    },
  );

for (const mode of ['http', 'full'])
  test(`close drains saturated ${mode} admission before releasing all history views`, async (t) => {
    const f = await fixture(t);
    const client = createClient({
      baseUrl: f.proxyUrl,
      credentials: () => f.apiKey,
      mode,
      limits: { concurrentAttempts: 2 },
    });
    t.after(() => client.close());
    success(await client.connect());
    if (mode === 'full') await until(() => client.picture.status.kind === 'synchronized');
    const asset = registration();
    sent(await client.assets.register(asset).send());
    const views = [];
    for (let i = 0; i < 3; i++) {
      const view = client.assets.history({ entity_id: asset.asset_id, query_id: uuid() });
      success(await view.next());
      views.push(view);
    }
    const reached = barrier(),
      held = barrier();
    t.after(() => held.resolve());
    const busy = mode === 'full' ? 1 : 2;
    let count = 0;
    const reads = [];
    for (let i = 0; i < busy; i++) {
      f.once('/messages/get_asset', async ({ forward }) => {
        if (++count === busy) reached.resolve();
        await held.promise;
        forward();
      });
      reads.push(client.http.assets.get({ asset_id: asset.asset_id }));
    }
    await reached.promise;
    const closed = await client.close();
    held.resolve();
    for (const result of await Promise.all(reads)) assert.equal(result.code, 'closed');
    assert.equal(closed.remote.length, 3);
    for (const view of views) assert.equal(view.releaseEvidence, 'acknowledged');
    assert.equal(f.traffic.filter((e) => e.path === '/messages/release_history_view').length, 3);
  });
