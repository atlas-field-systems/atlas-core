import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, uuid, registration, barrier } from './harness.mjs';
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
