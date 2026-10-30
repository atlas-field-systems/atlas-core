import { PROTOCOL_VERSION, exchanges, readHttp } from '@atlas/protocol';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, uuid, secret, registration } from './helpers.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { Worker } from 'node:worker_threads';

const ok = (result) => {
  assert.equal(result.status, 200, JSON.stringify(result.json));
  return result.json.data;
};
test('HTTP refuses API 0.1.0 and 0.2.0 before reserving registration identities', async (t) => {
  const f = await fixture(t);
  for (const version of ['0.1.0', '0.2.0']) {
    const request = registration(`Version ${version}`);
    for (const [name, input] of [
      ['GetReadiness', {}],
      ['ListTasks', {}],
      ['RegisterAsset', request],
    ]) {
      const refused = await f.call(name, input, { 'Atlas-Protocol-Version': version });
      assert.equal(refused.status, 409, name);
      assert.equal(refused.headers['atlas-protocol-version'], PROTOCOL_VERSION);
      assert.equal(refused.headers['atlas-dataset-id'], f.core.dataset);
      const parsed = readHttp(
        exchanges[name],
        { status: refused.status, headers: new Headers(refused.headers), body: refused.bytes },
        { datasetId: f.core.dataset, request: input },
      );
      assert.equal(parsed.kind, 'error');
      assert.equal(parsed.body.error.code, 'protocol_mismatch');
      assert.deepEqual(parsed.body.error.details, { protocol_version: PROTOCOL_VERSION });
    }
    const missing = await f.call('GetAsset', { asset_id: request.asset_id });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, 'asset_not_found');
    assert.deepEqual(
      ok(await f.call('ListApiKeys', { filters: { ids: [request.api_key_id] } })).items,
      [],
    );
    const accepted = await f.call('RegisterAsset', request);
    assert.equal(ok(accepted).asset.id, request.asset_id);
    assert.equal(
      (await f.call('RegisterAsset', request)).json.commit_cursor,
      accepted.json.commit_cursor,
    );
    assert.deepEqual(
      ok(await f.call('ListAssets', { filters: { ids: [request.asset_id] } })).items.map(
        (asset) => asset.id,
      ),
      [request.asset_id],
    );
  }
});
test('original bytes, actual context and ignored diagnostic header defects', async (t) => {
  const f = await fixture(t, { trustedOrigins: ['https://example.test'] });
  const failures = [
    [await f.call('GetHealth', {}, { Authorization: null }), 401, 'unauthorized'],
    [await f.call('GetHealth', {}, { Authorization: `Bearer ${secret()}` }), 401, 'unauthorized'],
    [await f.call('GetReadiness', {}, { 'Atlas-Dataset-ID': null }), 400, 'dataset_required'],
    [await f.call('GetReadiness', {}, { 'Atlas-Dataset-ID': uuid() }), 409, 'dataset_mismatch'],
    [
      await f.call('GetReadiness', {}, { 'Atlas-Protocol-Version': '0.0.1' }),
      409,
      'protocol_mismatch',
    ],
    [
      await f.http(
        'POST',
        '/messages/list_assets',
        Buffer.from('{"page_size":1,"page_s\\u0069ze":2}'),
      ),
      400,
      'invalid_request',
    ],
    [
      await f.http(
        'POST',
        '/messages/list_assets',
        Buffer.from('{"page_size":100.0000000000000000001}'),
      ),
      400,
      'invalid_request',
    ],
    [
      await f.http('POST', '/messages/list_assets', Buffer.from('{"unused":true}')),
      400,
      'invalid_request',
    ],
    [
      await f.http(
        'POST',
        '/messages/list_assets',
        Buffer.from([123, 34, 120, 34, 58, 34, 0xff, 34, 125]),
      ),
      400,
      'invalid_request',
    ],
    [
      await f.http('POST', '/messages/list_assets', Buffer.alloc(1048577, 32)),
      413,
      'payload_too_large',
    ],
    [await f.call('ListAssets', {}, { 'Content-Encoding': 'gzip' }), 400, 'invalid_request'],
    [await f.call('ListAssets', { filters: { unsupported: [] } }), 422, 'unsupported_filter'],
    [
      await f.call('CreateTask', {
        request_id: uuid(),
        task_id: uuid(),
        asset_id: uuid(),
        command: 'move_to',
        scheduling: 'immediate',
        inputs: { target: { kind: 'position', position: { latitude: 0, longitude: 0 } } },
      }),
      422,
      'unsupported_command',
    ],
  ];
  for (const [result, status, code] of failures) {
    assert.equal(result.status, status);
    assert.equal(result.json.error.code, code);
    assert.equal(result.headers['atlas-dataset-id'], f.core.dataset);
    assert.equal(result.headers['atlas-request-id'], result.json.error.request_id);
    if (status === 401) assert.equal(result.headers['www-authenticate'], 'Bearer');
  }
  assert.equal(
    (await f.http('POST', '/messages/list_assets', Buffer.from('{"page_size":1e2}'))).status,
    200,
  );
  const creation = registration('Boundary');
  const first = await f.call('RegisterAsset', creation, {
    'Atlas-Attempt-ID': ['malformed', 'second'],
  });
  ok(first);
  const retry = await f.call('RegisterAsset', JSON.parse(JSON.stringify(creation)), {
    'Atlas-Attempt-ID': uuid(),
  });
  assert.equal(ok(retry).asset.id, creation.asset_id);
  assert.equal(retry.json.commit_cursor, first.json.commit_cursor);
  const trusted = await f.call('GetHealth', {}, { Origin: 'https://example.test' });
  assert.equal(trusted.headers['access-control-allow-origin'], 'https://example.test');
  assert.match(trusted.headers['access-control-expose-headers'], /Atlas-Request-ID/);
  assert.equal((await f.call('GetHealth', {}, { Origin: 'https://untrusted.test' })).status, 400);
  await f.core.diagnostics.close();
  const logs = await readFile(join(f.directory, 'logs', 'events.0.jsonl'), 'utf8');
  assert.ok(!logs.includes(creation.secret));
  assert.ok(!logs.includes(f.apiKey));
  assert.ok(!logs.includes('malformed'));
  assert.ok(!logs.includes('https://example.test'));
});
test('local open enrollment stays off by default and public registration always needs a key', async (t) => {
  const f = await fixture(t, { openEnrollment: true });
  const input = registration('Open');
  assert.equal((await f.call('RegisterAsset', input, { Authorization: null })).status, 401);
  const enrolled = await f.core.rpc.call(
    'open-enroll',
    { dataset: f.core.dataset, request: input },
    65536,
    true,
  );
  const inspected = await f.core.rpc.call('enrollment-inspect', {}, 65536, true);
  assert.equal(inspected.bindings.length, 1);
  assert.equal(inspected.bindings[0].binding_id, enrolled.binding_id);
  assert.equal(
    (await f.call('GetHealth', {}, { Authorization: `Bearer ${input.secret}` })).status,
    200,
  );
  await f.core.rpc.call(
    'enrollment-revoke',
    { binding: enrolled.binding_id, key: input.api_key_id, confirm: true },
    1024,
    true,
  );
  assert.equal(
    (await f.call('GetHealth', {}, { Authorization: `Bearer ${input.secret}` })).status,
    401,
  );
});
test('operator deletion serializes key binding and revokes every explicitly bound key', async (t) => {
  const f = await fixture(t);
  const operator = uuid();
  ok(await f.call('CreateOperator', { operator_id: operator, request_id: uuid(), name: 'Pilot' }));
  const key = { api_key_id: uuid(), request_id: uuid(), secret: secret(), operator_id: operator };
  ok(await f.call('CreateApiKey', key));
  const deletion = { operator_id: operator, request_id: uuid() };
  ok(await f.call('DeleteOperator', deletion));
  ok(await f.call('DeleteOperator', deletion));
  assert.equal(
    (await f.call('GetHealth', {}, { Authorization: `Bearer ${key.secret}` })).status,
    401,
  );
  const recovered = ok(await f.call('CreateApiKey', key));
  assert.equal(recovered.api_key_id, key.api_key_id);
  assert.notEqual(recovered.revoked_at, null);
  assert.equal(
    (
      await f.call('CreateApiKey', {
        ...key,
        request_id: uuid(),
        api_key_id: uuid(),
        secret: secret(),
      })
    ).json.error.code,
    'operator_deleted',
  );
  const unknown = await f.call('CreateApiKey', {
    api_key_id: uuid(),
    request_id: uuid(),
    secret: secret(),
    operator_id: uuid(),
  });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, 'operator_not_found');
  const racedOperator = uuid();
  ok(
    await f.call('CreateOperator', {
      operator_id: racedOperator,
      request_id: uuid(),
      name: 'Crew',
    }),
  );
  const racedKey = {
    api_key_id: uuid(),
    request_id: uuid(),
    secret: secret(),
    operator_id: racedOperator,
  };
  const [binding, removed] = await Promise.all([
    f.call('CreateApiKey', racedKey),
    f.call('DeleteOperator', { operator_id: racedOperator, request_id: uuid() }),
  ]);
  ok(removed);
  assert.ok(binding.status === 200 || binding.status === 410, JSON.stringify(binding.json));
  assert.equal(
    (await f.call('GetHealth', {}, { Authorization: `Bearer ${racedKey.secret}` })).status,
    401,
  );
  assert.equal(
    (await f.call('CreateOperator', { operator_id: operator, request_id: uuid(), name: 'Again' }))
      .json.error.code,
    'operator_deleted',
  );
  assert.equal(
    (await f.call('DeleteOperator', { operator_id: operator, request_id: uuid() })).json.error.code,
    'operator_deleted',
  );
});
test('a lost response retains the commit and concurrent structural retries create one Asset', async (t) => {
  const f = await fixture(t);
  const input = registration('Lost reply');
  const body = Buffer.from(JSON.stringify(input));
  await new Promise((resolve, reject) => {
    const request = httpsRequest(
      new URL('/messages/register_asset', f.address),
      {
        method: 'POST',
        ca: f.ca,
        headers: {
          Authorization: `Bearer ${f.apiKey}`,
          'Atlas-Dataset-ID': f.core.dataset,
          'Atlas-Protocol-Version': '0.3.0',
          'Content-Type': 'application/json',
          'Content-Length': body.length,
        },
      },
      (response) => {
        assert.equal(response.statusCode, 200);
        response.on('error', () => {});
        response.destroy();
        resolve();
      },
    );
    request.on('error', reject);
    request.end(body);
  });
  const reversed = Object.fromEntries(Object.entries(input).reverse());
  const results = await Promise.all([
    f.call('RegisterAsset', input),
    f.call('RegisterAsset', reversed),
  ]);
  assert.equal(ok(results[0]).asset.id, input.asset_id);
  assert.equal(ok(results[1]).asset.id, input.asset_id);
  assert.equal(results[0].json.commit_cursor, results[1].json.commit_cursor);
  assert.deepEqual(
    ok(await f.call('ListAssets')).items.map((asset) => asset.id),
    [input.asset_id],
  );
});
test('ordinary key retries cannot be reused for Asset registration', async (t) => {
  const f = await fixture(t);
  const input = registration('Credential context');
  const creation = {
    request_id: input.request_id,
    api_key_id: input.api_key_id,
    secret: input.secret,
  };
  const first = await f.call('CreateApiKey', creation);
  const key = ok(first);
  const retry = await f.call('CreateApiKey', creation);
  assert.deepEqual(ok(retry), key);
  assert.equal(retry.json.commit_cursor, first.json.commit_cursor);

  const reused = await f.call('RegisterAsset', input);
  assert.equal(reused.status, 409);
  assert.equal(reused.json.error.code, 'identity_conflict');
  assert.equal(
    (await f.call('GetAsset', { asset_id: input.asset_id })).json.error.code,
    'asset_not_found',
  );
  assert.deepEqual(ok(await f.call('ListAssets')).items, []);
  assert.deepEqual(ok(await f.call('CreateApiKey', creation)), key);

  const fresh = { ...input, request_id: uuid(), api_key_id: uuid(), secret: secret() };
  const enrolled = await f.call('RegisterAsset', fresh);
  const asset = ok(enrolled).asset;
  const edited = ok(
    await f.call('UpdateAsset', {
      request_id: uuid(),
      asset_id: asset.id,
      expected_edit_revision: asset.edit_revision,
      alias: 'Edited credential context',
    }),
  ).asset;
  const registrationRetry = await f.call('RegisterAsset', fresh);
  assert.deepEqual(ok(registrationRetry).asset, edited);
  assert.equal(registrationRetry.json.commit_cursor, enrolled.json.commit_cursor);
  assert.equal(
    (await f.call('GetHealth', {}, { Authorization: `Bearer ${fresh.secret}` })).status,
    200,
  );
  ok(await f.call('DeleteAsset', { request_id: uuid(), asset_id: fresh.asset_id }));
  assert.equal(
    (await f.call('GetHealth', {}, { Authorization: `Bearer ${fresh.secret}` })).status,
    401,
  );
  assert.equal(
    (await f.call('GetHealth', {}, { Authorization: `Bearer ${creation.secret}` })).status,
    200,
  );
  assert.equal((await f.call('RegisterAsset', fresh)).json.error.code, 'asset_not_found');
});
test('Asset registration keys cannot replay as ordinary key creation', async (t) => {
  const f = await fixture(t);
  const input = registration();
  const registered = ok(await f.call('RegisterAsset', input));
  const reused = await f.call('CreateApiKey', {
    request_id: input.request_id,
    api_key_id: input.api_key_id,
    secret: input.secret,
  });
  assert.equal(reused.status, 409);
  assert.equal(reused.json.error.code, 'identity_conflict');
  assert.deepEqual(ok(await f.call('RegisterAsset', input)), registered);
});
test('ordinary key retries survive Reset and retained Asset credentials keep their context', async (t) => {
  const f = await fixture(t);
  const creation = { request_id: uuid(), api_key_id: uuid(), secret: secret() };
  const first = await f.call('CreateApiKey', creation);
  const key = ok(first);
  const registered = registration();
  ok(await f.call('RegisterAsset', registered));
  await f.core.close();
  const dataset = uuid();
  const established = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../dist/offline.js', import.meta.url), {
      workerData: {
        mode: 'establish',
        directory: f.directory,
        settings: f.settings,
        dataset,
        action: uuid(),
        hard: false,
      },
    });
    let result;
    worker.on('message', (value) => {
      result = value;
    });
    worker.once('error', reject);
    worker.once('exit', (code) =>
      code === 0 ? resolve(result) : reject(new Error('offline_failed')),
    );
  });
  assert.equal(established.established, true);
  await f.restart();
  assert.equal(f.core.dataset, dataset);
  const repeated = await f.call('CreateApiKey', creation);
  assert.deepEqual(ok(repeated), key);
  assert.equal(repeated.json.dataset_id, dataset);
  assert.equal(repeated.json.commit_cursor, f.core.dataset + '/00000000000000000000');
  assert.equal(
    (await f.call('GetHealth', {}, { Authorization: `Bearer ${registered.secret}` })).status,
    200,
  );
  const reused = await f.call('CreateApiKey', {
    request_id: registered.request_id,
    api_key_id: registered.api_key_id,
    secret: registered.secret,
  });
  assert.equal(reused.status, 409);
  assert.equal(reused.json.error.code, 'identity_conflict');
  assert.equal((await f.call('RegisterAsset', registered)).json.error.code, 'identity_conflict');
  const replacement = { ...registration(), asset_id: registered.asset_id };
  ok(await f.call('RegisterAsset', replacement));
  ok(await f.call('DeleteAsset', { request_id: uuid(), asset_id: replacement.asset_id }));
  assert.equal(
    (await f.call('GetHealth', {}, { Authorization: `Bearer ${replacement.secret}` })).status,
    401,
  );
  assert.equal(
    (await f.call('GetHealth', {}, { Authorization: `Bearer ${registered.secret}` })).status,
    200,
  );
  assert.deepEqual(ok(await f.call('CreateApiKey', creation)), key);
});
test('self-revocation commits before its validated 401 and exact retry reconciles after Restart', async (t) => {
  const f = await fixture(t);
  const credential = { request_id: uuid(), api_key_id: uuid(), secret: secret() };
  ok(await f.call('CreateApiKey', credential));
  const request = { request_id: uuid(), api_key_id: credential.api_key_id };
  const denied = await f.call('RevokeApiKey', request, {
    Authorization: `Bearer ${credential.secret}`,
  });
  const parsed = readHttp(
    exchanges.RevokeApiKey,
    { status: denied.status, headers: new Headers(denied.headers), body: denied.bytes },
    { datasetId: f.core.dataset, request },
  );
  assert.equal(parsed.kind, 'error');
  assert.equal(parsed.body.error.code, 'unauthorized');
  assert.equal(
    (await f.call('GetHealth', {}, { Authorization: `Bearer ${credential.secret}` })).status,
    401,
  );
  const recovered = await f.call('RevokeApiKey', request);
  assert.notEqual(ok(recovered).revoked_at, null);
  assert.ok(recovered.json.commit_cursor);
  await f.restart();
  const retry = await f.call('RevokeApiKey', request);
  assert.deepEqual(ok(retry), recovered.json.data);
  assert.equal(retry.json.commit_cursor, recovered.json.commit_cursor);
});
test('a lost successful mutation followed by a denied retry retains its committed effect', async (t) => {
  const f = await fixture(t);
  const credential = { request_id: uuid(), api_key_id: uuid(), secret: secret() };
  ok(await f.call('CreateApiKey', credential));
  const input = { request_id: uuid(), operator_id: uuid(), name: 'Lost success' };
  const bytes = Buffer.from(JSON.stringify(input));
  await new Promise((resolve, reject) => {
    const request = httpsRequest(
      new URL(exchanges.CreateOperator.path, f.address),
      {
        method: 'POST',
        ca: f.ca,
        headers: {
          Authorization: `Bearer ${credential.secret}`,
          'Atlas-Dataset-ID': f.core.dataset,
          'Atlas-Protocol-Version': PROTOCOL_VERSION,
          'Content-Type': 'application/json',
          'Content-Length': bytes.length,
        },
      },
      (response) => {
        assert.equal(response.statusCode, 200);
        response.on('error', () => {});
        response.destroy();
        resolve();
      },
    );
    request.on('error', reject);
    request.end(bytes);
  });
  ok(await f.call('RevokeApiKey', { request_id: uuid(), api_key_id: credential.api_key_id }));
  const denied = await f.call('CreateOperator', input, {
    Authorization: `Bearer ${credential.secret}`,
  });
  const parsed = readHttp(
    exchanges.CreateOperator,
    { status: denied.status, headers: new Headers(denied.headers), body: denied.bytes },
    { datasetId: f.core.dataset, request: input },
  );
  assert.equal(parsed.kind, 'error');
  assert.equal(parsed.body.error.code, 'unauthorized');
  assert.equal(
    ok(await f.call('GetOperator', { operator_id: input.operator_id })).name,
    input.name,
  );
  const recovered = await f.call('CreateOperator', input);
  assert.equal(ok(recovered).operator_id, input.operator_id);
  assert.ok(recovered.json.commit_cursor);
  const repeated = await f.call('CreateOperator', input);
  assert.equal(repeated.json.commit_cursor, recovered.json.commit_cursor);
  assert.deepEqual(ok(repeated), recovered.json.data);
});
