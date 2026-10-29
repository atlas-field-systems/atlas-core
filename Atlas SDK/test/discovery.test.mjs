import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:https';
import { fixture, uuid, secret, registration, task, barrier } from './harness.mjs';

test('a refused rotation candidate preserves accepted authority and an in-flight write', async (t) => {
  const f = await fixture(t);
  let candidate = f.apiKey;
  const client = f.client({ credentials: () => candidate });
  assert.equal((await client.connect()).response.kind, 'success');
  const asset = registration();
  assert.equal((await client.assets.register(asset).send()).outcome.kind, 'accepted');
  const captured = barrier(),
    release = barrier();
  f.once('/messages/create_task', async ({ forward }) => {
    captured.resolve();
    await release.promise;
    forward();
  });
  const operation = client.tasks.create(task(asset.asset_id));
  const running = operation.start();
  await captured.promise;
  let recovery;
  try {
    candidate = secret();
    recovery = await client.recover();
  } finally {
    release.resolve();
  }
  assert.equal(recovery.response.body.error.code, 'unauthorized');
  assert.equal(client.state.kind, 'ready');
  assert.equal((await running.settled).response.kind, 'success');
  assert.equal(operation.outcome.kind, 'accepted');
  assert.equal((await client.connect()).response.kind, 'success');
});

for (const code of ['protocol_mismatch', 'dataset_mismatch']) {
  test(`candidate ${code} leaves accepted work ready while ordinary discovery still fences it`, async (t) => {
    const f = await fixture(t);
    let candidate = f.apiKey;
    const client = f.client({ credentials: () => candidate });
    assert.equal((await client.connect()).response.kind, 'success');
    const asset = registration();
    await client.assets.register(asset).send();
    const replacement = { request_id: uuid(), api_key_id: uuid(), secret: secret() };
    assert.equal((await client.apiKeys.create(replacement).send()).outcome.kind, 'accepted');
    const generation = client.state.generation;
    const committed = barrier(),
      release = barrier();
    t.after(() => release.resolve());
    f.once('/messages/create_task', async ({ status, forward }) => {
      committed.resolve(status);
      await release.promise;
      forward();
    });
    const operation = client.tasks.create(task(asset.asset_id));
    const running = operation.start();
    assert.equal(await committed.promise, 200);
    const refuseDiscovery = ({ headers, forward }) => {
      const version = code === 'protocol_mismatch' ? '0.4.0' : '0.3.0';
      forward(
        Buffer.from(
          JSON.stringify({
            dataset_id: f.datasetId,
            error: {
              code,
              message: 'Discovery refused',
              request_id: headers['atlas-request-id'],
              ...(code === 'protocol_mismatch' ? { details: { protocol_version: version } } : {}),
            },
          }),
        ),
        409,
        { ...headers, 'atlas-protocol-version': version },
      );
    };
    candidate = replacement.secret;
    f.once('/health', refuseDiscovery);
    try {
      assert.equal((await client.recover()).response.body.error.code, code);
    } finally {
      release.resolve();
    }
    assert.equal(client.state.kind, 'ready');
    assert.equal(client.state.generation, generation);
    assert.equal((await running.settled).response.kind, 'success');
    assert.equal(operation.outcome.kind, 'accepted');
    assert.equal((await client.readiness({})).response.kind, 'success');
    f.once('/health', refuseDiscovery);
    assert.equal((await client.connect()).response.body.error.code, code);
    assert.equal(client.state.kind, 'blocked');
    assert.equal(client.state.reason, code === 'dataset_mismatch' ? 'dataset_invalidated' : code);
  });
}

test('invalid recovery responses preserve the rejected-key pause without new traffic', async (t) => {
  const f = await fixture(t);
  let candidate = f.apiKey;
  const client = f.client({ credentials: () => candidate });
  assert.equal((await client.connect()).response.kind, 'success');
  const replacement = { request_id: uuid(), api_key_id: uuid(), secret: secret() };
  assert.equal((await client.apiKeys.create(replacement).send()).outcome.kind, 'accepted');
  const revoke = await client.apiKeys.revoke({ request_id: uuid(), api_key_id: f.apiKeyId }).send();
  assert.equal(revoke.attempt.response.body.error.code, 'unauthorized');
  candidate = replacement.secret;
  f.once('/health', ({ outgoing }) => {
    outgoing.writeHead(502, { 'content-type': 'text/html' });
    outgoing.end('<html>bad gateway</html>');
  });
  assert.equal((await client.recover()).code, 'invalid_http');
  assert.equal(client.state.kind, 'authorization-required');
  const before = f.traffic.length;
  assert.equal((await client.connect()).code, 'authorization_required');
  assert.equal((await client.readiness({})).code, 'authorization_required');
  assert.equal(f.traffic.length, before);
  assert.equal((await client.recover()).response.kind, 'success');
});

test('a committed reply in transit retains original-Dataset evidence after Reset discovery', async (t) => {
  const f = await fixture(t);
  const client = f.client();
  assert.equal((await client.connect()).response.kind, 'success');
  const asset = registration();
  assert.equal((await client.assets.register(asset).send()).outcome.kind, 'accepted');
  const committed = barrier(),
    release = barrier();
  f.once('/messages/create_task', async ({ status, forward }) => {
    committed.resolve(status);
    await release.promise;
    forward();
  });
  const operation = client.tasks.create(task(asset.asset_id));
  const running = operation.start();
  try {
    assert.equal(await committed.promise, 200);
    const originalDataset = client.state.datasetId;
    await f.reset();
    assert.equal((await client.connect()).response.kind, 'success');
    assert.notEqual(client.state.datasetId, originalDataset);
  } finally {
    release.resolve();
  }
  assert.equal((await running.settled).response.kind, 'success');
  assert.equal(operation.outcome.kind, 'dataset_invalidated');
  assert.equal(operation.outcome.evidence.kind, 'accepted');
  assert.equal((await operation.send()).attempt.code, 'dataset_invalidated');
});

test('real Core admission refusal during discovery does not claim a Protocol mismatch', async (t) => {
  const f = await fixture(t);
  const overloaded = Promise.withResolvers();
  const held = [];
  const timer = setTimeout(
    () => overloaded.reject(new Error('Core did not reach admission capacity')),
    5000,
  );
  let result, state;
  try {
    for (let i = 0; i < 80; i++) {
      const outgoing = request(new URL('/messages/create_task', f.address), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${f.apiKey}`,
          'Atlas-Dataset-ID': f.datasetId,
          'Atlas-Protocol-Version': '0.3.0',
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked',
        },
      });
      outgoing.on('error', () => {});
      outgoing.on('response', (response) => {
        if (response.statusCode === 429) overloaded.resolve();
        response.resume();
      });
      outgoing.write('{');
      held.push(outgoing);
    }
    await overloaded.promise;
    const client = f.client({ baseUrl: f.address });
    result = await client.connect();
    state = client.state;
  } finally {
    clearTimeout(timer);
    for (const outgoing of held) outgoing.destroy();
  }
  assert.equal(result.response.body.error.code, 'resource_limit');
  assert.equal(state.kind, 'blocked');
  assert.equal(state.reason, 'not_connected');
});

test('exhausted prepared-byte capacity still shares an existing identity and its evidence', async (t) => {
  const f = await fixture(t);
  const client = f.client({ limits: { preparedBytes: 16384 } });
  assert.equal((await client.connect()).response.kind, 'success');
  const retained = [];
  let refusal;
  for (let i = 0; i < 32; i++) {
    const facts = registration(`bounded-${i}`);
    try {
      retained.push({ facts, operation: client.assets.register(facts) });
    } catch (error) {
      refusal = error;
      break;
    }
  }
  assert.equal(refusal?.code, 'capacity');
  assert.ok(retained.length > 0);
  const first = retained[0];
  assert.equal((await first.operation.send()).outcome.kind, 'accepted');
  assert.equal(client.assets.register(first.facts).outcome.kind, 'accepted');
});
