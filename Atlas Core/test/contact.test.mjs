import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { fixture, uuid, registration, report } from './helpers.mjs';
const ok = (r) => {
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.data;
};
test('valid contact proof survives superseded sections without replacing newer state', async (t) => {
  const f = await fixture(t);
  const asset = ok(await f.call('RegisterAsset', registration())).asset;
  const health = ok(await f.call('GetHealth'));
  const challenge = ok(
    await f.call('BeginAssetContact', {
      allocation_context: health.allocation_context,
      request_id: uuid(),
      asset_id: asset.id,
      process_generation: asset.process_generation,
      mode: 'current',
    }),
  );
  const origin = { kind: 'asset_process', process_generation: asset.process_generation };
  const status = (condition) => ({
    state: 'value',
    classification: 'state_until_changed',
    observed_at: null,
    value: { condition },
  });
  const proof = {
    ...report(f.core.dataset, asset.id, origin, 1, { status: status('unknown') }),
    generated_at: challenge.issued_at,
    contact_proof: { challenge_id: challenge.challenge_id },
  };
  const newer = ok(
    await f.call('UpdateAsset', {
      request_id: uuid(),
      asset_id: asset.id,
      report: report(f.core.dataset, asset.id, origin, 2, { status: status('healthy') }),
    }),
  ).asset;
  assert.equal(newer.heartbeat.last_contact_at, null);
  assert.equal(newer.communications.health, 'offline');

  const invalid = await f.call('UpdateAsset', {
    request_id: uuid(),
    asset_id: asset.id,
    report: { ...proof, generated_at: new Date(Date.parse(challenge.issued_at) - 1).toISOString() },
  });
  assert.equal(invalid.status, 409);
  assert.equal(invalid.json.error.code, 'challenge_context_mismatch');
  assert.deepEqual(ok(await f.call('GetAsset', { asset_id: asset.id })), newer);
  const input = { request_id: uuid(), asset_id: asset.id, report: proof };
  const first = await f.call('UpdateAsset', input);
  const accepted = ok(first);
  assert.equal(accepted.evidence_disposition, 'accepted');
  assert.deepEqual(accepted.asset.status, newer.status);
  assert.equal(accepted.asset.communications.health, 'healthy');
  assert.notEqual(accepted.asset.heartbeat.last_contact_at, null);
  assert.equal(accepted.asset.version, String(BigInt(newer.version) + 1n));
  const replay = await f.call('UpdateAsset', input);
  assert.equal(ok(replay).evidence_disposition, 'duplicate');
  assert.deepEqual(replay.json.data.asset, accepted.asset);
  assert.equal(replay.json.commit_cursor, first.json.commit_cursor);
  const duplicate = ok(await f.call('UpdateAsset', { ...input, request_id: uuid() }));
  assert.equal(duplicate.evidence_disposition, 'duplicate');
  assert.deepEqual(duplicate.asset, accepted.asset);
  const reused = await f.call('UpdateAsset', {
    request_id: uuid(),
    asset_id: asset.id,
    report: { ...proof, report_id: uuid(), sequence: '3' },
  });
  assert.equal(reused.status, 409);
  assert.equal(reused.json.error.code, 'challenge_consumed');
  assert.deepEqual(ok(await f.call('GetAsset', { asset_id: asset.id })), accepted.asset);
  const changes = ok(
    await f.call('ReadChanges', {
      from_cursor: first.json.commit_cursor,
      max_message_bytes: 4194304,
      max_json_values: 262144,
      max_changes: 1000,
    }),
  );
  assert.deepEqual(changes.messages, []);
});
test(
  'contact proof expiry, duplicate non-refresh and 15/60 second transitions commit without packets',
  { timeout: 75000 },
  async (t) => {
    const f = await fixture(t);
    const a = ok(await f.call('RegisterAsset', registration())).asset;
    const b = ok(await f.call('RegisterAsset', registration())).asset;
    const health = ok(await f.call('GetHealth'));
    const challenge = async (asset) =>
      ok(
        await f.call('BeginAssetContact', {
          allocation_context: health.allocation_context,
          request_id: uuid(),
          asset_id: asset.id,
          process_generation: asset.process_generation,
          mode: 'current',
        }),
      );
    const ca = await challenge(a),
      cb = await challenge(b);
    const envelope = (asset, c) => ({
      ...report(
        f.core.dataset,
        asset.id,
        { kind: 'asset_process', process_generation: asset.process_generation },
        1,
        {},
      ),
      contact_proof: { challenge_id: c.challenge_id },
    });
    const input = { asset_id: a.id, request_id: uuid(), report: envelope(a, ca) };
    const pending = { asset_id: b.id, request_id: uuid(), report: envelope(b, cb) };
    const first = await f.call('UpdateAsset', input);
    assert.equal(ok(first).asset.communications.health, 'healthy');
    const admitted = performance.now();
    await setTimeout(10300);
    assert.equal((await f.call('UpdateAsset', pending)).json.error.code, 'challenge_expired');
    assert.equal(ok(await f.call('UpdateAsset', input)).evidence_disposition, 'duplicate');
    await setTimeout(Math.max(0, admitted + 15600 - performance.now()));
    assert.equal(
      ok(await f.call('GetAsset', { asset_id: a.id })).communications.health,
      'degraded',
    );
    await setTimeout(Math.max(0, admitted + 60600 - performance.now()));
    const offline = ok(await f.call('GetAsset', { asset_id: a.id }));
    assert.equal(offline.communications.health, 'offline');
    assert.equal(ok(await f.call('GetAsset', { asset_id: b.id })).heartbeat.last_contact_at, null);
    const changes = ok(
      await f.call('ReadChanges', {
        from_cursor: first.json.commit_cursor,
        max_message_bytes: 4194304,
        max_json_values: 262144,
        max_changes: 1000,
      }),
    );
    assert.deepEqual(
      changes.messages.flatMap((m) =>
        m.type === 'change_batch'
          ? m.data.changes
              .filter((c) => c.kind === 'put' && c.resource_id === a.id)
              .map((c) => c.image.communications.health)
          : [],
      ),
      ['degraded', 'offline'],
    );
    assert.equal(ok(await f.call('GetHealth')).healthy, true);
  },
);
test('successful replacement retry precedes generation checks and never reuses a generation', async (t) => {
  const f = await fixture(t);
  const asset = ok(await f.call('RegisterAsset', registration())).asset;
  const health = ok(await f.call('GetHealth'));
  const generation = uuid();
  const challenge = ok(
    await f.call('BeginAssetContact', {
      allocation_context: health.allocation_context,
      request_id: uuid(),
      asset_id: asset.id,
      process_generation: generation,
      expected_process_generation: asset.process_generation,
      mode: 'replace',
    }),
  );
  const firstReport = {
    ...report(
      f.core.dataset,
      asset.id,
      { kind: 'asset_process', process_generation: generation },
      1,
      {},
    ),
    contact_proof: { challenge_id: challenge.challenge_id },
  };
  const input = {
    request_id: uuid(),
    asset_id: asset.id,
    expected_process_generation: asset.process_generation,
    process_generation: generation,
    challenge_id: challenge.challenge_id,
    first_report: firstReport,
  };
  const first = await f.call('ReplaceAssetProcess', input);
  ok(first);
  const second = await f.call('ReplaceAssetProcess', input);
  assert.equal(ok(second).evidence_disposition, 'duplicate');
  assert.equal(first.json.commit_cursor, second.json.commit_cursor);
  assert.equal(
    (
      await f.call('BeginAssetContact', {
        allocation_context: health.allocation_context,
        request_id: uuid(),
        asset_id: asset.id,
        expected_process_generation: generation,
        process_generation: asset.process_generation,
        mode: 'replace',
      })
    ).json.error.code,
    'generation_mismatch',
  );
  const obsolete = report(
    f.core.dataset,
    asset.id,
    { kind: 'asset_process', process_generation: asset.process_generation },
    1,
    {
      status: {
        state: 'value',
        classification: 'state_until_changed',
        observed_at: null,
        value: { condition: 'healthy' },
      },
    },
  );
  assert.equal(
    (await f.call('UpdateAsset', { asset_id: asset.id, request_id: uuid(), report: obsolete })).json
      .error.code,
    'generation_mismatch',
  );
});
test('replacement retries recover the original generation after another replacement and Restart', async (t) => {
  const f = await fixture(t);
  const original = ok(await f.call('RegisterAsset', registration())).asset;
  const health = ok(await f.call('GetHealth'));
  async function replace(asset) {
    const generation = uuid();
    const challenge = ok(
      await f.call('BeginAssetContact', {
        allocation_context: health.allocation_context,
        request_id: uuid(),
        asset_id: asset.id,
        process_generation: generation,
        expected_process_generation: asset.process_generation,
        mode: 'replace',
      }),
    );
    const request = {
      request_id: uuid(),
      asset_id: asset.id,
      expected_process_generation: asset.process_generation,
      process_generation: generation,
      challenge_id: challenge.challenge_id,
      first_report: {
        ...report(
          f.core.dataset,
          asset.id,
          { kind: 'asset_process', process_generation: generation },
          1,
          {},
        ),
        generated_at: challenge.issued_at,
        contact_proof: { challenge_id: challenge.challenge_id },
      },
    };
    const response = await f.call('ReplaceAssetProcess', request);
    assert.equal(ok(response).evidence_disposition, 'accepted');
    return { request, response, asset: response.json.data.asset };
  }
  const first = await replace(original);
  const second = await replace(first.asset);
  for (const restart of [false, true]) {
    if (restart) await f.restart();
    const current = await f.call('GetAsset', { asset_id: original.id });
    assert.equal(ok(current).process_generation, second.request.process_generation);
    const before = ok(
      await f.call('ReadChanges', {
        from_cursor: second.response.json.commit_cursor,
        max_message_bytes: 4194304,
        max_json_values: 262144,
        max_changes: 1000,
      }),
    );
    const replay = await f.call('ReplaceAssetProcess', first.request);
    assert.equal(ok(replay).evidence_disposition, 'duplicate');
    assert.deepEqual(replay.json.data.asset, first.asset);
    assert.equal(replay.json.commit_cursor, first.response.json.commit_cursor);
    const conflicting = await f.call('ReplaceAssetProcess', {
      ...first.request,
      first_report: { ...first.request.first_report, report_id: uuid() },
    });
    assert.equal(conflicting.status, 409);
    assert.equal(conflicting.json.error.code, 'identity_conflict');
    assert.deepEqual(ok(await f.call('GetAsset', { asset_id: original.id })), current.json.data);
    const changes = ok(
      await f.call('ReadChanges', {
        from_cursor: before.through_cursor,
        max_message_bytes: 4194304,
        max_json_values: 262144,
        max_changes: 1000,
      }),
    );
    assert.deepEqual(changes.messages, []);
  }
});
test('replacement with a snapshot or history receipt refuses the challenge context without changing generation', async (t) => {
  const f = await fixture(t);
  const asset = ok(await f.call('RegisterAsset', registration())).asset;
  const health = ok(await f.call('GetHealth'));
  const snapshot = ok(
    await f.call('ReadSnapshot', {
      load_id: uuid(),
      allocation_context: health.allocation_context,
      page_size: 100,
      max_message_bytes: 4194304,
      max_json_values: 262144,
      max_changes: 1000,
    }),
  );
  const history = ok(
    await f.call('GetAssetMovementHistory', {
      query_id: uuid(),
      entity_id: asset.id,
      allocation_context: health.allocation_context,
    }),
  );
  for (const challenge_id of [snapshot.capture_id, history.view_id]) {
    const process_generation = uuid();
    const response = await f.call('ReplaceAssetProcess', {
      request_id: uuid(),
      asset_id: asset.id,
      expected_process_generation: asset.process_generation,
      process_generation,
      challenge_id,
      first_report: {
        ...report(f.core.dataset, asset.id, { kind: 'asset_process', process_generation }, 1, {}),
        contact_proof: { challenge_id },
      },
    });
    assert.equal(response.status, 409);
    assert.equal(response.json.error.code, 'challenge_context_mismatch');
    assert.equal(
      ok(await f.call('GetAsset', { asset_id: asset.id })).process_generation,
      asset.process_generation,
    );
  }
});
