import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@atlas/sdk';
import { Uuid, exchanges } from '@atlas/protocol';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Proxy } from '../dist/proxy.js';
import { Shutdown } from '../dist/shutdown.js';
import { Core } from '../dist/core.js';
import { Truth } from '../dist/truth.js';
import { World } from '../dist/world.js';
import { AssetRuntime } from '../dist/asset.js';
import { Operator } from '../dist/operator.js';
import { id, success } from '../dist/sdk.js';
const scenario = {
  name: 'controls',
  assets: [
    {
      alias: 'Pilot',
      position: { latitude: 51.5, longitude: -0.1 },
      cruise_speed: 1,
      detection_radius: 0,
    },
  ],
  subjects: [],
};
async function fixture(t, registrationLoss = false) {
  const core = await Core.allocate();
  await core.setup();
  const proxy = new Proxy(core.baseUrl);
  await proxy.start();
  if (registrationLoss)
    proxy.arm({ path: '/messages/register_asset', kind: 'drop', fired: () => {} });
  const truth = await Truth.create(core.directory);
  const registrar = createClient({
    baseUrl: proxy.baseUrl,
    credentials: () => core.credential.secret,
  });
  success(await registrar.connect());
  const datasetId = Uuid.parse(registrar.state.datasetId);
  const world = new World(scenario, truth);
  const fatal = [];
  const asset = new AssetRuntime({
    config: scenario.assets[0],
    baseUrl: proxy.baseUrl,
    datasetId,
    world,
    truth,
    runId: randomBytes(2).toString('hex'),
    fatal: (e) => fatal.push(e),
  });
  asset.hooks.networkHoldUntil = Infinity;
  await asset.start(registrar);
  const operator = new Operator({
    baseUrl: proxy.baseUrl,
    secret: core.credential.secret,
    datasetId,
    assets: new Map([['Pilot', asset.identity.asset_id]]),
    truth,
    reader: registrar,
  });
  await operator.start(scenario);
  t.after(async () => {
    const cleanup = new Shutdown();
    await cleanup.finish('park', () => asset.park(cleanup.deadline - 3000));
    await cleanup.finish('operator', () => operator.close());
    await cleanup.finish('Asset client', () => asset.close());
    await cleanup.finish('registrar', async () => {
      await registrar.close();
    });
    await cleanup.finish('truth', () => truth.close());
    await cleanup.finish('proxy', () => proxy.close());
    await cleanup.finish('Core', () => core.stop());
    assert.deepEqual(cleanup.failures, []);
    assert.deepEqual(fatal, []);
  });
  const action = (action) => operator.apply({ at_seconds: 0, asset: 'Pilot', ...action });
  const poll = () => asset.pollInstructions();
  const task = async (index) =>
    success(await operator.client.http.tasks.get({ task_id: operator.move('Pilot', index).id }));
  const control = async () =>
    success(await operator.client.http.tasks.get({ task_id: operator.controls.at(-1) }));
  return { core, asset, operator, truth, world, action, poll, task, control, proxy };
}
for (const mode of ['continue', 'cancel', 'fail'])
  test(`live paused continuation ${mode}`, { timeout: 45000 }, async (t) => {
    const f = await fixture(t);
    await f.action({ action: 'move_to', position: { latitude: 51.51, longitude: -0.1 } });
    await f.action({ action: 'move_to', position: { latitude: 51.5, longitude: -0.1 } });
    await f.poll();
    assert.equal((await f.task(0)).execution_state, 'in_progress');
    await f.action({ action: 'pause' });
    await f.poll();
    assert.equal((await f.task(0)).execution_state, 'paused');
    if (mode === 'cancel') {
      await f.action({ action: 'cancel', index: 0 });
      await f.poll();
    }
    if (mode === 'fail') f.asset.hooks.failResume = true;
    await f.action({ action: 'resume' });
    await f.poll();
    assert.equal((await f.control()).execution_state, mode === 'fail' ? 'failed' : 'completed');
    assert.equal(
      (await f.task(0)).execution_state,
      mode === 'fail' ? 'failed' : mode === 'cancel' ? 'cancelled' : 'in_progress',
    );
    assert.equal(f.asset.gate.kind, mode === 'fail' ? 'paused' : 'running');
    await f.poll();
    assert.equal((await f.task(1)).execution_state, mode === 'cancel' ? 'in_progress' : 'pending');
  });
test(
  'unseen Pause remains intent until observed after fresh Resume boundary',
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    await f.action({ action: 'pause' });
    await f.poll();
    await f.action({ action: 'resume' });
    let acceptedPause;
    f.asset.hooks.beforeResume = async () => {
      await f.action({ action: 'pause' });
      acceptedPause = success(
        await f.operator.client.http.assets.get({ asset_id: f.asset.identity.asset_id }),
      );
    };
    await f.poll();
    assert.equal(acceptedPause.task_control.requested.command, 'pause');
    assert.notEqual(
      acceptedPause.task_control.confirmed.revision,
      acceptedPause.task_control.revision,
    );
    assert.equal(f.asset.gate.kind, 'running');
    delete f.asset.hooks.beforeResume;
    await f.poll();
    assert.equal(f.asset.gate.kind, 'paused');
    const observed = success(
      await f.operator.client.http.assets.get({ asset_id: f.asset.identity.asset_id }),
    );
    assert.equal(observed.task_control.confirmed.revision, observed.task_control.revision);
  },
);
test('World subject keeps moving while a fault owner awaits', async (t) => {
  const f = await fixture(t);
  const moving = {
    ...scenario,
    subjects: [
      {
        alias: 'Vehicle',
        route: [
          { latitude: 0, longitude: 0 },
          { latitude: 0.1, longitude: 0 },
        ],
        speed: 100,
      },
    ],
  };
  const world = new World(moving, f.truth);
  const stop = world.start();
  try {
    const before = world.reading('Vehicle', 'subject');
    await delay(300);
    const after = world.reading('Vehicle', 'subject');
    assert.ok(after.position.latitude > before.position.latitude);
    assert.notEqual(after.reading_id, before.reading_id);
  } finally {
    stop();
  }
});
async function verifyFixture(f, state) {
  const { collectEvidence, checkEvidence } = await import('../dist/checks.js');
  await f.asset.park();
  await f.truth.boundary();
  const input = {
    scenario: {
      ...scenario,
      timeline: f.operator.moves.map((m) => m.action),
      expect: { tasks: [{ asset: 'Pilot', index: 0, state }], tracks: 0 },
      deadline_seconds: 30,
    },
    baseUrl: f.core.baseUrl,
    secret: f.core.credential.secret,
    datasetId: f.operator.input.datasetId,
    truth: f.truth.path,
    assets: f.operator.input.assets,
    moves: f.operator.moves,
  };
  return checkEvidence(input, await collectEvidence(input));
}
test(
  'independent checker rejects live queued execution through a pause gate',
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    await f.action({ action: 'pause' });
    await f.poll();
    await f.action({ action: 'move_to', position: { latitude: 51.51, longitude: -0.1 } });
    f.asset.gate = { kind: 'running' };
    await f.poll();
    assert.equal((await f.task(0)).execution_state, 'in_progress');
    assert.equal((await verifyFixture(f, 'in_progress')).order.kind, 'failed');
  },
);
test(
  'independent checker rejects a live duplicate physical effect',
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    await f.action({ action: 'move_to', position: scenario.assets[0].position });
    await f.poll();
    const move = f.asset.execution.move;
    await delay(150);
    await f.poll();
    assert.equal((await f.task(0)).execution_state, 'completed');
    f.asset.execution = { kind: 'moving', move };
    await delay(150);
    assert.equal((await verifyFixture(f, 'completed')).tasks.kind, 'failed');
  },
);
test(
  'uncertain registration retries its original identity and retains initial Tags',
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t, true);
    assert.equal(f.proxy.requestCounts.get('/messages/register_asset'), 2);
    const asset = success(
      await f.operator.client.http.assets.get({ asset_id: f.asset.identity.asset_id }),
    );
    assert.deepEqual(asset.tags.value.presets, ['simulated']);
    assert.equal(asset.communications.health, 'healthy');
  },
);
test(
  'known expired contact refreshes the allocation and recovers healthy contact',
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    const before = success(
      await f.operator.client.http.assets.get({ asset_id: f.asset.identity.asset_id }),
    );
    f.asset.hooks.contactDelayMs = 10500;
    await f.asset.checkContact();
    const after = success(
      await f.operator.client.http.assets.get({ asset_id: f.asset.identity.asset_id }),
    );
    assert.notEqual(after.heartbeat.last_contact_at, before.heartbeat.last_contact_at);
    assert.equal(after.communications.health, 'healthy');
    assert.equal(f.proxy.requestCounts.get('/messages/begin_asset_contact'), 3);
  },
);
test(
  'interrupted shutdown response discards instructions before a fresh read starts work',
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    await f.action({ action: 'move_to', position: { latitude: 51.51, longitude: -0.1 } });
    let intercepted = 0;
    f.proxy.arm({
      path: '/messages/get_assigned_tasks',
      kind: 'unavailable',
      fired: () => {
        intercepted++;
      },
    });
    await f.poll();
    assert.equal(intercepted, 1);
    assert.equal((await f.task(0)).execution_state, 'pending');
    await f.poll();
    assert.equal((await f.task(0)).execution_state, 'in_progress');
  },
);
test(
  'a superseded instruction lease is discarded before fresh work adoption',
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    await f.action({ action: 'move_to', position: { latitude: 51.51, longitude: -0.1 } });
    const key = {
      request_id: id(),
      api_key_id: id(),
      secret: randomBytes(32).toString('base64url'),
    };
    const create = f.operator.client.apiKeys.create(key);
    try {
      success((await create.send()).attempt);
    } finally {
      create.close();
    }
    try {
      let release;
      const intercepted = new Promise((resolve) => {
        release = resolve;
      });
      f.proxy.arm({
        path: '/messages/get_assigned_tasks',
        kind: 'delay',
        delayMs: 500,
        fired: () => release(),
      });
      const pending = f.poll();
      await intercepted;
      const generation = f.asset.client.state.generation;
      f.asset.identity.secret = key.secret;
      success(await f.asset.client.recover());
      assert.ok(f.asset.client.state.generation > generation);
      await pending;
      assert.equal((await f.task(0)).execution_state, 'pending');
      await f.poll();
      assert.equal((await f.task(0)).execution_state, 'in_progress');
    } finally {
      const revoke = f.operator.client.apiKeys.revoke({
        request_id: id(),
        api_key_id: key.api_key_id,
      });
      try {
        success((await revoke.send()).attempt);
      } finally {
        revoke.close();
      }
    }
  },
);
test(
  'concurrent contact callers share one allocation and accepted check-in',
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    const before = f.proxy.requestCounts.get('/messages/begin_asset_contact');
    await Promise.all([f.asset.checkContact(), f.asset.checkContact()]);
    assert.equal(f.proxy.requestCounts.get('/messages/begin_asset_contact') - before, 1);
    const asset = success(
      await f.operator.client.http.assets.get({ asset_id: f.asset.identity.asset_id }),
    );
    assert.equal(asset.communications.health, 'healthy');
  },
);
test(
  'observed Pause blocks a Move To whose Geofeature read was still pending',
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    const geofeature_id = id();
    const create = f.operator.client.geofeatures.create({
      request_id: id(),
      geofeature_id,
      geometry: { type: 'Point', coordinates: [-0.1, 51.51] },
    });
    try {
      success((await create.send()).attempt);
    } finally {
      create.close();
    }
    f.operator.features.set('Held point', geofeature_id);
    await f.action({ action: 'move_to', geofeature: 'Held point' });
    let release;
    const intercepted = new Promise((resolve) => {
      release = resolve;
    });
    f.proxy.arm({
      path: exchanges.GetGeofeature.path,
      kind: 'delay',
      delayMs: 1500,
      fired: () => release(),
    });
    const pending = f.poll();
    await intercepted;
    await f.action({ action: 'pause' });
    await f.poll();
    assert.equal((await f.control()).execution_state, 'completed');
    await pending;
    assert.equal((await f.task(0)).execution_state, 'pending');
    assert.equal(f.asset.gate.kind, 'paused');
    await f.action({ action: 'resume' });
    await f.poll();
    await f.poll();
    assert.equal((await f.task(0)).execution_state, 'in_progress');
  },
);
