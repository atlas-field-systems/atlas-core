import test from 'node:test';
import assert from 'node:assert/strict';
import { exchanges } from '@atlas/protocol';
import { fixture, uuid, registration, task, barrier } from './harness.mjs';
import { owners, success, sent } from './remote-helpers.mjs';

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
