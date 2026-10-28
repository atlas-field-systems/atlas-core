import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { fixture, uuid, secret, report, telemetry, registration } from './helpers.mjs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { QueuePressure } from '../dist/rpc.js';
const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.data; };
const limits = { max_message_bytes: 4194304, max_json_values: 262144, max_changes: 1000 };
async function socket(f, credential = f.apiKey) {
  const ws = new WebSocket(f.address.replace('https:', 'wss:') + '/changes', { ca: f.ca });
  const messages = []; const waiters = new Set();
  ws.on('message', raw => { const frame = JSON.parse(raw.toString()); messages.push(frame); for (const waiter of waiters) waiter(); });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const take = async predicate => {
    const found = () => { const index = messages.findIndex(predicate); return index < 0 ? undefined : messages.splice(index, 1)[0]; };
    const initial = found(); if (initial) return initial;
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { waiters.delete(check); reject(new Error('Required WSS event was not delivered')); }, 10000); const check = () => { const value = found(); if (value) { clearTimeout(timer); waiters.delete(check); resolve(value); } }; waiters.add(check); });
  };
  const send = (type, data) => ws.send(JSON.stringify({ type, dataset_id: f.core.dataset, protocol_version: '0.1.0', request_id: uuid(), data }));
  ws.send(JSON.stringify({ type: 'authenticate', request_id: uuid(), dataset_id: f.core.dataset, protocol_version: '0.1.0', api_key: credential }));
  await take(frame => frame.type === 'authenticated');
  return { ws, take, send, messages };
}
test('WSS fixed snapshot handoff, whole commits, ordered progress and revocation', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const key = { api_key_id: uuid(), request_id: uuid(), secret: secret() }; ok(await f.call('CreateApiKey', key));
  const s = await socket(f, key.secret); t.after(() => s.ws.terminate());
  const health = ok(await f.call('GetHealth'));
  s.send('read_snapshot', { load_id: uuid(), allocation_context: health.allocation_context, page_size: 1, ...limits });
  const captured = await s.take(frame => frame.type === 'read_snapshot_result');
  assert.equal(captured.data.items.length, 0);
  const publisher = uuid(), entity = uuid(), origin = { kind: 'publisher', publisher_id: publisher };
  const pair = await f.call('CreateObservation', { request_id: uuid(), observation_id: entity, publisher_id: publisher,
    report: report(f.core.dataset, entity, origin, 11, { telemetry: telemetry(origin, 51.001) }) }); ok(pair);
  const subscription = uuid(); s.send('subscribe_changes', { subscription_id: subscription, from_cursor: captured.data.baseline_cursor, ...limits });
  const subscribed = await s.take(frame => frame.type === 'subscribed');
  assert.equal(subscribed.data.handoff_cursor, pair.json.commit_cursor);
  const batch = await s.take(frame => frame.type === 'change_batch');
  assert.equal(batch.data.previous_cursor, captured.data.baseline_cursor);
  assert.equal(batch.data.changes.length, 1); assert.equal(batch.data.changes[0].resource_kind, 'track');
  const handoff = await s.take(frame => frame.type === 'handoff_complete'); assert.equal(handoff.data.handoff_cursor, pair.json.commit_cursor);
  const history = await f.call('ReportObservation', { observation_id: entity, publisher_id: publisher,
    report: report(f.core.dataset, entity, origin, 10, { telemetry: telemetry(origin, 51) }, 'history_only') }); ok(history);
  const progress = await s.take(frame => frame.type === 'progress');
  assert.equal(progress.data.previous_cursor, pair.json.commit_cursor); assert.equal(progress.data.through_cursor, history.json.commit_cursor);
  s.send('release_snapshot', { release_token: captured.data.release_token }); await s.take(frame => frame.type === 'snapshot_released');
  const closure = new Promise(resolve => s.ws.once('close', (code) => resolve(code)));
  ok(await f.call('RevokeApiKey', { api_key_id: key.api_key_id, request_id: uuid() }));
  assert.equal(await closure, 1008);
});
test('concurrent WSS subscriptions drain multi-commit handoff and live backlog within ten seconds', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const asset = ok(await f.call('RegisterAsset', registration())).asset;
  const health = ok(await f.call('GetHealth'));
  const captured = ok(await f.call('ReadSnapshot', { load_id: uuid(), allocation_context: health.allocation_context, page_size: 100, ...limits }));
  ok(await f.call('ReleaseSnapshot', { release_token: captured.release_token }));
  const expected = new Map();
  async function feature() {
    const geofeature_id = uuid();
    const response = await f.call('CreateGeofeature', { request_id: uuid(), geofeature_id, geometry: { type: 'Point', coordinates: [0, 0] } }); ok(response);
    expected.set(response.json.commit_cursor, [geofeature_id]); return response.json.commit_cursor;
  }
  for (let i = 0; i < 48; i++) await feature();
  const created = await f.call('CreateTask', { request_id: uuid(), task_id: uuid(), asset_id: asset.id, command: 'pause', scheduling: 'immediate', inputs: {} });
  const task = ok(created); expected.set(created.json.commit_cursor, [asset.id, task.task_id]);
  const clients = await Promise.all(Array.from({ length: 8 }, () => socket(f)));
  t.after(() => { for (const client of clients) client.ws.terminate(); });
  for (const client of clients) client.send('subscribe_changes', { subscription_id: uuid(), from_cursor: captured.baseline_cursor, ...limits });
  const subscribed = await Promise.all(clients.map(client => client.take(frame => frame.type === 'subscribed')));
  for (const frame of subscribed) assert.equal(frame.data.handoff_cursor, created.json.commit_cursor);
  let failedDeadline;
  const expired = new Promise((_, reject) => { failedDeadline = setTimeout(() => reject(new Error('Committed backlog did not reach fixed handoff and live boundary within ten seconds')), 10000); });
  const final = await feature();
  for (let i = 0; i < 47; i++) await feature();
  const boundary = [...expected.keys()].at(-1); assert.notEqual(boundary, final);
  try {
    await Promise.race([Promise.all(clients.map(async client => {
      let cursor = captured.baseline_cursor, handoff = false;
      const seen = new Set();
      while (cursor !== boundary || !handoff) {
        const frame = await client.take(frame => ['change_batch', 'progress', 'handoff_complete', 'gap', 'error'].includes(frame.type));
        assert.ok(frame.type !== 'gap' && frame.type !== 'error', JSON.stringify(frame));
        if (frame.type === 'handoff_complete') { assert.equal(cursor, created.json.commit_cursor); assert.equal(frame.data.handoff_cursor, cursor); handoff = true; continue; }
        assert.equal(frame.data.previous_cursor, cursor);
        cursor = frame.type === 'change_batch' ? frame.data.commit_cursor : frame.data.through_cursor;
        assert.equal(seen.has(cursor), false); seen.add(cursor);
        assert.equal(frame.type, 'change_batch');
        assert.deepEqual(frame.data.changes.map(change => change.resource_id).sort(), expected.get(cursor)?.toSorted());
      }
      assert.equal(seen.size, expected.size);
    })), expired]);
  } finally { clearTimeout(failedDeadline); }
});
test('unsubscribe ends delivery while polling awaits the worker', { timeout: 30000 }, async t => {
  for (const boundary of ['authorization', 'empty handoff']) await t.test(boundary, async t => {
    const f = await fixture(t);
    const health = ok(await f.call('GetHealth'));
    const snapshot = ok(await f.call('ReadSnapshot', { load_id: uuid(), allocation_context: health.allocation_context, page_size: 100, ...limits }));
    ok(await f.call('ReleaseSnapshot', { release_token: snapshot.release_token }));
    if (boundary === 'authorization') ok(await f.call('CreateGeofeature', { request_id: uuid(), geofeature_id: uuid(), geometry: { type: 'Point', coordinates: [0, 0] } }));
    const client = await socket(f); t.after(() => client.ws.terminate());
    const paused = Promise.withResolvers(), resume = Promise.withResolvers();
    const call = f.core.rpc.call.bind(f.core.rpc);
    let authorizingBatch = false, held = false;
    // Keep real worker results, but let unsubscribe cross the in-flight polling wait.
    f.core.rpc.call = async (...args) => {
      const result = await call(...args);
      const pause = !held && (boundary === 'empty handoff' ? args[0] === 'feed' : args[0] === 'authorize' && authorizingBatch);
      if (args[0] === 'feed') authorizingBatch = true;
      if (pause) { held = true; paused.resolve(); await resume.promise; }
      return result;
    };
    try {
      const subscription_id = uuid();
      client.send('subscribe_changes', { subscription_id, from_cursor: snapshot.baseline_cursor, ...limits });
      await client.take(frame => frame.type === 'subscribed');
      await paused.promise;
      client.send('unsubscribe_changes', { subscription_id });
      assert.equal((await client.take(frame => frame.type === 'unsubscribed')).data.subscription_id, subscription_id);
      resume.resolve();
      client.send('read_changes', { from_cursor: snapshot.baseline_cursor, ...limits });
      const next = await client.take(frame => ['change_batch', 'progress', 'handoff_complete', 'gap', 'error', 'read_changes_result'].includes(frame.type));
      assert.equal(next.type, 'read_changes_result', 'No subscription events may follow its unsubscribe acknowledgment');
      client.send('unsubscribe_changes', { subscription_id });
      await client.take(frame => frame.type === 'unsubscribed');
    } finally { resume.resolve(); f.core.rpc.call = call; }
  });
});
test('finite allocations retain charged receipts after release and never resurrect captures', async t => {
  const f = await fixture(t, { temporary: { ...((await import('../dist/settings.js')).defaults.temporary), max_allocation_receipts: 2 } });
  const health = ok(await f.call('GetHealth'));
  const firstRequest = { load_id: uuid(), allocation_context: health.allocation_context, page_size: 100, ...limits };
  const first = ok(await f.call('ReadSnapshot', firstRequest));
  const second = ok(await f.call('ReadSnapshot', { ...firstRequest, load_id: uuid() }));
  assert.notEqual(first.capture_id, second.capture_id);
  ok(await f.call('ReleaseSnapshot', { release_token: first.release_token }));
  ok(await f.call('ReleaseSnapshot', { release_token: first.release_token }));
  assert.equal((await f.call('ReadSnapshot', firstRequest)).json.error.code, 'allocation_expired');
  assert.equal((await f.call('ReadSnapshot', { ...firstRequest, load_id: uuid() })).json.error.code, 'resource_limit');
});
test('transient worker queue pressure defers WSS polling without ending its subscription', async t => {
  const f = await fixture(t, { workerQueueCount: 8, workerQueueBytes: 1_048_576 });
  const health = ok(await f.call('GetHealth'));
  const captured = ok(await f.call('ReadSnapshot', { load_id: uuid(), allocation_context: health.allocation_context, page_size: 100, ...limits }));
  ok(await f.call('ReleaseSnapshot', { release_token: captured.release_token }));
  const client = await socket(f); t.after(() => client.ws.terminate());
  client.send('subscribe_changes', { subscription_id: uuid(), from_cursor: captured.baseline_cursor, ...limits });
  await client.take(frame => frame.type === 'subscribed'); await client.take(frame => frame.type === 'handoff_complete');
  let refused = 0;
  const until = performance.now() + 1000;
  while (performance.now() < until) {
    await Promise.all(Array.from({ length: 12 }, () => f.core.rpc.call('inspect', {}, 1024).catch(error => {
      assert.ok(error instanceof QueuePressure); refused++;
    })));
    await yieldToLoop();
  }
  assert.ok(refused > 0, 'The real worker queue must have reached its admission bound');
  const geofeature_id = uuid();
  const created = await f.call('CreateGeofeature', { request_id: uuid(), geofeature_id, geometry: { type: 'Point', coordinates: [0, 0] } }); ok(created);
  const frame = await client.take(frame => ['change_batch', 'gap', 'error'].includes(frame.type));
  assert.equal(frame.type, 'change_batch', JSON.stringify(frame));
  assert.equal(frame.data.previous_cursor, captured.baseline_cursor); assert.equal(frame.data.commit_cursor, created.json.commit_cursor);
  assert.deepEqual(frame.data.changes.map(change => change.resource_id), [geofeature_id]);
});
test('failed capture admission publishes no partial file or commit and retains its finite receipt', async t => {
  const f = await fixture(t, { temporary: { ...((await import('../dist/settings.js')).defaults.temporary), max_snapshot_bytes: '32768', max_allocation_receipts: 1 } });
  const registered = await f.call('RegisterAsset', registration()); const asset = ok(registered).asset;
  const health = ok(await f.call('GetHealth'));
  const input = { load_id: uuid(), allocation_context: health.allocation_context, page_size: 100, ...limits };
  assert.equal((await f.call('ReadSnapshot', input)).json.error.code, 'resource_limit');
  assert.deepEqual(await readdir(join(f.directory, 'captures')), []);
  assert.equal((await f.call('ReadSnapshot', input)).json.error.code, 'resource_limit');
  assert.equal((await f.call('ReadSnapshot', { ...input, page_size: 1 })).json.error.code, 'allocation_conflict');
  assert.equal((await f.call('ReadSnapshot', { ...input, load_id: uuid() })).json.error.code, 'resource_limit');
  assert.equal(ok(await f.call('GetAsset', { asset_id: asset.id })).id, asset.id);
  assert.deepEqual(ok(await f.call('ReadChanges', { from_cursor: registered.json.commit_cursor, ...limits })).messages, []);
  ok(await f.call('DeleteAsset', { asset_id: asset.id, request_id: uuid() }));
  assert.equal((await f.call('ReadSnapshot', input)).json.error.code, 'resource_limit');
  await f.restart();
  assert.equal((await f.call('ReadSnapshot', input)).json.error.code, 'allocation_expired');
});
test('geometry work shortens complete list, snapshot and replay pages without skipping resources', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const health = ok(await f.call('GetHealth'));
  const initial = ok(await f.call('ReadSnapshot', { load_id: uuid(), allocation_context: health.allocation_context, page_size: 1000, ...limits }));
  ok(await f.call('ReleaseSnapshot', { release_token: initial.release_token }));
  const coordinates = Array.from({ length: 1023 }, (_, i) => [Math.cos(i * 2 * Math.PI / 1023), Math.sin(i * 2 * Math.PI / 1023)]);
  coordinates.push(coordinates[0]);
  const ids = [];
  for (let i = 0; i < 7; i++) { const id = uuid(); ids.push(id); ok(await f.call('CreateGeofeature', { geofeature_id: id, request_id: uuid(), geometry: { type: 'Polygon', coordinates: [coordinates] } })); }
  let page = ok(await f.call('ListGeofeatures', { page_size: 1000 }));
  assert.ok(page.items.length < ids.length);
  const listed = [];
  while (true) { listed.push(...page.items.map(item => item.id)); if (page.next_page_token === null) break; page = ok(await f.call('ListGeofeatures', { page_token: page.next_page_token })); }
  assert.deepEqual(listed.sort(), ids.sort());
  let snapshot = ok(await f.call('ReadSnapshot', { load_id: uuid(), allocation_context: health.allocation_context, page_size: 1000, ...limits }));
  const captured = [], token = snapshot.release_token;
  while (true) { captured.push(...snapshot.items.map(item => item.resource_id)); if (snapshot.next_page_token === null) break; snapshot = ok(await f.call('ReadSnapshot', { page_token: snapshot.next_page_token })); }
  assert.deepEqual(captured.sort(), ids.sort()); ok(await f.call('ReleaseSnapshot', { release_token: token }));
  let replay = ok(await f.call('ReadChanges', { from_cursor: initial.baseline_cursor, ...limits }));
  const changes = [];
  while (true) { for (const message of replay.messages) if (message.type === 'change_batch') changes.push(...message.data.changes.map(change => change.resource_id)); if (replay.next_page_token === null) break; replay = ok(await f.call('ReadChanges', { page_token: replay.next_page_token })); }
  assert.deepEqual(changes.sort(), ids.sort());
});
test('list admission refuses queries whose complete continuation exceeds the request budget', { timeout: 30000 }, async t => {
  const { defaults } = await import('../dist/settings.js');
  for (const max_request_bytes of [defaults.limits.max_request_bytes, 65536]) await t.test(String(max_request_bytes), async t => {
    const f = await fixture(t, { limits: { ...defaults.limits, max_request_bytes } });
    const count = max_request_bytes === defaults.limits.max_request_bytes ? 1000 : 80;
    const aliases = Array.from({ length: count }, (_, i) => '\0'.repeat(124) + i.toString(36).padStart(4, '0'));
    const ids = Array.from({ length: count }, uuid);
    for (let i = 0; i < 2; i++) ok(await f.call('CreateGeofeature', { request_id: uuid(), geofeature_id: ids[i], alias: aliases[i], geometry: { type: 'Point', coordinates: [i, i] } }));
    const query = { page_size: 1, filters: { aliases, ids } };
    assert.ok(Buffer.byteLength(JSON.stringify(query)) < max_request_bytes, 'The initial query must fit the effective HTTP budget');
    const response = await f.call('ListGeofeatures', query);
    assert.equal(response.status, 429, JSON.stringify({ status: response.status, tokenBytes: response.json?.data?.next_page_token?.length }));
    assert.equal(response.json.error.code, 'resource_limit');
    const complete = ok(await f.call('ListGeofeatures', { filters: query.filters }));
    assert.deepEqual(complete.items.map(item => item.id).sort(), ids.slice(0, 2).sort());
    assert.equal(complete.next_page_token, null);
    const smaller = ok(await f.call('ListGeofeatures', { page_size: 1, filters: { aliases: aliases.slice(0, 2), ids: ids.slice(0, 2) } }));
    const continued = ok(await f.call('ListGeofeatures', { page_token: smaller.next_page_token }));
    assert.deepEqual([...smaller.items, ...continued.items].map(item => item.id).sort(), ids.slice(0, 2).sort());
    assert.equal(continued.next_page_token, null);
  });
});
