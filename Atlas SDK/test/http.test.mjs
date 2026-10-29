import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, uuid, secret, registration, task, barrier } from './harness.mjs';

function success(result) {
  assert.equal(result.kind, 'response', JSON.stringify(result));
  assert.equal(result.response.kind, 'success', JSON.stringify(result));
  return result.response.body;
}
async function connected(f, options) {
  const client = f.client(options);
  success(await client.connect());
  return client;
}
async function asset(client, alias) {
  const facts = registration(alias);
  const result = await client.assets.register(facts).send();
  return success(result.attempt).data.asset;
}

test('authenticated discovery gates traffic, exact version and expected Dataset', async (t) => {
  const f = await fixture(t);
  const client = f.client();
  assert.equal((await client.tasks.get({ task_id: uuid() })).kind, 'not_sent');
  assert.equal(f.traffic.length, 0);
  success(await client.connect());
  assert.equal(client.state.kind, 'ready');
  assert.equal(client.state.datasetId, f.datasetId);
  assert.match(f.traffic[0].attemptId, /^[0-9a-f-]{36}$/);
  const wrong = f.client({ datasetId: uuid() });
  assert.equal((await wrong.connect()).code, 'dataset_invalidated');
  const count = f.traffic.length;
  assert.equal((await wrong.readiness({})).kind, 'not_sent');
  assert.equal(f.traffic.length, count);
  f.once('/health', ({ body, headers, forward }) => {
    const altered = JSON.parse(body);
    altered.data.protocol_version = '0.2.0';
    forward(Buffer.from(JSON.stringify(altered)), 200, {
      ...headers,
      'atlas-protocol-version': '0.2.0',
    });
  });
  const old = f.client();
  assert.equal((await old.connect()).kind, 'failed');
  assert.equal(old.state.kind, 'blocked');
  const afterMismatch = f.traffic.length;
  assert.equal((await old.readiness({})).kind, 'not_sent');
  assert.equal(f.traffic.length, afterMismatch);
});

test('credential-provider waits are bounded and close fences unfinished discovery', async (t) => {
  const f = await fixture(t);
  const provider = barrier();
  let calls = 0;
  const client = f.client({
    credentials: () => {
      calls++;
      return provider.promise;
    },
    timeoutMs: 50,
    limits: { concurrentAttempts: 1 },
  });
  assert.equal((await client.connect()).code, 'deadline');
  assert.equal((await client.connect()).code, 'capacity');
  assert.equal(calls, 1);
  await client.close();
  provider.resolve(f.apiKey);
  assert.equal((await client.connect()).code, 'closed');
  assert.equal(f.traffic.length, 0);
});

test('a lost committed Task reply retains immutable facts and deliberate retry proves one effect', async (t) => {
  const f = await fixture(t),
    client = await connected(f);
  const registered = await asset(client, 'immutable');
  const input = task(registered.id);
  const prepared = client.tasks.create(input);
  input.inputs.target.position.latitude = 45;
  let cursor;
  f.once('/messages/create_task', ({ body, outgoing }) => {
    cursor = JSON.parse(body).commit_cursor;
    outgoing.destroy();
  });
  const lost = await prepared.send();
  assert.equal(lost.attempt.kind, 'failed');
  assert.equal(lost.outcome.kind, 'unknown_outcome');
  assert.equal(prepared.submission.facts.inputs.target.position.latitude, 0);
  assert.throws(() => {
    prepared.submission.facts.inputs.target.position.latitude = 90;
  }, TypeError);
  const retry = await prepared.send();
  assert.equal(retry.outcome.kind, 'accepted');
  const accepted = success(retry.attempt);
  assert.equal(accepted.commit_cursor, cursor);
  assert.equal(accepted.data.inputs.target.position.latitude, 0);
  assert.notEqual(lost.attempt.context.attemptId, retry.attempt.context.attemptId);
  assert.match(retry.attempt.context.requestId, /^[0-9a-f-]{36}$/);
  const page = success(await client.tasks.list({ filters: { asset_ids: [registered.id] } }).next());
  assert.deepEqual(
    page.data.items.map((item) => item.task_id),
    [prepared.submission.facts.task_id],
  );
  assert.equal(page.data.items[0].execution_state, 'pending');
  assert.equal(client.tasks.create(prepared.submission.facts).outcome.kind, 'accepted');
  assert.throws(() => client.tasks.create(input), {
    code: 'identity_conflict',
  });
});

test('only operation-specific no-effect evidence rejects, and an earlier lost reply stays unknown', async (t) => {
  const f = await fixture(t),
    client = await connected(f);
  const input = registration();
  input.capabilities.commands = [];
  const registered = success((await client.assets.register(input).send()).attempt).data.asset;
  const refused = client.tasks.create(task(registered.id));
  const first = await refused.send();
  assert.equal(first.attempt.response.body.error.code, 'unsupported_command');
  assert.deepEqual(first.outcome, {
    kind: 'rejected',
    code: 'unsupported_command',
  });
  const uncertain = client.tasks.create(task(registered.id));
  f.once('/messages/create_task', ({ status, outgoing }) => {
    assert.equal(status, 422);
    outgoing.destroy();
  });
  assert.equal((await uncertain.send()).outcome.kind, 'unknown_outcome');
  const denied = await uncertain.send();
  assert.equal(denied.attempt.response.body.error.code, 'unsupported_command');
  assert.equal(denied.outcome.kind, 'unknown_outcome');
  assert.deepEqual(success(await client.tasks.list({}).next()).data.items, []);
});

test('self-revocation pauses all traffic, changed-key discovery alone resumes authority and exact retry resolves', async (t) => {
  const f = await fixture(t);
  let candidate = f.apiKey;
  const client = await connected(f, { credentials: () => candidate });
  const replacement = {
    request_id: uuid(),
    api_key_id: uuid(),
    secret: secret(),
  };
  success((await client.apiKeys.create(replacement).send()).attempt);
  const revoke = client.apiKeys.revoke({
    request_id: uuid(),
    api_key_id: f.apiKeyId,
  });
  const first = await revoke.send();
  assert.equal(first.attempt.response.body.error.code, 'unauthorized');
  assert.equal(first.outcome.kind, 'unknown_outcome');
  assert.equal(client.state.kind, 'authorization-required');
  const count = f.traffic.length;
  assert.equal((await client.recover()).code, 'unchanged_credential');
  assert.equal((await client.connect()).code, 'authorization_required');
  candidate = replacement.secret;
  assert.equal((await client.readiness({})).code, 'authorization_required');
  assert.equal((await client.apiKeys.list({}).next()).code, 'authorization_required');
  assert.equal((await revoke.send()).attempt.code, 'authorization_required');
  assert.equal(f.traffic.length, count);
  candidate = secret();
  assert.equal((await client.recover()).response.body.error.code, 'unauthorized');
  const afterBadCandidate = f.traffic.length;
  candidate = f.apiKey;
  assert.equal((await client.recover()).code, 'unchanged_credential');
  assert.equal(f.traffic.length, afterBadCandidate);
  candidate = replacement.secret;
  success(await client.recover());
  assert.equal(client.state.kind, 'ready');
  assert.equal(f.traffic.length, afterBadCandidate + 1);
  assert.equal(revoke.outcome.kind, 'unknown_outcome');
  const retry = await revoke.send();
  assert.equal(retry.outcome.kind, 'accepted');
  const recovered = success(retry.attempt);
  assert.equal(recovered.data.api_key_id, f.apiKeyId);
  assert.ok(recovered.commit_cursor);
  assert.equal(success((await revoke.send()).attempt).commit_cursor, recovered.commit_cursor);
});

test('provider changes do not replace accepted credentials, and later recovery fences earlier discovery', async (t) => {
  const f = await fixture(t);
  let candidate = f.apiKey;
  const client = await connected(f, { credentials: () => candidate });
  const keys = [0, 1].map(() => ({
    request_id: uuid(),
    api_key_id: uuid(),
    secret: secret(),
  }));
  for (const key of keys) success((await client.apiKeys.create(key).send()).attempt);
  candidate = secret();
  success(await client.readiness({}));
  const captured = barrier(),
    release = barrier();
  f.once('/health', async ({ forward }) => {
    captured.resolve();
    await release.promise;
    forward();
  });
  candidate = keys[0].secret;
  const older = client.recover();
  await captured.promise;
  candidate = keys[1].secret;
  success(await client.recover());
  release.resolve();
  assert.equal((await older).code, 'superseded');
  const revokeFirst = client.apiKeys.revoke({
    request_id: uuid(),
    api_key_id: keys[0].api_key_id,
  });
  success((await revokeFirst.send()).attempt);
  success(await client.readiness({}));
});

test('a validated success survives a later denied retry and a closed query cannot publish a delayed page', async (t) => {
  const f = await fixture(t),
    admin = await connected(f);
  const key = { request_id: uuid(), api_key_id: uuid(), secret: secret() };
  success((await admin.apiKeys.create(key).send()).attempt);
  const client = await connected(f, { credentials: () => key.secret });
  const registered = await asset(client);
  const operation = client.tasks.create(task(registered.id));
  success((await operation.send()).attempt);
  success(
    (await admin.apiKeys.revoke({ request_id: uuid(), api_key_id: key.api_key_id }).send()).attempt,
  );
  const denied = await operation.send();
  assert.equal(denied.attempt.response.body.error.code, 'unauthorized');
  assert.equal(denied.outcome.kind, 'accepted');
  const query = admin.assets.list({});
  const captured = barrier(),
    release = barrier();
  f.once('/messages/list_assets', async ({ forward }) => {
    captured.resolve();
    await release.promise;
    forward();
  });
  const page = query.next();
  await captured.promise;
  query.close();
  release.resolve();
  assert.equal((await page).code, 'closed');
});

test('original list filters survive mutation and continuation tokens', async (t) => {
  const f = await fixture(t),
    client = await connected(f);
  await asset(client, 'first');
  await asset(client, 'second');
  const input = { filters: { kinds: [null] }, page_size: 1 };
  const query = client.assets.list(input);
  input.filters.kinds = ['tracker'];
  const first = success(await query.next());
  assert.equal(first.data.items.length, 1);
  assert.ok(first.data.next_page_token);
  f.once('/messages/list_assets', ({ request, body, forward }) => {
    assert.deepEqual(Object.keys(JSON.parse(request)), ['page_token']);
    const changed = JSON.parse(body);
    changed.data.items[0].type.kind = 'tracker';
    forward(Buffer.from(JSON.stringify(changed)));
  });
  const invalid = await query.next();
  assert.equal(invalid.kind, 'failed');
  assert.equal(invalid.code, 'invalid_http');
  const second = success(await query.next());
  assert.notEqual(second.data.items[0].id, first.data.items[0].id);
  assert.equal(second.data.items[0].type.kind, null);
  assert.equal(second.data.next_page_token, null);
  assert.deepEqual(await query.next(), { kind: 'end' });
});

test('concurrent same-identity attempts share evidence, and caller abort leaves late success observable', async (t) => {
  const f = await fixture(t),
    client = await connected(f);
  const registered = await asset(client);
  const input = task(registered.id);
  const first = client.tasks.create(input);
  const second = client.tasks.create(Object.fromEntries(Object.entries(input).reverse()));
  const captured = barrier(),
    release = barrier();
  f.once('/messages/create_task', async ({ forward }) => {
    captured.resolve();
    await release.promise;
    forward();
  });
  const running = first.start();
  const controller = new AbortController();
  const wait = running.wait(controller.signal);
  await captured.promise;
  controller.abort();
  assert.equal((await wait).kind, 'cancelled');
  assert.equal(first.outcome.kind, 'unknown_outcome');
  const another = await second.send();
  assert.equal(another.outcome.kind, 'accepted');
  assert.equal(first.outcome.kind, 'accepted');
  release.resolve();
  assert.equal(
    success(await running.settled).commit_cursor,
    success(another.attempt).commit_cursor,
  );
  assert.equal(success(await client.tasks.list({}).next()).data.items.length, 1);
  const late = client.tasks.create(task(registered.id));
  const seenLate = barrier(),
    releaseLate = barrier();
  f.once('/messages/create_task', async ({ forward }) => {
    seenLate.resolve();
    await releaseLate.promise;
    forward();
  });
  const lateAttempt = late.start(),
    abort = new AbortController();
  const caller = lateAttempt.wait(abort.signal);
  await seenLate.promise;
  abort.abort();
  assert.equal((await caller).kind, 'cancelled');
  assert.equal(late.outcome.kind, 'unknown_outcome');
  releaseLate.resolve();
  success(await lateAttempt.settled);
  assert.equal(late.outcome.kind, 'accepted');
  assert.equal((await lateAttempt.wait(abort.signal)).kind, 'cancelled');
  assert.equal(late.outcome.kind, 'accepted');
});

test('attempt deadlines and concurrency admission stay independent of the caller wait', async (t) => {
  const f = await fixture(t),
    client = await connected(f, { limits: { concurrentAttempts: 1 } });
  const registered = await asset(client);
  const operation = client.tasks.create(task(registered.id));
  const captured = barrier(),
    release = barrier();
  f.once('/messages/create_task', async ({ forward }) => {
    captured.resolve();
    await release.promise;
    forward();
  });
  const running = operation.start({ timeoutMs: 500 });
  await captured.promise;
  const excluded = await operation.send();
  assert.equal(excluded.attempt.kind, 'not_sent');
  assert.equal(excluded.attempt.code, 'capacity');
  assert.equal(excluded.outcome.kind, 'unknown_outcome');
  const deadline = await running.settled;
  assert.equal(deadline.code, 'deadline');
  assert.equal(operation.outcome.kind, 'unknown_outcome');
  release.resolve();
  assert.equal((await operation.send()).outcome.kind, 'accepted');
  const aborted = new AbortController();
  aborted.abort();
  const unsent = client.tasks.create(task(registered.id));
  const before = f.traffic.length;
  assert.equal((await unsent.send({ signal: aborted.signal })).outcome.kind, 'not_submitted');
  assert.equal(f.traffic.length, before);
});

test('original response bytes reject malformed JSON, precision loss, redirects, and bounded ingestion', async (t) => {
  const f = await fixture(t),
    client = await connected(f, { limits: { response: { maxBytes: 8192 } } });
  const registered = await asset(client);
  const cases = [
    ({ body, forward }) =>
      forward(
        Buffer.from(
          body
            .toString()
            .replace('"dataset_id":', '"dataset_id":"' + f.datasetId + '","dataset_id":'),
        ),
      ),
    ({ body, forward }) =>
      forward(Buffer.from(body.toString().replace('"id":', '"extra":1,"id":'))),
    ({ outgoing, headers }) => {
      outgoing.writeHead(200, { ...headers, 'content-length': '1000000000' });
      outgoing.end();
    },
    ({ outgoing, headers }) => {
      const h = { ...headers };
      delete h['content-length'];
      outgoing.writeHead(200, h);
      outgoing.end(Buffer.alloc(8193, 32));
    },
    ({ outgoing, headers }) => {
      outgoing.writeHead(302, {
        ...headers,
        location: f.proxyUrl + '/health',
        'content-length': 0,
      });
      outgoing.end();
    },
  ];
  for (const alter of cases) {
    f.once('/messages/get_asset', alter);
    const result = await client.assets.get({ asset_id: registered.id });
    assert.equal(result.kind, 'failed', JSON.stringify(result));
  }
  success(await client.assets.get({ asset_id: registered.id }));
  f.once('/health', ({ body, forward }) => {
    const changed = body
      .toString()
      .replace('"max_message_bytes":4194304', '"max_message_bytes":4194304.00000000000000000001');
    assert.notEqual(changed, body.toString());
    forward(Buffer.from(changed));
  });
  assert.equal((await f.client().connect()).kind, 'failed');
  const before = f.traffic.length;
  assert.equal(
    (await client.assets.get({ asset_id: registered.id, unwanted: true })).kind,
    'not_sent',
  );
  assert.equal(f.traffic.length, before);
});

test('Reset invalidates original submissions and cursors while preserving their evidence', async (t) => {
  const f = await fixture(t),
    client = await connected(f);
  const registered = await asset(client);
  const accepted = client.tasks.create(task(registered.id));
  success((await accepted.send()).attempt);
  const unknown = client.tasks.create(task(registered.id));
  f.once('/messages/create_task', ({ outgoing }) => outgoing.destroy());
  assert.equal((await unknown.send()).outcome.kind, 'unknown_outcome');
  const query = client.tasks.list({});
  const oldDataset = client.state.datasetId;
  await f.reset();
  const mismatch = await client.readiness({});
  assert.equal(mismatch.response.body.error.code, 'dataset_mismatch');
  assert.equal(accepted.outcome.kind, 'dataset_invalidated');
  assert.equal(accepted.outcome.evidence.kind, 'accepted');
  assert.equal(unknown.outcome.evidence.kind, 'unknown_outcome');
  success(await client.connect());
  assert.notEqual(client.state.datasetId, oldDataset);
  const count = f.traffic.length;
  assert.equal((await accepted.send()).attempt.code, 'dataset_invalidated');
  assert.equal((await unknown.send()).attempt.code, 'dataset_invalidated');
  assert.equal((await query.next()).code, 'dataset_invalidated');
  assert.equal(f.traffic.length, count);
  assert.deepEqual(success(await client.tasks.list({}).next()).data.items, []);
});

test('typed resource clients use public HTTP and preserve exact counters and clearing semantics', async (t) => {
  const f = await fixture(t),
    client = await connected(f);
  const operator = success(
    (
      await client.operators
        .create({ request_id: uuid(), operator_id: uuid(), name: 'Pilot' })
        .send()
    ).attempt,
  ).data;
  assert.equal(
    success(await client.operators.get({ operator_id: operator.operator_id })).data.name,
    'Pilot',
  );
  const feature = success(
    (
      await client.geofeatures
        .create({
          request_id: uuid(),
          geofeature_id: uuid(),
          geometry: { type: 'Point', coordinates: [0, 0] },
          alias: 'Straße',
        })
        .send()
    ).attempt,
  ).data;
  assert.equal(success(await client.geofeatures.byAlias({ alias: 'STRASSE' })).data.id, feature.id);
  const observation = success(
    (
      await client.observations
        .create({
          request_id: uuid(),
          observation_id: uuid(),
          publisher_id: uuid(),
        })
        .send()
    ).attempt,
  ).data;
  assert.equal(
    success(await client.tracks.get({ track_id: observation.track.id })).data.id,
    observation.track.id,
  );
  assert.equal(
    success(await client.tracks.observations({ track_id: observation.track.id }).next()).data
      .items[0].id,
    observation.observation.id,
  );
  assert.deepEqual(success(await client.objects.list({}).next()).data.items, []);
  f.once('/messages/list_resources', ({ body, forward }) => {
    const changed = JSON.parse(body);
    changed.data.items = [
      {
        kind: 'exact',
        used: '18446744073709551615',
        capacity: '18446744073709551615',
      },
    ];
    forward(Buffer.from(JSON.stringify(changed)));
  });
  assert.equal(
    success(await client.resources({}).next()).data.items[0].used,
    '18446744073709551615',
  );
  const removed = await client.geofeatures
    .delete({ request_id: uuid(), geofeature_id: feature.id })
    .send();
  assert.deepEqual(success(removed.attempt).data, { deleted: true });
});

test('local input validation preserves omitted/null, blocks accessors and enforces operation capacity', async (t) => {
  const f = await fixture(t),
    client = await connected(f, { limits: { preparedOperations: 3 } });
  const facts = registration('clearable');
  const operation = client.assets.register(facts);
  const registered = success((await operation.send()).attempt).data.asset;
  assert.throws(() => client.assets.register({ ...registration(), alias: undefined }), {
    code: 'invalid_value',
  });
  let called = false;
  const accessor = {
    ...registration(),
    get alias() {
      called = true;
      return 'unsafe';
    },
  };
  assert.throws(() => client.assets.register(accessor), {
    code: 'invalid_value',
  });
  assert.equal(called, false);
  const edit = client.assets.update({
    asset_id: registered.id,
    request_id: uuid(),
    expected_edit_revision: registered.edit_revision,
    alias: null,
  });
  const cleared = success((await edit.send()).attempt).data.asset;
  assert.equal(Object.hasOwn(cleared, 'alias'), false);
  client.tasks.create(task(registered.id));
  assert.throws(() => client.tasks.create(task(registered.id)), {
    code: 'capacity',
  });
  assert.equal(client.assets.register(facts).outcome.kind, 'accepted');
  assert.throws(() => client.assets.register({ ...facts, alias: 'conflict' }), {
    code: 'identity_conflict',
  });
});

test('public request options cannot replace the submitted response context', async (t) => {
  const f = await fixture(t),
    client = await connected(f);
  const registered = await asset(client);
  const other = { ...registered, id: uuid() };
  f.once('/messages/get_asset', ({ body, forward }) => {
    const changed = JSON.parse(body);
    changed.data = other;
    forward(Buffer.from(JSON.stringify(changed)));
  });
  const result = await client.assets.get(
    { asset_id: registered.id },
    { selection: { asset_id: other.id } },
  );
  assert.equal(result.kind, 'failed');
  assert.equal(result.code, 'invalid_http');
  const operation = client.tasks.create(task(registered.id));
  const accepted = await operation.send({ selection: task(uuid()) });
  assert.equal(accepted.outcome.kind, 'accepted');
  assert.equal(success(accepted.attempt).data.asset_id, registered.id);
});

test('same-Dataset restart keeps exact retries and close drains active attempts', async (t) => {
  const f = await fixture(t),
    client = await connected(f);
  const registered = await asset(client);
  const operation = client.tasks.create(task(registered.id));
  const original = success((await operation.send()).attempt);
  await f.restart();
  success(await client.connect());
  assert.equal(success((await operation.send()).attempt).commit_cursor, original.commit_cursor);
  const waiting = barrier(),
    release = barrier();
  f.once('/messages/get_asset', async ({ forward }) => {
    waiting.resolve();
    await release.promise;
    forward();
  });
  const pending = client.assets.get({ asset_id: registered.id });
  await waiting.promise;
  await client.close();
  release.resolve();
  assert.equal((await pending).kind, 'failed');
  assert.equal(client.state.kind, 'closed');
  const before = f.traffic.length;
  assert.equal((await operation.send()).attempt.code, 'closed');
  assert.equal(operation.outcome.kind, 'accepted');
  assert.equal(f.traffic.length, before);
});
