import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { fixture, uuid, secret, registration, task, barrier } from './harness.mjs';
import { publicClient, sent, reading, telemetry } from './public-helpers.mjs';
const { createClient, ClientCloseError } = await import(
  process.env.ATLAS_SDK_ENTRY ?? '../dist/index.js'
);

function success(result) {
  assert.equal(result.kind, 'response', JSON.stringify(result));
  assert.equal(result.response.kind, 'success', JSON.stringify(result));
  return result.response.body;
}
function available(result) {
  assert.equal(result.kind, 'available', JSON.stringify(result));
  return result.value;
}
async function until(predicate, label, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < end, label);
    await delay(10);
  }
}
async function connected(f, options) {
  const client = f.client(options);
  success(await client.connect());
  return client;
}
async function ready(client, cursor) {
  await until(
    () =>
      client.picture.status.kind === 'synchronized' &&
      (cursor === undefined || client.picture.status.cursor === cursor),
    `Picture did not synchronize: ${JSON.stringify(client.picture.status)}`,
  );
}
async function register(client, alias) {
  return success((await client.assets.register(registration(alias)).send()).attempt).data.asset;
}

test('Full picture retains Asset Tags through snapshot and live replacement', async (t) => {
  const f = await fixture(t);
  const admin = await connected(f);
  const asset = await register(admin, 'Simulated camera');
  const reporter = admin.reporting.asset({
    id: asset.id,
    process_generation: asset.process_generation,
  });
  const tags = {
    state: 'value',
    classification: 'state_until_changed',
    observed_at: null,
    value: { presets: ['simulated'] },
  };
  const first = sent(
    await reporter.update({ request_id: uuid() }, reading(1, { tags })).send(),
  ).asset;
  const client = await connected(f, { mode: 'full' });
  await ready(client);
  assert.deepEqual(available(client.assets.get({ asset_id: asset.id })).tags, first.tags);
  const updated = await reporter
    .update({ request_id: uuid() }, reading(2, { tags: { ...tags, value: { presets: [] } } }))
    .send();
  const cleared = sent(updated).asset;
  await ready(client, updated.attempt.response.body.commit_cursor);
  const traffic = f.traffic.length;
  assert.deepEqual(available(client.assets.get({ asset_id: asset.id })).tags, cleared.tags);
  assert.deepEqual(cleared.tags.value, { presets: [] });
  assert.equal(f.traffic.length, traffic, 'Ready Tags are read locally');
});

for (const recovery of ['live', 'authorization'])
  test(
    `bounded feed bursts preserve the picture through repeated ${recovery} replay`,
    { timeout: 30_000 },
    async (t) => {
      const f = await fixture(t),
        admin = await connected(f),
        sockets = observeSockets(t);
      const key = { request_id: uuid(), api_key_id: uuid(), secret: secret() };
      success((await admin.apiKeys.create(key).send()).attempt);
      let credential = key.secret;
      const sentinel = await register(admin, 'before burst');
      const client = await connected(f, { mode: 'full', credentials: () => credential });
      await ready(client);
      const generation = client.picture.status.generation,
        boundary = client.picture.cursor,
        snapshots = f.traffic.filter((entry) => entry.path === '/messages/read_snapshot').length;
      const query = available(client.assets.query({})),
        frozen = available(query.page());
      if (recovery === 'authorization') {
        success(
          (await admin.apiKeys.revoke({ request_id: uuid(), api_key_id: key.api_key_id }).send())
            .attempt,
        );
        await until(
          () => client.picture.status.kind === 'authorization-required',
          'No authorization pause',
        );
      }
      const held = barrier(),
        reached = barrier(),
        gates = Array.from({ length: 2 }, () => ({ release: barrier(), socket: null }));
      const digest = crypto.subtle.digest;
      let lastSocket,
        gateIndex = 0;
      crypto.subtle.digest = async function (...args) {
        const socket = sockets.at(-1);
        if (socket !== lastSocket && gateIndex < gates.length) {
          lastSocket = socket;
          const gate = gates[gateIndex++];
          gate.socket = socket;
          await gate.release.promise;
        }
        return digest.apply(this, args);
      };
      f.wssOnce('change_batch', async ({ send }) => {
        reached.resolve();
        await held.promise;
        send();
      });
      const facts = Array.from({ length: 300 }, () => registration());
      let finalCursor;
      try {
        for (const item of facts) {
          const operation = admin.assets.register(item);
          const result = await operation.send();
          finalCursor = success(result.attempt).commit_cursor;
          operation.close();
        }
        if (recovery === 'authorization') {
          credential = f.apiKey;
          success(await client.recover());
        }
        await until(
          () =>
            f.wssTraffic.some(
              (entry) => entry.direction === 'server' && entry.type === 'change_batch',
            ),
          'No burst frame',
        );
        await reached.promise;
        held.resolve();
        for (const gate of gates) {
          await until(() => gate.socket !== null, 'No replay digest');
          await until(
            () => gate.socket.readyState === WebSocket.CLOSED,
            'Pressure did not retire the socket',
          );
          assert.equal(client.picture.status.generation, generation);
          assert.deepEqual(available(client.assets.get({ asset_id: sentinel.id })), sentinel);
          assert.equal(available(query.page()).cursor, frozen.cursor);
          const cursor = client.picture.status.cursor;
          gate.release.resolve();
          await until(() => client.picture.status.cursor !== cursor, 'Replay made no progress');
        }
        await ready(client, finalCursor);
        assert.equal(client.picture.status.generation, generation);
        assert.equal(
          f.traffic.filter((entry) => entry.path === '/messages/read_snapshot').length,
          snapshots,
        );
        for (const item of facts)
          assert.equal(available(client.assets.get({ asset_id: item.asset_id })).id, item.asset_id);
        const journal = available(client.picture.changedSince(boundary, 1000));
        assert.equal(journal.hasMore, false);
        const changes = journal.commits.flatMap((commit) => commit.changes);
        assert.deepEqual(
          changes.map((change) => change.resource_id).sort(),
          facts.map((item) => item.asset_id).sort(),
        );
        assert.deepEqual(available(query.page()).items, [sentinel]);
        t.diagnostic(
          `Drained ${gates.length} pressured connections and retained all ${facts.length} Assets`,
        );
      } finally {
        held.resolve();
        for (const gate of gates) gate.release.resolve();
        crypto.subtle.digest = digest;
        query.close();
      }
    },
  );

test('an over-limit feed frame pauses maintenance until explicit retry', async (t) => {
  const f = await fixture(t),
    admin = await connected(f),
    sockets = observeSockets(t);
  const sentinel = await register(admin, 'before oversized frame');
  const client = await connected(f, { mode: 'full' });
  await ready(client);
  const query = available(client.assets.query({}));
  const snapshots = f.traffic.filter((entry) => entry.path === '/messages/read_snapshot').length,
    connections = sockets.length;
  f.wssOnce('change_batch', ({ to }) => to.send('x'.repeat(4_194_305)));
  const after = await register(admin, 'after oversized frame');
  await until(
    () => client.picture.status.kind === 'resource-limited',
    'Oversized frame did not pause maintenance',
  );
  assert.equal(client.picture.status.reason, 'capacity');
  assert.equal(client.assets.get({ asset_id: sentinel.id }).kind, 'unavailable');
  assert.equal(query.page().code, 'invalid_token');
  await delay(600);
  assert.equal(sockets.length, connections);
  assert.equal(
    f.traffic.filter((entry) => entry.path === '/messages/read_snapshot').length,
    snapshots,
  );
  client.picture.retry();
  await ready(client);
  assert.deepEqual(available(client.assets.get({ asset_id: sentinel.id })), sentinel);
  assert.deepEqual(available(client.assets.get({ asset_id: after.id })), after);
  assert.equal(sockets.length, connections + 1);
  assert.equal(
    f.traffic.filter((entry) => entry.path === '/messages/read_snapshot').length,
    snapshots + 1,
  );
  query.close();
});

function observeSockets(t) {
  const Native = globalThis.WebSocket;
  const sockets = [];
  globalThis.WebSocket = class extends Native {
    constructor(...args) {
      super(...args);
      sockets.push(this);
    }
  };
  t.after(() => {
    globalThis.WebSocket = Native;
  });
  return sockets;
}
async function call(f, operation, data, credential = f.apiKey) {
  const response = await fetch(`${f.proxyUrl}/messages/${operation}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential}`,
      'atlas-dataset-id': f.datasetId,
      'atlas-protocol-version': '0.4.0',
      'content-type': 'application/json',
    },
    body: JSON.stringify(data),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}
test('Full Task Objects include the deduplicated ready union of declarations and associations', async (t) => {
  const f = await fixture(t);
  const writer = await connected(f);
  const asset = await register(writer, 'Task result owner');
  const created = success((await writer.tasks.create(task(asset.id)).send()).attempt).data;
  const bytes = Buffer.from('Task output');
  const descriptor = (associations) => ({
    object_id: uuid(),
    request_id: uuid(),
    byte_length: String(bytes.length),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    content_type: 'text/plain',
    metadata: { associations },
  });
  const association = { kind: 'task', id: created.task_id };
  const objects = [
    descriptor([]),
    descriptor([association]),
    descriptor([association]),
    descriptor([]),
  ];
  const pending = descriptor([]);
  for (const object of objects)
    success((await writer.objects.upload(object, new Blob([bytes])).send()).attempt);
  const declared = success(
    (
      await writer.tasks
        .reportResults({
          evidence: {
            dataset_id: f.datasetId,
            asset_id: asset.id,
            origin: { kind: 'asset_process', process_generation: asset.process_generation },
            report_id: uuid(),
            sequence: '1',
            generated_at: null,
            payload: {
              task_id: created.task_id,
              declarations: [objects[0], objects[2], pending].map(({ object_id }) => ({
                object_id,
                required: true,
              })),
            },
          },
        })
        .send()
    ).attempt,
  );
  const client = await connected(f, { mode: 'full' });
  await ready(client, declared.commit_cursor);
  const expected = objects
    .slice(0, 3)
    .map(({ object_id }) => object_id)
    .sort();
  const remote = success(await client.http.tasks.objects({ task_id: created.task_id }).next());
  assert.deepEqual(
    remote.data.items.map(({ object_id }) => object_id),
    expected,
  );
  const before = f.traffic.length;
  const query = available(client.tasks.objects({ task_id: created.task_id, page_size: 1 }));
  const collected = [];
  let token;
  do {
    const page = available(query.page(token));
    collected.push(...page.items.map(({ object_id }) => object_id));
    token = page.nextPageToken;
    assert.ok(collected.length <= expected.length);
  } while (token !== null);
  assert.deepEqual(collected, expected);
  assert.equal(available(client.objects.get({ object_id: pending.object_id })), null);
  assert.equal(f.traffic.length, before);
  const published = success(
    (await writer.objects.upload(pending, new Blob([bytes])).send()).attempt,
  );
  await ready(client, published.commit_cursor);
  const refreshed = available(client.tasks.objects({ task_id: created.task_id }));
  assert.deepEqual(
    available(refreshed.page()).items.map(({ object_id }) => object_id),
    [...expected, pending.object_id].sort(),
  );
  assert.equal(available(query.page()).items[0].object_id, expected[0]);
  query.close();
  refreshed.close();
});

async function observation(f) {
  const observation_id = uuid(),
    publisher_id = uuid();
  return call(f, 'create_observation', {
    request_id: uuid(),
    observation_id,
    publisher_id,
    report: {
      dataset_id: f.datasetId,
      entity_id: observation_id,
      origin: { kind: 'publisher', publisher_id },
      report_id: uuid(),
      sequence: '1',
      generated_at: null,
      mode: 'current',
      sections: {
        type: {
          state: 'value',
          classification: 'state_until_changed',
          observed_at: null,
          value: { kind: 'ground_vehicle' },
        },
      },
    },
  });
}
async function object(f, assetId) {
  const content = new TextEncoder().encode('picture object');
  const descriptor = {
    request_id: uuid(),
    object_id: uuid(),
    byte_length: String(content.length),
    sha256: createHash('sha256').update(content).digest('hex'),
    content_type: 'text/plain',
    metadata: { name: 'retained', associations: [{ kind: 'asset', id: assetId }] },
  };
  const form = new FormData();
  form.append('descriptor', JSON.stringify(descriptor));
  form.append('file', new Blob([content], { type: 'text/plain' }), 'picture.txt');
  const response = await fetch(`${f.proxyUrl}/objects`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${f.apiKey}`,
      'atlas-dataset-id': f.datasetId,
      'atlas-protocol-version': '0.4.0',
    },
    body: form,
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}

test(
  'Full stages all five kinds, catches up through fixed handoff, and routes ordinary reads locally',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const admin = await connected(f);
    const asset = await register(admin, 'Straße');
    const feature = success(
      (
        await admin.geofeatures
          .create({
            request_id: uuid(),
            geofeature_id: uuid(),
            alias: 'marker',
            geometry: { type: 'Point', coordinates: [0, 0] },
          })
          .send()
      ).attempt,
    ).data;
    const created = success((await admin.tasks.create(task(asset.id)).send()).attempt);
    const pair = await observation(f);
    const uploaded = await object(f, asset.id);
    const reached = barrier(),
      release = barrier();
    t.after(() => release.resolve());
    f.wssOnce('handoff_complete', async ({ send }) => {
      reached.resolve();
      await release.promise;
      send();
    });
    const client = await connected(f, { mode: 'full', picture: { pageSize: 1 } });
    assert.equal(client.assets.get({ asset_id: asset.id }).kind, 'unavailable');
    await reached.promise;
    assert.equal(client.tasks.get({ task_id: created.data.task_id }).kind, 'unavailable');
    release.resolve();
    await ready(client, uploaded.commit_cursor);
    const count = f.traffic.length;
    assert.equal(available(client.assets.byAlias({ alias: 'STRASSE' })).id, asset.id);
    assert.equal(available(client.assets.status({ asset_id: asset.id })).asset_id, asset.id);
    assert.equal(
      available(client.tracks.get({ track_id: pair.data.track.id })).id,
      pair.data.track.id,
    );
    assert.equal(available(client.geofeatures.byAlias({ alias: 'MARKER' })).id, feature.id);
    assert.equal(
      available(client.tasks.get({ task_id: created.data.task_id })).task_id,
      created.data.task_id,
    );
    assert.equal(
      available(client.objects.get({ object_id: uploaded.data.object_id })).metadata.name,
      'retained',
    );
    for (const resources of [
      client.assets,
      client.tracks,
      client.geofeatures,
      client.tasks,
      client.objects,
    ]) {
      const query = available(resources.list({}));
      assert.equal(available(query.page()).items.length, 1);
      query.close();
    }
    const objects = available(client.assets.objects({ asset_id: asset.id }));
    assert.equal(available(objects.page()).items[0].object_id, uploaded.data.object_id);
    objects.close();
    assert.equal(available(client.picture.changedSince(client.picture.cursor)).commits.length, 0);
    assert.equal(f.traffic.length, count);
    success(await client.http.assets.get({ asset_id: asset.id }));
    success(await client.observations.get({ observation_id: pair.data.observation.id }));
    assert.equal(f.traffic.length, count + 2);
  },
);

test(
  'Full writes cannot advance the picture before the complete feed commit and subscribers see atomic images',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const client = await connected(f, { mode: 'full' });
    await ready(client);
    const asset = await register(client, 'atomic');
    await until(
      () => client.assets.get({ asset_id: asset.id }).value?.id === asset.id,
      'Asset feed image missing',
    );
    const before = client.picture.status.cursor,
      boundary = client.picture.cursor;
    const subscriber = client.picture.subscribe();
    assert.equal((await subscriber.next()).value.kind, 'status');
    const reached = barrier(),
      release = barrier();
    t.after(() => release.resolve());
    f.wssOnce('change_batch', async ({ frame, send }) => {
      reached.resolve(frame);
      await release.promise;
      send();
    });
    const created = success((await client.tasks.create(task(asset.id)).send()).attempt);
    const frame = await reached.promise;
    assert.deepEqual(frame.data.changes.map((change) => change.resource_kind).sort(), [
      'asset',
      'task',
    ]);
    assert.equal(client.picture.status.cursor, before);
    assert.equal(available(client.tasks.get({ task_id: created.data.task_id })), null);
    release.resolve();
    const event = (await subscriber.next()).value;
    assert.equal(event.kind, 'commit');
    assert.equal(event.commit.coreCursor, created.commit_cursor);
    assert.equal(
      available(client.tasks.get({ task_id: created.data.task_id })).task_id,
      created.data.task_id,
    );
    assert.deepEqual(
      available(client.assets.get({ asset_id: asset.id })).task_queue.requested_task_ids,
      [created.data.task_id],
    );
    assert.equal(available(client.picture.changedSince(boundary)).commits.length, 1);
    subscriber.close();
    const cancellation = success(
      (await client.tasks.cancel({ task_id: created.data.task_id, request_id: uuid() }).send())
        .attempt,
    );
    await ready(client, cancellation.commit_cursor);
    const cancelled = available(
      client.tasks.query({ filters: { states: ['cancellation_requested'] } }),
    );
    assert.deepEqual(
      available(cancelled.page()).items.map((image) => image.task_id),
      [created.data.task_id],
    );
    cancelled.close();
  },
);

test(
  'frozen pages retain old images, capture and filters while live commits advance; expiry and foreign tokens fail explicitly',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const admin = await connected(f);
    const a = await register(admin, 'Straße'),
      b = await register(admin, 'second');
    const client = await connected(f, { mode: 'full', picture: { queryLifetimeMs: 2000 } });
    await ready(client);
    const query = available(client.assets.query({ page_size: 1 }));
    const first = available(query.page());
    const secondId = [a.id, b.id].sort()[1];
    const removed = success(
      (await client.assets.delete({ asset_id: secondId, request_id: uuid() }).send()).attempt,
    );
    await ready(client, removed.commit_cursor);
    const second = available(query.page(first.nextPageToken));
    assert.equal(second.items[0].id, secondId);
    assert.equal(second.cursor, first.cursor);
    assert.equal(second.coreCursor, first.coreCursor);
    assert.equal(second.capturedAt, first.capturedAt);
    assert.equal(available(client.assets.get({ asset_id: secondId })), null);
    const filtered = available(client.assets.query({ filters: { aliases: ['STRASSE'] } }));
    assert.deepEqual(
      available(filtered.page()).items.map((image) => image.id),
      secondId === a.id ? [] : [a.id],
    );
    const empty = available(client.assets.query({ filters: { ids: [] } }));
    assert.deepEqual(available(empty.page()).items, []);
    assert.equal(filtered.page(first.nextPageToken).code, 'invalid_token');
    const retainedId = first.items[0].id;
    const edited = success(
      (
        await client.assets
          .update({
            asset_id: retainedId,
            request_id: uuid(),
            expected_edit_revision: '0',
            alias: 'edited',
          })
          .send()
      ).attempt,
    );
    await ready(client, edited.commit_cursor);
    assert.equal(available(client.assets.get({ asset_id: retainedId })).alias, 'edited');
    assert.equal(available(query.page()).items[0].alias, first.items[0].alias);
    const starts = f.traffic.length;
    await delay(2100);
    assert.equal(query.page().code, 'expired_token');
    assert.equal(f.traffic.length, starts);
    filtered.close();
    empty.close();
  },
);

test(
  'whole-commit journal replay joins live atomically and slow subscribers report a gap without pinning queries',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const client = await connected(f, { mode: 'full', picture: { journalCommits: 2 } });
    await ready(client);
    const query = available(client.assets.query({})),
      page = available(query.page());
    const slow = client.picture.subscribe(page.cursor);
    assert.equal((await slow.next()).value.kind, 'status');
    const commits = [];
    for (let i = 0; i < 3; i++) {
      const result = success(
        (await client.assets.register(registration(`journal-${i}`)).send()).attempt,
      );
      await ready(client, result.commit_cursor);
      commits.push(client.picture.cursor);
    }
    assert.equal(client.picture.changedSince(page.cursor).kind, 'gap');
    assert.deepEqual((await slow.next()).value, {
      kind: 'gap',
      reason: 'pruned',
      status: client.picture.status,
    });
    assert.equal((await slow.next()).done, true);
    assert.deepEqual(available(query.page()).items, []);
    const joined = client.picture.subscribe(commits[0]);
    assert.equal((await joined.next()).value.kind, 'status');
    assert.equal((await joined.next()).value.commit.cursor, commits[1]);
    const pending = joined.next();
    assert.equal((await pending).value.commit.cursor, commits[2]);
    const live = joined.next();
    const next = success(
      (await client.assets.register(registration('journal-live')).send()).attempt,
    );
    assert.equal((await live).value.commit.coreCursor, next.commit_cursor);
    joined.close();
    query.close();
  },
);

test(
  'authorization recovery replays missed writes and deletions to existing subscribers while frozen queries stay local',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const admin = await connected(f);
    const key = { request_id: uuid(), api_key_id: uuid(), secret: secret() };
    success((await admin.apiKeys.create(key).send()).attempt);
    let credential = key.secret;
    const client = await connected(f, { mode: 'full', credentials: () => credential });
    await ready(client);
    const a = await register(admin, 'retained'),
      b = await register(admin, 'removed while paused');
    await until(() => client.assets.get({ asset_id: b.id }).value?.id === b.id, 'Asset missing');
    const query = available(client.assets.query({})),
      original = available(query.page());
    const generation = client.picture.status.generation,
      snapshots = f.traffic.filter((entry) => entry.path === '/messages/read_snapshot').length;
    const subscription = client.picture.subscribe();
    await subscription.next();
    success(
      (await admin.apiKeys.revoke({ request_id: uuid(), api_key_id: key.api_key_id }).send())
        .attempt,
    );
    await until(
      () => client.picture.status.kind === 'authorization-required',
      'Revocation not observed',
    );
    assert.equal((await subscription.next()).value.status.kind, 'authorization-required');
    const count = f.traffic.length,
      sockets = f.wssTraffic.length;
    assert.equal(client.assets.get({ asset_id: a.id }).stale, true);
    assert.equal(query.page().stale, true);
    assert.equal(available(query.page()).cursor, original.cursor);
    assert.equal((await client.http.assets.get({ asset_id: a.id })).code, 'authorization_required');
    assert.equal((await client.recover()).code, 'unchanged_credential');
    await delay(600);
    assert.equal(f.traffic.length, count);
    assert.equal(f.wssTraffic.length, sockets);
    const updated = success(
      (
        await admin.assets
          .update({
            asset_id: a.id,
            request_id: uuid(),
            expected_edit_revision: '0',
            alias: 'updated while paused',
          })
          .send()
      ).attempt,
    );
    const created = success(
      (await admin.assets.register(registration('created while paused')).send()).attempt,
    );
    const removed = success(
      (await admin.assets.delete({ asset_id: b.id, request_id: uuid() }).send()).attempt,
    );
    const pausedTraffic = f.traffic.length;
    assert.equal(available(client.assets.get({ asset_id: a.id })).alias, 'retained');
    assert.equal(available(client.assets.get({ asset_id: b.id })).alias, 'removed while paused');
    assert.equal(available(client.assets.get({ asset_id: created.data.asset.id })), null);
    assert.deepEqual(available(client.picture.changedSince(original.cursor)).commits, []);
    assert.deepEqual(
      available(query.page())
        .items.map((item) => item.alias)
        .sort(),
      ['removed while paused', 'retained'],
    );
    assert.equal(f.traffic.length, pausedTraffic);
    assert.equal(f.wssTraffic.length, sockets);
    credential = f.apiKey;
    success(await client.recover());
    await ready(client, removed.commit_cursor);
    const recoveredTraffic = f.traffic.length;
    assert.equal(client.assets.get({ asset_id: a.id }).stale, false);
    assert.equal(available(client.assets.get({ asset_id: a.id })).alias, 'updated while paused');
    assert.equal(
      available(client.assets.get({ asset_id: created.data.asset.id })).alias,
      'created while paused',
    );
    assert.equal(available(client.assets.get({ asset_id: b.id })), null);
    assert.equal(client.picture.status.generation, generation);
    assert.equal(available(query.page()).cursor, original.cursor);
    assert.deepEqual(
      available(query.page())
        .items.map((item) => item.alias)
        .sort(),
      ['removed while paused', 'retained'],
    );
    const missed = available(client.picture.changedSince(original.cursor));
    assert.deepEqual(
      missed.commits.map((commit) => commit.coreCursor),
      [updated.commit_cursor, created.commit_cursor, removed.commit_cursor],
    );
    assert.deepEqual(
      missed.commits.map((commit) =>
        commit.changes.map((change) => [change.kind, change.resource_kind, change.resource_id]),
      ),
      [
        [['put', 'asset', a.id]],
        [['put', 'asset', created.data.asset.id]],
        [['delete', 'asset', b.id]],
      ],
    );
    const resumed = await subscription.next();
    assert.equal(resumed.value.kind, 'status');
    assert.equal(resumed.value.status.kind, 'synchronized');
    for (const expected of [updated, created, removed]) {
      const event = await subscription.next();
      assert.equal(event.value.kind, 'commit');
      assert.equal(event.value.commit.coreCursor, expected.commit_cursor);
      assert.equal(event.value.stale, false);
    }
    assert.equal(f.traffic.length, recoveredTraffic);
    assert.equal(
      f.traffic.filter((entry) => entry.path === '/messages/read_snapshot').length,
      snapshots,
    );
    const live = success(
      (
        await admin.assets
          .update({
            asset_id: created.data.asset.id,
            request_id: uuid(),
            expected_edit_revision: '0',
            alias: 'live after recovery',
          })
          .send()
      ).attempt,
    );
    await ready(client, live.commit_cursor);
    const event = await subscription.next();
    assert.equal(event.value.kind, 'commit');
    assert.equal(event.value.commit.coreCursor, live.commit_cursor);
    assert.equal(
      available(client.assets.get({ asset_id: created.data.asset.id })).alias,
      'live after recovery',
    );
    subscription.close();
    query.close();
  },
);

test(
  'same-Dataset restart and ambiguous WSS close resume complete cursors without allocating another capture',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const client = await connected(f, { mode: 'full' });
    await ready(client);
    const a = await register(client, 'restart');
    await until(() => client.assets.get({ asset_id: a.id }).value?.id === a.id, 'Asset missing');
    const generation = client.picture.status.generation;
    const snapshots = f.traffic.filter((entry) => entry.path === '/messages/read_snapshot').length;
    for (const code of [1008, 1009, 1013]) {
      const before = f.wssTraffic.filter((entry) => entry.type === 'authenticate').length;
      f.closeFeeds(code);
      await until(() => client.picture.status.kind === 'disconnected', 'Closure not observed');
      assert.equal(client.state.kind, 'ready');
      assert.equal(client.assets.get({ asset_id: a.id }).stale, true);
      await until(
        () => f.wssTraffic.filter((entry) => entry.type === 'authenticate').length > before,
        'No reconnect',
      );
      await ready(client);
    }
    await f.restart();
    await until(() => client.picture.status.kind !== 'synchronized', 'Restart not observed');
    await ready(client);
    assert.equal(client.picture.status.generation, generation);
    assert.equal(available(client.assets.get({ asset_id: a.id })).id, a.id);
    assert.equal(
      f.traffic.filter((entry) => entry.path === '/messages/read_snapshot').length,
      snapshots,
    );
    assert.equal(
      f.traffic.some((entry) => entry.path === '/messages/read_changes'),
      false,
    );
  },
);

test(
  'a retiring native socket blocks replacement until physical close then resumes complete staging',
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const sockets = observeSockets(t);
    let peer;
    f.wssOnce('handoff_complete', ({ to }) => {
      peer = to;
      peer._socket.pause();
    });
    const client = createClient({
      baseUrl: f.proxyUrl,
      credentials: () => f.apiKey,
      mode: 'full',
      timeoutMs: 500,
    });
    try {
      success(await client.connect());
      await until(() => peer && client.picture.status.reason === 'deadline', 'No handoff deadline');
      await delay(1300);
      assert.equal(sockets.length, 1);
      assert.equal(sockets[0].readyState, WebSocket.CLOSING);
      assert.equal(client.assets.get({ asset_id: uuid() }).kind, 'unavailable');
      const requests = f.traffic.length;
      await delay(300);
      assert.equal(sockets.length, 1);
      assert.equal(f.traffic.length, requests);
      peer._socket.resume();
      await until(() => sockets[0].readyState === WebSocket.CLOSED, 'Native close not confirmed');
      await ready(client);
      assert.equal(sockets.length, 2);
      assert.equal(f.traffic.filter((entry) => entry.path === '/messages/read_snapshot').length, 1);
      const asset = await register(client, 'after-retirement');
      await until(
        () => client.assets.get({ asset_id: asset.id }).value?.id === asset.id,
        'Live feed did not resume',
      );
      await client.close();
      assert.ok(sockets.every((socket) => socket.readyState === WebSocket.CLOSED));
    } finally {
      peer?._socket.resume();
      await client.close().catch(() => undefined);
    }
  },
);

test(
  'close interrupts a stalled native socket retirement and retains its bounded cleanup failure',
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    const sockets = observeSockets(t);
    let peer;
    f.wssOnce('handoff_complete', ({ to }) => {
      peer = to;
      peer._socket.pause();
    });
    const client = createClient({
      baseUrl: f.proxyUrl,
      credentials: () => f.apiKey,
      mode: 'full',
      timeoutMs: 500,
    });
    try {
      success(await client.connect());
      await until(() => peer && client.picture.status.reason === 'deadline', 'No handoff deadline');
      await delay(1300);
      assert.equal(sockets[0].readyState, WebSocket.CLOSING);
      const requests = f.traffic.length;
      const started = performance.now();
      const closing = client.close();
      assert.equal(client.close(), closing);
      await assert.rejects(
        closing,
        (error) =>
          error instanceof ClientCloseError &&
          error.errors.some((failure) => failure.code === 'deadline'),
      );
      assert.ok(
        performance.now() - started < 2500,
        'Shutdown waited for unconfirmed physical close',
      );
      assert.equal(sockets[0].readyState, WebSocket.CLOSING);
      assert.equal(sockets.length, 1);
      assert.equal(client.state.kind, 'closed');
      assert.equal(client.picture.status.kind, 'stopped');
      peer._socket.resume();
      await until(() => sockets[0].readyState === WebSocket.CLOSED, 'Native close not confirmed');
      await delay(350);
      assert.equal(sockets.length, 1);
      assert.equal(f.traffic.length, requests);
      await assert.rejects(client.close(), ClientCloseError);
    } finally {
      peer?._socket.resume();
      await client.close().catch(() => undefined);
    }
  },
);

test(
  'authorization interrupts socket retirement without traffic and recovery waits for the old physical close',
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const admin = await connected(f);
    const asset = await register(admin, 'stale-through-retirement');
    const key = { request_id: uuid(), api_key_id: uuid(), secret: secret() };
    success((await admin.apiKeys.create(key).send()).attempt);
    const sockets = observeSockets(t);
    let credential = key.secret;
    let peer;
    const client = createClient({
      baseUrl: f.proxyUrl,
      credentials: () => credential,
      mode: 'full',
      timeoutMs: 500,
    });
    try {
      success(await client.connect());
      await ready(client);
      const query = available(client.assets.query({}));
      const boundary = client.picture.cursor;
      const generation = client.picture.status.generation;
      f.wssOnce('handoff_complete', ({ to }) => {
        peer = to;
        peer._socket.pause();
      });
      f.closeFeeds();
      await until(() => peer && client.picture.status.reason === 'deadline', 'No handoff deadline');
      await delay(1300);
      assert.equal(sockets.length, 2);
      assert.equal(sockets[1].readyState, WebSocket.CLOSING);
      success(
        (await admin.apiKeys.revoke({ request_id: uuid(), api_key_id: key.api_key_id }).send())
          .attempt,
      );
      await client.http.assets.get({ asset_id: asset.id });
      await until(() => client.state.kind === 'authorization-required', 'No authority rejection');
      const requests = f.traffic.length;
      const frames = f.wssTraffic.filter((entry) => entry.direction === 'client').length;
      await delay(1300);
      assert.equal(client.picture.status.kind, 'authorization-required');
      assert.equal(client.assets.get({ asset_id: asset.id }).stale, true);
      assert.equal(query.page().stale, true);
      assert.equal(available(query.page()).cursor, boundary);
      assert.equal(
        (await client.http.assets.get({ asset_id: asset.id })).code,
        'authorization_required',
      );
      assert.equal((await client.recover()).code, 'unchanged_credential');
      assert.equal(f.traffic.length, requests);
      assert.equal(f.wssTraffic.filter((entry) => entry.direction === 'client').length, frames);
      credential = f.apiKey;
      success(await client.recover());
      const recoveredRequests = f.traffic.length;
      await delay(1300);
      assert.equal(sockets.length, 2);
      assert.equal(sockets[1].readyState, WebSocket.CLOSING);
      assert.equal(f.traffic.length, recoveredRequests);
      peer._socket.resume();
      await until(() => sockets[1].readyState === WebSocket.CLOSED, 'Native close not confirmed');
      await ready(client);
      assert.equal(sockets.length, 3);
      assert.equal(client.picture.status.generation, generation);
      assert.equal(client.assets.get({ asset_id: asset.id }).stale, false);
      assert.equal(available(query.page()).cursor, boundary);
      assert.equal(f.traffic.filter((entry) => entry.path === '/messages/read_snapshot').length, 1);
      query.close();
      await assert.rejects(
        client.close(),
        (error) =>
          error instanceof ClientCloseError &&
          error.errors.some((failure) => failure.code === 'deadline'),
      );
    } finally {
      peer?._socket.resume();
      await client.close().catch(() => undefined);
    }
  },
);

test(
  'capacity loss invalidates readable data and tokens until explicit retry; query refusal alone keeps the picture',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const client = await connected(f, { mode: 'full', picture: { images: 1, queries: 1 } });
    await ready(client);
    assert.throws(() => client.picture.retry({ bytes: 1 }), { code: 'invalid_options' });
    const empty = available(client.assets.query({}));
    assert.equal(client.assets.query({}).code, 'capacity');
    assert.equal(client.assets.get({ asset_id: uuid() }).kind, 'available');
    const a = await register(client, 'capacity');
    await until(() => client.assets.get({ asset_id: a.id }).value?.id === a.id, 'Asset missing');
    success((await client.tasks.create(task(a.id)).send()).attempt);
    await until(() => client.picture.status.kind === 'resource-limited', 'No capacity stop');
    assert.equal(client.assets.get({ asset_id: a.id }).kind, 'unavailable');
    assert.equal(empty.page().code, 'invalid_token');
    const count = f.traffic.length;
    await delay(700);
    assert.equal(f.traffic.length, count);
    client.picture.retry({ images: 10 });
    await ready(client);
    assert.equal(available(client.assets.get({ asset_id: a.id })).id, a.id);
    const tasks = available(client.tasks.query({}));
    assert.equal(available(tasks.page()).items.length, 1);
    tasks.close();
  },
);

test('close cancels queued capacity recovery without starting transport or reporting cleanup failure', async (t) => {
  const f = await fixture(t);
  const admin = await connected(f);
  await register(admin, 'first capacity image');
  await register(admin, 'second capacity image');
  const sockets = observeSockets(t);
  const client = createClient({
    baseUrl: f.proxyUrl,
    credentials: () => f.apiKey,
    mode: 'full',
    picture: { images: 1 },
  });
  try {
    success(await client.connect());
    await until(() => client.picture.status.kind === 'resource-limited', 'No capacity stop');
    await delay(700);
    const requests = f.traffic.length;
    const socketCount = sockets.length;
    client.picture.retry({ images: 10 });
    const closing = client.close();
    assert.equal(client.close(), closing);
    await closing;
    assert.equal(client.state.kind, 'closed');
    assert.equal(client.picture.status.kind, 'stopped');
    assert.equal(f.traffic.length, requests);
    assert.equal(sockets.length, socketCount);
    assert.throws(() => client.picture.retry(), { code: 'closed' });
  } finally {
    await client.close().catch(() => undefined);
  }
});

test(
  'snapshot/feed races publish only the fixed handoff and later writes remain independent live commits',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t),
      admin = await connected(f);
    const captured = barrier(),
      releaseCapture = barrier(),
      handoff = barrier(),
      releaseHandoff = barrier(),
      live = barrier(),
      releaseLive = barrier();
    t.after(() => {
      releaseCapture.resolve();
      releaseHandoff.resolve();
      releaseLive.resolve();
    });
    f.once('/messages/read_snapshot', async ({ forward }) => {
      captured.resolve();
      await releaseCapture.promise;
      forward();
    });
    f.wssOnce('handoff_complete', async ({ frame, send }) => {
      handoff.resolve(frame);
      await releaseHandoff.promise;
      send();
    });
    const client = await connected(f, { mode: 'full' });
    await captured.promise;
    const first = success((await admin.assets.register(registration('caught-up')).send()).attempt);
    releaseCapture.resolve();
    const fixed = await handoff.promise;
    assert.equal(fixed.data.handoff_cursor, first.commit_cursor);
    assert.equal(client.assets.get({ asset_id: first.data.asset.id }).kind, 'unavailable');
    f.wssOnce('change_batch', async ({ send }) => {
      live.resolve();
      await releaseLive.promise;
      send();
    });
    const second = success((await admin.assets.register(registration('live')).send()).attempt);
    releaseHandoff.resolve();
    await live.promise;
    await ready(client, first.commit_cursor);
    assert.equal(
      available(client.assets.get({ asset_id: first.data.asset.id })).alias,
      'caught-up',
    );
    assert.equal(available(client.assets.get({ asset_id: second.data.asset.id })), null);
    const boundary = client.picture.cursor;
    assert.deepEqual(available(client.picture.changedSince(boundary)).commits, []);
    releaseLive.resolve();
    await ready(client, second.commit_cursor);
    assert.equal(available(client.picture.changedSince(boundary)).commits.length, 1);
  },
);

test(
  'Core replay expiry rebuilds complete data and invalidates old tokens; Reset changes Dataset',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, { replayBytes: 0 }),
      admin = await connected(f);
    const a = await register(admin, 'before-reset'),
      b = await register(admin, 'deleted during outage');
    const client = await connected(f, { mode: 'full', picture: { pageSize: 1 } });
    await ready(client);
    const query = available(client.assets.query({}));
    const cursor = client.picture.cursor,
      generation = client.picture.status.generation;
    const resume = barrier(),
      release = barrier();
    let reconnecting = false,
      rebuilding = false;
    f.once('/messages/read_snapshot', async ({ forward }) => {
      rebuilding = true;
      await release.promise;
      forward();
    });
    f.wssOnce('authenticated', async ({ send }) => {
      reconnecting = true;
      await resume.promise;
      send();
    });
    let refusal;
    f.wssOnce('error', ({ frame, send }) => {
      refusal = frame.error.code;
      send();
    });
    f.closeFeeds();
    let c;
    try {
      await until(() => reconnecting, 'No reconnect authentication');
      success(
        (
          await admin.assets
            .update({
              asset_id: a.id,
              request_id: uuid(),
              expected_edit_revision: '0',
              alias: 'after-outage',
            })
            .send()
        ).attempt,
      );
      success((await admin.assets.delete({ asset_id: b.id, request_id: uuid() }).send()).attempt);
      c = await register(admin, 'created during outage');
      resume.resolve();
      await until(() => refusal !== undefined, 'Core did not refuse the expired replay cursor');
      assert.equal(refusal, 'cursor_expired');
      await until(() => rebuilding, 'Expired replay did not start a replacement snapshot');
      assert.equal(client.assets.get({ asset_id: a.id }).kind, 'unavailable');
      assert.equal(query.page().code, 'invalid_token');
      assert.equal(client.picture.changedSince(cursor).reason, 'invalid_cursor');
    } finally {
      resume.resolve();
      release.resolve();
    }
    await ready(client);
    assert.ok(client.picture.status.generation > generation);
    assert.equal(available(client.assets.get({ asset_id: a.id })).alias, 'after-outage');
    assert.equal(available(client.assets.get({ asset_id: b.id })), null);
    assert.equal(available(client.assets.get({ asset_id: c.id })).alias, 'created during outage');
    const replacement = available(client.assets.query({}));
    assert.deepEqual(
      available(replacement.page())
        .items.map((item) => item.id)
        .sort(),
      [a.id, c.id].sort(),
    );
    replacement.close();
    const oldDataset = client.picture.status.datasetId;
    const oldQuery = available(client.assets.query({}));
    const releaseReset = barrier();
    let resetCapture = false;
    f.once('/messages/read_snapshot', async ({ forward }) => {
      resetCapture = true;
      await releaseReset.promise;
      forward();
    });
    try {
      await f.reset();
      await until(() => resetCapture, 'Reset did not start a replacement snapshot');
      assert.equal(client.assets.get({ asset_id: a.id }).kind, 'unavailable');
      assert.equal(oldQuery.page().code, 'invalid_token');
    } finally {
      releaseReset.resolve();
    }
    await ready(client);
    assert.notEqual(client.picture.status.datasetId, oldDataset);
    assert.equal(available(client.assets.get({ asset_id: a.id })), null);
  },
);

test(
  'only a correlated pre-auth unauthorized frame rejects the accepted key',
  { timeout: 30_000 },
  async (t) => {
    for (const correlation of ['absent', 'different', 'matching'])
      await t.test(correlation, async (t) => {
        const f = await fixture(t);
        f.wssOnce('authenticated', ({ frame, send, to }) => {
          send({
            type: 'error',
            dataset_id: frame.dataset_id,
            protocol_version: frame.protocol_version,
            ...(correlation === 'absent'
              ? {}
              : { request_id: correlation === 'matching' ? frame.request_id : uuid() }),
            error: { code: 'unauthorized', message: 'unauthorized', request_id: uuid() },
          });
          to.close(1008);
        });
        const client = await connected(f, { mode: 'full' });
        if (correlation === 'matching') {
          await until(
            () => client.state.kind === 'authorization-required',
            'Correlated rejection not observed',
          );
          const count = f.traffic.length;
          await delay(500);
          assert.equal(f.traffic.length, count);
          assert.equal(client.picture.status.kind, 'authorization-required');
        } else {
          await ready(client);
          assert.equal(client.state.kind, 'ready');
          assert.equal(f.wssTraffic.filter((entry) => entry.type === 'authenticate').length, 2);
          assert.equal(
            f.traffic.filter((entry) => entry.path === '/messages/read_snapshot').length,
            1,
          );
        }
      });
  },
);

test(
  'duplicate feed commits are harmless and conflicting copies trigger replacement before exposing corruption',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t),
      client = await connected(f, { mode: 'full' });
    await ready(client);
    const boundary = client.picture.cursor;
    f.wssOnce('change_batch', ({ send }) => {
      send();
      send();
    });
    const a = await register(client, 'original');
    await until(() => client.assets.get({ asset_id: a.id }).value?.id === a.id, 'Asset missing');
    await delay(50);
    assert.equal(available(client.picture.changedSince(boundary)).commits.length, 1);
    const generation = client.picture.status.generation;
    f.wssOnce('change_batch', ({ frame, send }) => {
      send();
      const conflicting = structuredClone(frame);
      const asset = conflicting.data.changes.find((change) => change.resource_kind === 'asset');
      asset.image.alias = 'corrupt';
      send(conflicting);
    });
    const b = await register(client, 'second');
    await until(
      () => client.picture.status.generation > generation,
      'Conflicting commit did not invalidate',
    );
    await ready(client);
    assert.equal(available(client.assets.get({ asset_id: b.id })).alias, 'second');
  },
);

test(
  'binary frames and incomplete commits invalidate the picture without applying a partial batch',
  { timeout: 30_000 },
  async (t) => {
    for (const kind of ['binary', 'invalid-item'])
      await t.test(kind, async (t) => {
        const f = await fixture(t),
          client = await connected(f, { mode: 'full' });
        await ready(client);
        const a = await register(client, 'framing');
        await until(
          () => client.assets.get({ asset_id: a.id }).value?.id === a.id,
          'Asset missing',
        );
        const query = available(client.assets.query({}));
        const generation = client.picture.status.generation;
        const reached = barrier(),
          release = barrier();
        t.after(() => release.resolve());
        f.once('/messages/read_snapshot', async ({ forward }) => {
          reached.resolve();
          await release.promise;
          forward();
        });
        f.wssOnce('change_batch', ({ frame, send }) => {
          if (kind === 'binary') send(frame, true);
          else {
            const bad = structuredClone(frame);
            bad.data.changes.find((change) => change.resource_kind === 'task').version = '99';
            send(bad);
          }
        });
        const created = success((await client.tasks.create(task(a.id)).send()).attempt);
        await reached.promise;
        assert.ok(client.picture.status.generation > generation);
        assert.equal(client.tasks.get({ task_id: created.data.task_id }).kind, 'unavailable');
        assert.equal(query.page().code, 'invalid_token');
        release.resolve();
        await ready(client);
        assert.equal(
          available(client.tasks.get({ task_id: created.data.task_id })).task_id,
          created.data.task_id,
        );
      });
  },
);

test(
  'repeated captures expired by Core restart use bounded backoff and retain exact allocation facts after a lost reply',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t),
      admin = await connected(f);
    await register(admin, 'page-a');
    await register(admin, 'page-b');
    const diagnostics = [],
      originals = [],
      attempts = [];
    f.once('/messages/read_snapshot', ({ request, outgoing }) => {
      originals.push(JSON.parse(request));
      outgoing.destroy();
    });
    f.once('/messages/read_snapshot', ({ request, forward }) => {
      originals.push(JSON.parse(request));
      forward();
    });
    const client = await connected(f, {
      mode: 'full',
      picture: { pageSize: 1 },
      diagnostics: { mode: 'debug', observer: (event) => diagnostics.push(event) },
    });
    await ready(client);
    assert.deepEqual(originals[0], originals[1]);
    for (let i = 0; i < 2; i++) {
      f.wssOnce('subscribed', ({ frame, send }) => {
        send();
        send({
          type: 'gap',
          dataset_id: frame.dataset_id,
          protocol_version: frame.protocol_version,
          data: {
            subscription_id: frame.data.subscription_id,
            reason: 'cursor_expired',
            earliest_recoverable_cursor: frame.data.handoff_cursor,
          },
        });
      });
      f.once('/messages/read_snapshot', async ({ forward }) => {
        attempts.push(performance.now());
        await f.restart();
        forward();
      });
      const generation = client.picture.status.generation;
      f.closeFeeds();
      await until(() => client.picture.status.generation > generation, 'No rebuild');
      await ready(client);
    }
    await until(
      () =>
        diagnostics.some(
          (event) => event.kind === 'synchronization' && event.reason === 'expired_capture',
        ),
      'Missing expired_capture reason',
    );
    assert.equal(attempts.length, 2);
    assert.ok(attempts[1] - attempts[0] >= 250);
    assert.ok(diagnostics.some((event) => event.kind === 'connection' && event.backoffMs >= 250));
    assert.ok(diagnostics.every((event) => event.mode === 'full'));
  },
);

test(
  'capture lifetime ends after sixty seconds without page extensions and recovery backs off',
  { timeout: 85_000 },
  async (t) => {
    const f = await fixture(t),
      admin = await connected(f);
    await register(admin, 'expiry-a');
    await register(admin, 'expiry-b');
    const reached = barrier(),
      diagnostics = [];
    f.once('/messages/read_snapshot', async ({ forward }) => {
      reached.resolve();
      await delay(61_000);
      forward();
    });
    const client = await connected(f, {
      mode: 'full',
      timeoutMs: 120_000,
      picture: { pageSize: 1 },
      diagnostics: { mode: 'debug', observer: (event) => diagnostics.push(event) },
    });
    await reached.promise;
    assert.equal(client.assets.list({}).kind, 'unavailable');
    await until(
      () => client.picture.status.kind === 'synchronized',
      'Expired capture never recovered',
      75_000,
    );
    assert.ok(
      diagnostics.some(
        (event) => event.kind === 'synchronization' && event.reason === 'expired_capture',
      ),
    );
    assert.ok(diagnostics.some((event) => event.kind === 'connection' && event.backoffMs >= 250));
    const query = available(client.assets.list({}));
    assert.equal(available(query.page()).items.length, 2);
    query.close();
  },
);

test(
  'a lost capture release retains its identity and blocks replacement until release acknowledgment',
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t),
      requests = [];
    f.once('/messages/release_snapshot', ({ request, outgoing }) => {
      requests.push(JSON.parse(request));
      outgoing.destroy();
    });
    const client = await connected(f, { mode: 'full' });
    await ready(client);
    const reached = barrier(),
      release = barrier();
    t.after(() => release.resolve());
    f.once('/messages/release_snapshot', async ({ request, forward }) => {
      requests.push(JSON.parse(request));
      reached.resolve();
      await release.promise;
      forward();
    });
    f.wssOnce('subscribed', ({ frame, send }) => {
      send();
      send({
        type: 'gap',
        dataset_id: frame.dataset_id,
        protocol_version: frame.protocol_version,
        data: {
          subscription_id: frame.data.subscription_id,
          reason: 'cursor_expired',
          earliest_recoverable_cursor: frame.data.handoff_cursor,
        },
      });
    });
    f.closeFeeds();
    await reached.promise;
    assert.equal(f.traffic.filter((entry) => entry.path === '/messages/read_snapshot').length, 1);
    assert.deepEqual(requests[0], requests[1]);
    assert.equal(client.assets.get({ asset_id: uuid() }).kind, 'unavailable');
    release.resolve();
    await ready(client);
    assert.equal(f.traffic.filter((entry) => entry.path === '/messages/read_snapshot').length, 2);
  },
);

test(
  'close aborts an in-flight capture, invalidates local handles and owns all reconnect timers',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t),
      reached = barrier(),
      release = barrier();
    t.after(() => release.resolve());
    f.once('/messages/read_snapshot', async ({ forward }) => {
      reached.resolve();
      await release.promise;
      forward();
    });
    const client = await connected(f, { mode: 'full' });
    await reached.promise;
    const started = performance.now();
    await client.close();
    assert.ok(performance.now() - started < 2000);
    assert.equal(client.picture.status.kind, 'stopped');
    assert.equal(client.state.kind, 'closed');
    release.resolve();
    const count = f.traffic.length;
    await delay(400);
    assert.equal(f.traffic.length, count);
  },
);

test('constant picture and pruned journal stay synchronized after many commits without a rebuild', async (t) => {
  const f = await fixture(t);
  const writer = await publicClient(t, f);
  const publisher_id = uuid(),
    observation_id = uuid();
  const { creation, reporter } = writer.reporting.createObservation({
    request_id: uuid(),
    publisher_id,
    observation_id,
  });
  const created = sent(await creation.send());
  const decode = 4194304 * 8 + 262144 * 256 + 4096;
  const client = await connected(f, {
    mode: 'full',
    picture: { bytes: decode + 64 * 1024, journalCommits: 1 },
  });
  await ready(client);
  const generation = client.picture.status.generation;
  const boundary = client.picture.cursor;
  const snapshots = f.traffic.filter((e) => e.path === '/messages/read_snapshot').length;
  const origin = { kind: 'publisher', publisher_id };
  let committed;
  for (let sequence = 1; sequence <= 256; sequence++) {
    committed = success(
      (
        await reporter
          .report(
            reading(sequence, {
              telemetry: telemetry(
                origin,
                (sequence % 80) + 0.25,
                new Date(Date.UTC(2026, 9, 21, 12) + sequence * 1000).toISOString(),
              ),
            }),
          )
          .send()
      ).attempt,
    );
  }
  await ready(client, committed.commit_cursor);
  assert.equal(client.picture.status.generation, generation);
  assert.equal(f.traffic.filter((e) => e.path === '/messages/read_snapshot').length, snapshots);
  assert.equal(client.picture.changedSince(boundary).kind, 'gap');
  assert.equal(available(client.tracks.get({ track_id: created.track.id })).id, created.track.id);
});
