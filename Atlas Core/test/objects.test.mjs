import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile, readdir, stat, rm, readFile, open } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { Agent, request as httpsRequest } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fixture, uuid, registration, secret, root } from './helpers.mjs';
import { Engine } from '../dist/engine.js';
import { processIdentity } from '../dist/ownership.js';
import { digest } from '../dist/exact.js';
import { defaults } from '../dist/settings.js';
import { diskUsage } from '../dist/capacity.js';
import { Transfers } from '../dist/transfers.js';
const ok = (r) => {
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.data;
};
const descriptor = (bytes) => ({
  request_id: uuid(),
  object_id: uuid(),
  byte_length: String(bytes.byteLength),
  sha256: createHash('sha256').update(bytes).digest('hex'),
  content_type: 'application/octet-stream',
  metadata: { associations: [] },
});
for (const boundary of ['authorization', 'between parts'])
  test(`aborted upload settles across ${boundary} and shutdown reclaims its resources`, async (t) => {
    const held = Promise.withResolvers(),
      release = Promise.withResolvers(),
      started = Promise.withResolvers(),
      rawClosed = Promise.withResolvers();
    const f = await fixture(
      {
        after: (action) =>
          t.after(async () => {
            release.resolve();
            await action();
          }),
      },
      { maxUploads: 1 },
    );
    const bytes = Buffer.from('interrupted content'),
      input = descriptor(bytes);
    const db = new Database(join(f.directory, 'core.sqlite'), { readonly: true });
    t.after(() => db.close());
    const cursor = db.prepare("SELECT value FROM core_meta WHERE key='sequence'").get().value;
    const originalCall = f.core.rpc.call,
      originalUpload = Transfers.prototype.upload;
    let first = true,
      receiving;
    t.mock.method(f.core.rpc, 'call', async function (kind, ...args) {
      const result = await originalCall.call(this, kind, ...args);
      if (first && kind === (boundary === 'authorization' ? 'authorize' : 'upload-written')) {
        first = false;
        held.resolve();
        await release.promise;
      }
      return result;
    });
    t.mock.method(Transfers.prototype, 'upload', function (...args) {
      const work = originalUpload.apply(this, args);
      receiving = work.then(
        () => assert.fail('Aborted upload cannot succeed'),
        (error) => error,
      );
      started.resolve();
      return work;
    });
    let raw;
    f.core.app.server.once('request', (request) => {
      raw = request;
      request.once('close', rawClosed.resolve);
    });
    const req = httpsRequest(new URL('/objects', f.address), {
      method: 'POST',
      ca: f.ca,
      headers: {
        Authorization: `Bearer ${f.apiKey}`,
        'Atlas-Dataset-ID': f.core.dataset,
        'Atlas-Protocol-Version': '0.3.0',
        'Content-Type': 'multipart/form-data; boundary=interrupted',
      },
    });
    req.on('error', () => {});
    t.after(() => req.destroy());
    const clientClosed = new Promise((resolve) => req.once('close', resolve));
    if (boundary === 'authorization') req.flushHeaders();
    else
      req.write(
        Buffer.concat([
          Buffer.from(
            '--interrupted\r\nContent-Disposition: form-data; name="file"; filename="owned.bin"\r\n\r\n',
          ),
          bytes,
          Buffer.from(
            `\r\n--interrupted\r\nContent-Disposition: form-data; name="descriptor"\r\n\r\n${JSON.stringify(input)}`,
          ),
        ]),
      );
    await held.promise;
    if (boundary === 'between parts') {
      assert.deepEqual(db.prepare('SELECT state,bytes FROM object_attempts').all(), [
        { state: 'active', bytes: bytes.length },
      ]);
      const staging = join(f.directory, 'objects', 'staging');
      const names = await readdir(staging);
      assert.equal(names.length, 1);
      assert.deepEqual(await readFile(join(staging, names[0])), bytes);
    }
    req.destroy();
    await Promise.all([clientClosed, rawClosed.promise]);
    assert.equal(raw.aborted, true);
    assert.equal(raw.destroyed, true);
    assert.equal(raw.readableEnded, false);
    release.resolve();
    await started.promise;
    t.diagnostic(
      JSON.stringify({
        boundary,
        aborted: raw.aborted,
        destroyed: raw.destroyed,
        complete: raw.complete,
        readableEnded: raw.readableEnded,
      }),
    );
    await f.core.close();
    assert.ok((await receiving) instanceof Error);
    assert.equal(f.core.rpc.worker.threadId, -1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM object_images').get().count, 0);
    assert.equal(
      db.prepare("SELECT value FROM core_meta WHERE key='sequence'").get().value,
      cursor,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM object_attempts WHERE state<>'reclaimed'").get()
        .count,
      0,
    );
    assert.deepEqual(await readdir(join(f.directory, 'objects', 'staging')), []);
    assert.deepEqual(await readdir(join(f.directory, 'objects', 'installed')), []);
  });
for (const failBookkeeping of [false, true])
  test(
    `shutdown awaits active reclamation and preserves failure=${failBookkeeping}`,
    { timeout: 15_000 },
    async (t) => {
      const f = await fixture({ after() {} });
      const held = Promise.withResolvers(),
        release = Promise.withResolvers();
      t.after(async () => {
        release.resolve();
        await f.core.close().catch(() => {});
        await rm(f.directory, { recursive: true, force: true });
      });
      const bytes = Buffer.from('retired content'),
        input = descriptor(bytes);
      ok(await f.upload(input, bytes));
      const files = join(f.directory, 'objects', 'installed');
      const file = join(files, (await readdir(files))[0]);
      const original = f.core.rpc.call;
      const failure = new Error('reclamation_bookkeeping_failed');
      let recorded = false;
      t.mock.method(f.core.rpc, 'call', async function (kind, ...args) {
        if (kind === 'file-reclaimed') {
          assert.equal(this.available, true, 'Reclamation still owns a live worker');
          if (failBookkeeping) throw failure;
        }
        const result = await original.call(this, kind, ...args);
        if (kind === 'file-reclaimed') recorded = true;
        if (kind === 'retired-files' && result.some((row) => row.object === input.object_id)) {
          held.resolve();
          await release.promise;
        }
        return result;
      });
      ok(await f.call('DeleteObject', { object_id: input.object_id, request_id: uuid() }));
      await held.promise;
      let settled = false;
      const closing = f.core.close();
      void closing.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await delay(100);
      assert.equal(settled, false, 'Shutdown must await the active timer body');
      assert.equal((await stat(file)).size, bytes.length);
      release.resolve();
      if (failBookkeeping)
        await assert.rejects(
          closing,
          (error) => error instanceof AggregateError && error.errors.includes(failure),
        );
      else {
        await closing;
        assert.equal(recorded, true);
      }
      await assert.rejects(stat(file), { code: 'ENOENT' });
      assert.equal(f.core.rpc.worker.threadId, -1);
    },
  );
for (const reverse of [false, true])
  test(`full-quota upload recovery verifies all bytes with descriptor last=${reverse}`, async (t) => {
    const f = await fixture(t, { objectBytes: 1024 });
    const bytes = Buffer.alloc(1024, 7),
      input = descriptor(bytes);
    const first = await f.upload(input, bytes);
    ok(first);
    const installed = join(f.directory, 'objects', 'installed');
    const names = await readdir(installed);
    await f.restart();
    const retried = await f.upload(input, bytes, reverse);
    assert.deepEqual(retried.json, first.json);
    assert.equal((await f.upload(input, Buffer.alloc(1024, 8), reverse)).status, 400);
    assert.equal((await f.upload(input, bytes.subarray(1), reverse)).status, 400);
    assert.equal(
      (
        await f.upload(
          { ...input, metadata: { associations: [], name: 'changed' } },
          bytes,
          reverse,
        )
      ).json.error.code,
      'identity_conflict',
    );
    assert.equal(
      (await f.upload(input, bytes, reverse, { 'Atlas-Dataset-ID': uuid() })).json.error.code,
      'dataset_mismatch',
    );
    assert.deepEqual(await readdir(installed), names);
    assert.deepEqual(await readdir(join(f.directory, 'objects', 'staging')), []);
    assert.deepEqual(await readFile(join(installed, names[0])), bytes);
    const db = new Database(join(f.directory, 'core.sqlite'), { readonly: true });
    try {
      assert.deepEqual(
        db
          .prepare(
            "SELECT count(*) AS count, sum(bytes) AS bytes FROM object_attempts WHERE state<>'reclaimed'",
          )
          .get(),
        { count: 1, bytes: 1024 },
      );
      assert.equal(db.prepare('SELECT count(*) AS count FROM object_images').get().count, 1);
    } finally {
      db.close();
    }
    ok(await f.call('DeleteObject', { request_id: uuid(), object_id: input.object_id }));
    assert.equal((await f.upload(input, bytes, reverse)).json.error.code, 'identity_conflict');
  });
for (const reverse of [false, true])
  test(`aggregate pressure refuses fresh uploads but preserves committed retry with descriptor last=${reverse}`, async (t) => {
    const f = await fixture(t, {
      storageBytes: 8 * 1024 * 1024,
      reserveBytes: 1024 * 1024,
      objectBytes: 4 * 1024 * 1024,
    });
    const bytes = Buffer.alloc(256 * 1024, 37),
      input = descriptor(bytes);
    const first = await f.upload(input, bytes);
    ok(first);
    await f.core.diagnostics.close();
    await f.core.rpc.call('tick', {}, 0, true);
    const installed = join(f.directory, 'objects', 'installed'),
      staging = join(f.directory, 'objects', 'staging');
    const names = await readdir(installed);
    const db = new Database(join(f.directory, 'core.sqlite'), { readonly: true });
    t.after(() => db.close());
    const published = () => ({
      objects: db.prepare('SELECT * FROM object_images ORDER BY id').all(),
      attempts: db
        .prepare("SELECT * FROM object_attempts WHERE state<>'reclaimed' ORDER BY id")
        .all(),
      cursor: db.prepare("SELECT value FROM core_meta WHERE key='sequence'").get().value,
    });
    const before = published();
    const pressure = join(f.directory, 'pressure.bin'),
      filler = await open(pressure, 'wx');
    try {
      await filler.truncate(
        f.settings.storageBytes - f.settings.reserveBytes - diskUsage(f.directory).bytes - 32768,
      );
    } finally {
      await filler.close();
    }
    const fresh = descriptor(bytes);
    assert.equal((await f.upload(fresh, bytes, reverse)).json.error.code, 'storage_limit');
    assert.equal((await f.call('GetObject', { object_id: fresh.object_id })).status, 404);
    assert.equal(
      (await f.upload(input, Buffer.alloc(bytes.length, 38), reverse)).json.error.code,
      'invalid_request',
    );
    assert.deepEqual(
      published(),
      before,
      'Invalid bytes cannot change metadata, reservations or public effects',
    );
    assert.deepEqual(await readdir(installed), names);
    assert.deepEqual(await readdir(staging), []);
    assert.deepEqual(await readFile(join(installed, names[0])), bytes);
    assert.deepEqual((await f.upload(input, bytes, reverse)).json, first.json);
    assert.deepEqual(
      published(),
      before,
      'A valid retry after invalid bytes preserves the original publication',
    );
    assert.deepEqual(await readdir(installed), names);
    assert.deepEqual(await readdir(staging), []);
    assert.deepEqual(await readFile(join(installed, names[0])), bytes);
    assert.deepEqual(
      (await f.call('ReadObjectContent', { object_id: input.object_id, disposition: 'inline' }))
        .bytes,
      bytes,
    );
    await rm(pressure);
    ok(await f.upload(fresh, bytes, reverse));
    assert.equal(
      published().objects.length,
      2,
      'Refused upload identity remains available after capacity returns',
    );
  });
for (const change of ['deletion', 'revocation'])
  test(
    `verified upload recovery rechecks ${change} after receipt lookup`,
    { timeout: 20_000 },
    async (t) => {
      const held = Promise.withResolvers(),
        release = Promise.withResolvers();
      const f = await fixture(
        {
          after: (action) =>
            t.after(async () => {
              release.resolve();
              await action();
            }),
        },
        { objectBytes: 1024 },
      );
      const bytes = Buffer.alloc(1024, 3),
        input = descriptor(bytes);
      ok(await f.upload(input, bytes));
      const original = f.core.rpc.call;
      t.mock.method(f.core.rpc, 'call', async function (kind, ...args) {
        const result = await original.call(this, kind, ...args);
        if (kind === 'upload-retry' && result === true) {
          held.resolve();
          await release.promise;
        }
        return result;
      });
      const retry = f.upload(input, bytes);
      await held.promise;
      if (change === 'deletion')
        ok(await f.call('DeleteObject', { request_id: uuid(), object_id: input.object_id }));
      else {
        const keys = ok(await f.call('ListApiKeys')).items;
        assert.equal(
          (await f.call('RevokeApiKey', { request_id: uuid(), api_key_id: keys[0].api_key_id }))
            .status,
          401,
        );
      }
      release.resolve();
      const response = await retry;
      assert.equal(
        response.json.error.code,
        change === 'deletion' ? 'identity_conflict' : 'unauthorized',
      );
      assert.deepEqual(await readdir(join(f.directory, 'objects', 'staging')), []);
    },
  );
test(
  'concurrent first uploads still reserve separate capacity until a receipt commits',
  { timeout: 20_000 },
  async (t) => {
    const held = Promise.withResolvers(),
      release = Promise.withResolvers();
    const f = await fixture(
      {
        after: (action) =>
          t.after(async () => {
            release.resolve();
            await action();
          }),
      },
      { objectBytes: 1024 },
    );
    const bytes = Buffer.alloc(1024, 4),
      input = descriptor(bytes);
    const original = f.core.rpc.call;
    let first = true;
    t.mock.method(f.core.rpc, 'call', async function (kind, ...args) {
      const result = await original.call(this, kind, ...args);
      if (kind === 'prepare-upload' && first) {
        first = false;
        held.resolve();
        await release.promise;
      }
      return result;
    });
    const pending = f.upload(input, bytes);
    await held.promise;
    assert.equal((await f.upload(input, bytes)).json.error.code, 'storage_limit');
    release.resolve();
    const accepted = await pending;
    ok(accepted);
    assert.deepEqual((await f.upload(input, bytes)).json, accepted.json);
    assert.equal((await readdir(join(f.directory, 'objects', 'installed'))).length, 1);
    assert.deepEqual(await readdir(join(f.directory, 'objects', 'staging')), []);
  },
);
test('startup reclaims escaped abandoned upload descriptors across bounded worker response pages', async (t) => {
  const f = await fixture(t, {
    resourceImageBytes: 65536,
    maxUploads: 64,
    limits: { ...defaults.limits, max_message_bytes: 212992 },
  });
  await f.core.close();
  const engine = new Engine(f.directory, f.settings);
  const owner = { ...(await processIdentity()), start: '0' };
  const authority = engine.identity.authorize(digest(f.apiKey));
  try {
    for (let i = 0; i < 65; i++) {
      const input = descriptor(Buffer.from('partial'));
      input.metadata.description = '"'.repeat(4096);
      const attempt = await engine.reserveStorage((admit) =>
        engine.store.db.transaction(() =>
          engine.objects.prepare(input, uuid(), owner, authority.keyId, admit),
        )(),
      );
      await engine.reserveStorage((admit) => engine.objects.reserve(attempt.id, 7, admit));
      engine.objects.abandon(attempt.id);
      await writeFile(join(f.directory, 'objects', attempt.staging), 'partial');
    }
  } finally {
    await engine.close();
  }
  assert.equal((await readdir(join(f.directory, 'objects', 'staging'))).length, 65);
  await f.restart();
  assert.deepEqual(await readdir(join(f.directory, 'objects', 'staging')), []);
  assert.deepEqual(await f.core.rpc.call('file-owners', {}, 1024, true), []);
  assert.equal(ok(await f.call('GetHealth')).healthy, true);
});
test('stream publication, exact retry, integrity faults, permanent holds and deletion lifetime', async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.alloc(1_000_000, 0x9a),
    request = descriptor(bytes);
  const first = await f.upload(request, bytes);
  const image = ok(first);
  const retry = await f.upload(request, bytes, true);
  assert.equal(ok(retry).object_id, image.object_id);
  assert.equal(first.json.commit_cursor, retry.json.commit_cursor);
  assert.equal((await readdir(join(f.directory, 'objects', 'installed'))).length, 1);
  assert.equal(
    (await f.upload({ ...request, request_id: uuid() }, bytes)).json.error.code,
    'identity_conflict',
  );
  const asset = ok(await f.call('RegisterAsset', registration())).asset;
  const task = ok(
    await f.call('CreateTask', {
      request_id: uuid(),
      task_id: uuid(),
      asset_id: asset.id,
      command: 'pause',
      scheduling: 'immediate',
      inputs: {},
    }),
  );
  const evidence = {
    dataset_id: f.core.dataset,
    asset_id: asset.id,
    origin: { kind: 'asset_process', process_generation: asset.process_generation },
    report_id: uuid(),
    sequence: '1',
    generated_at: null,
    payload: {
      task_id: task.task_id,
      declarations: [{ object_id: image.object_id, required: true }],
    },
  };
  ok(await f.call('ReportTaskResults', { evidence }));
  assert.equal(
    (await f.call('DeleteObject', { object_id: image.object_id, request_id: uuid() })).json.error
      .code,
    'object_held',
  );
  const names = await readdir(join(f.directory, 'objects', 'installed'));
  await writeFile(
    join(f.directory, 'objects', 'installed', names[0]),
    Buffer.alloc(bytes.length, 1),
  );
  assert.equal(
    (await f.call('ReadObjectContent', { object_id: image.object_id, disposition: 'inline' })).json
      .error.code,
    'integrity_fault',
  );
  assert.equal(
    ok(await f.call('GetObject', { object_id: image.object_id })).sha256,
    request.sha256,
  );
  assert.equal(ok(await f.call('GetHealth')).healthy, false);
  assert.equal(ok(await f.call('GetReadiness')).ready, true);
  await writeFile(join(f.directory, 'objects', 'installed', names[0]), bytes);
  assert.deepEqual(
    (await f.call('ReadObjectContent', { object_id: image.object_id, disposition: 'attachment' }))
      .bytes,
    bytes,
  );
  assert.equal(ok(await f.call('GetHealth')).healthy, true);
  const empty = Buffer.alloc(0),
    deletable = descriptor(empty);
  ok(await f.upload(deletable, empty));
  ok(await f.call('DeleteObject', { object_id: deletable.object_id, request_id: uuid() }));
  assert.equal((await f.upload(deletable, empty)).json.error.code, 'identity_conflict');
  assert.equal(
    (await f.call('ReadObjectContent', { object_id: deletable.object_id, disposition: 'inline' }))
      .status,
    404,
  );
});
test('digest and quota failures publish no partial metadata or surviving attempt files', async (t) => {
  const f = await fixture(t, { objectBytes: 1024 });
  const bytes = Buffer.from('exact bytes');
  const request = descriptor(bytes);
  assert.equal((await f.upload({ ...request, sha256: '0'.repeat(64) }, bytes)).status, 400);
  assert.equal((await f.call('GetObject', { object_id: request.object_id })).status, 404);
  const large = Buffer.alloc(2048);
  assert.equal((await f.upload(descriptor(large), large)).json.error.code, 'storage_limit');
  assert.deepEqual(await readdir(join(f.directory, 'objects', 'installed')), []);
  assert.deepEqual(await readdir(join(f.directory, 'objects', 'staging')), []);
});
test(
  'requests following early multipart refusals complete without a stale TLS connection',
  { timeout: 20000 },
  async (t) => {
    const cleanups = [],
      f = await fixture({ after: (cleanup) => cleanups.push(cleanup) }, { objectBytes: 1048576 });
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    t.after(async () => {
      agent.destroy();
      f.core.app.server.closeAllConnections();
      for (const cleanup of cleanups) await cleanup();
    });
    const call = (method, path, body, contentType = 'application/json') =>
      new Promise((resolve, reject) => {
        const request = httpsRequest(
          new URL(path, f.address),
          {
            method,
            agent,
            ca: f.ca,
            headers: {
              Authorization: `Bearer ${f.apiKey}`,
              'Atlas-Dataset-ID': f.core.dataset,
              'Atlas-Protocol-Version': '0.3.0',
              ...(body === undefined
                ? {}
                : { 'Content-Type': contentType, 'Content-Length': body.length }),
            },
          },
          (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('error', reject);
            response.on('end', () => {
              try {
                resolve({
                  status: response.statusCode,
                  headers: response.headers,
                  json: JSON.parse(Buffer.concat(chunks).toString()),
                });
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        request.setTimeout(5000, () => request.destroy(new Error('following_request_stalled')));
        request.on('error', reject);
        request.end(body);
      });
    ok(await call('GET', '/health'));
    for (const reverse of [false, true]) {
      const bytes = Buffer.alloc(2 * 1048576, 7),
        input = descriptor(bytes),
        boundary = 'refused-upload-boundary';
      const description = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="descriptor"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(input)}\r\n`,
      );
      const file = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="payload.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        ),
        bytes,
        Buffer.from('\r\n'),
      ]);
      const body = Buffer.concat([
        ...(reverse ? [file, description] : [description, file]),
        Buffer.from(`--${boundary}--\r\n`),
      ]);
      const refused = await call(
        'POST',
        '/objects',
        body,
        `multipart/form-data; boundary=${boundary}`,
      );
      assert.equal(refused.status, 507);
      assert.equal(refused.json.error.code, 'storage_limit');
      t.diagnostic(JSON.stringify({ reverse, connection: refused.headers.connection }));
      assert.equal(ok(await call('GET', '/health')).healthy, true);
      assert.equal((await f.call('GetObject', { object_id: input.object_id })).status, 404);
      assert.deepEqual(await readdir(join(f.directory, 'objects', 'staging')), []);
      assert.deepEqual(await readdir(join(f.directory, 'objects', 'installed')), []);
    }
  },
);
test('revocation interrupts an idle multipart writer and releases its files and admission slot', async (t) => {
  const f = await fixture(t, { maxUploads: 1 });
  const key = { api_key_id: uuid(), request_id: uuid(), secret: secret() };
  ok(await f.call('CreateApiKey', key));
  const payload = Buffer.alloc(100_000, 7),
    input = descriptor(payload);
  const req = httpsRequest(new URL('/objects', f.address), {
    method: 'POST',
    ca: f.ca,
    headers: {
      Authorization: `Bearer ${key.secret}`,
      'Atlas-Dataset-ID': f.core.dataset,
      'Atlas-Protocol-Version': '0.3.0',
      'Content-Type': 'multipart/form-data; boundary=idle',
    },
  });
  t.after(() => req.destroy());
  const closed = new Promise((resolve) => {
    req.on('error', () => {});
    req.once('close', resolve);
    req.once('response', (res) => res.resume());
  });
  req.write(
    `--idle\r\nContent-Disposition: form-data; name="descriptor"\r\n\r\n${JSON.stringify(input)}\r\n--idle\r\nContent-Disposition: form-data; name="file"; filename="owned.bin"\r\n\r\n`,
  );
  req.write(payload.subarray(0, 1024));
  const staging = join(f.directory, 'objects', 'staging');
  for (let i = 0; (await readdir(staging)).length === 0 && i < 100; i++) await delay(20);
  assert.equal((await readdir(staging)).length, 1);
  ok(await f.call('RevokeApiKey', { api_key_id: key.api_key_id, request_id: uuid() }));
  await Promise.race([
    closed,
    delay(3000).then(() => {
      throw new Error('revoked_upload_still_open');
    }),
  ]);
  const cleanupDeadline = Date.now() + 2000;
  while ((await readdir(staging)).length !== 0 && Date.now() < cleanupDeadline) await delay(20);
  assert.deepEqual(await readdir(staging), []);
  assert.deepEqual(await readdir(join(f.directory, 'objects', 'installed')), []);
  assert.equal((await f.call('GetObject', { object_id: input.object_id })).status, 404);
  const nextBytes = Buffer.from('next'),
    nextInput = descriptor(nextBytes);
  let uploaded;
  do {
    uploaded = await f.upload(nextInput, nextBytes);
    if (uploaded.status === 200) break;
    assert.equal(uploaded.json?.error.code, 'resource_limit', JSON.stringify(uploaded.json));
    await delay(20);
  } while (Date.now() < cleanupDeadline);
  assert.equal(ok(uploaded).object_id, nextInput.object_id);
  assert.deepEqual(
    (await f.call('ReadObjectContent', { object_id: nextInput.object_id, disposition: 'inline' }))
      .bytes,
    nextBytes,
  );
});
test(
  'verified process exit reclaims owned attempts and captures while ambiguous files survive',
  { timeout: 15000 },
  async (t) => {
    const cleanup = [];
    let child, childExit;
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (childExit) await childExit;
      for (const close of cleanup.reverse()) await close();
    });
    const f = await fixture({ after: (fn) => cleanup.push(fn) });
    const asset = ok(await f.call('RegisterAsset', registration())).asset;
    await f.core.close();
    const source = `
    const {createCore} = await import(process.argv[2]);
    let input = ''; for await (const bytes of process.stdin) input += bytes;
    const core = await createCore(JSON.parse(input));
    process.stdout.write(JSON.stringify({ address: await core.listen() }) + '\\n');
  `;
    const entry = join(f.directory, 'owned-child.mjs');
    await writeFile(entry, source, { mode: 0o600 });
    child = spawn(process.execPath, [entry, new URL('../dist/server.js', import.meta.url).href], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    childExit = once(child, 'exit');
    child.stdin.end(
      JSON.stringify({
        directory: f.directory,
        certificate: f.certificate,
        key: f.key,
        settings: f.settings,
      }),
    );
    const address = await new Promise((resolve, reject) => {
      let output = '';
      child.once('error', reject);
      child.stdout.on('data', (bytes) => {
        output += bytes;
        if (output.includes('\n')) resolve(JSON.parse(output).address);
      });
      child.once('exit', () => reject(new Error('child_not_ready')));
    });
    function headers() {
      return {
        Authorization: `Bearer ${f.apiKey}`,
        'Atlas-Dataset-ID': f.core.dataset,
        'Atlas-Protocol-Version': '0.3.0',
      };
    }
    async function call(path, input) {
      const body = input === undefined ? undefined : Buffer.from(JSON.stringify(input));
      return new Promise((resolve, reject) => {
        const req = httpsRequest(
          new URL(path, address),
          {
            ca: f.ca,
            method: body ? 'POST' : 'GET',
            headers: {
              ...headers(),
              ...(body
                ? { 'Content-Type': 'application/json', 'Content-Length': body.length }
                : {}),
            },
          },
          (res) => {
            const chunks = [];
            res.on('data', (bytes) => chunks.push(bytes));
            res.on('end', () => {
              assert.equal(res.statusCode, 200);
              resolve(JSON.parse(Buffer.concat(chunks)));
            });
          },
        );
        req.on('error', reject);
        req.end(body);
      });
    }
    const health = (await call('/health')).data;
    const snapshot = (
      await call('/messages/read_snapshot', {
        load_id: uuid(),
        allocation_context: health.allocation_context,
        page_size: 100,
        max_message_bytes: 4194304,
        max_json_values: 262144,
        max_changes: 1000,
      })
    ).data;
    assert.equal(snapshot.items.length, 1);
    assert.equal((await readdir(join(f.directory, 'captures'))).length, 1);
    const payload = Buffer.alloc(100000, 9),
      input = descriptor(payload);
    const req = httpsRequest(new URL('/objects', address), {
      ca: f.ca,
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'multipart/form-data; boundary=interrupted' },
    });
    const requestClosed = new Promise((resolve) => {
      req.on('error', () => {});
      req.once('close', resolve);
    });
    req.write(
      `--interrupted\r\nContent-Disposition: form-data; name="descriptor"\r\n\r\n${JSON.stringify(input)}\r\n--interrupted\r\nContent-Disposition: form-data; name="file"; filename="owned.bin"\r\n\r\n`,
    );
    req.write(payload.subarray(0, 1024));
    const staging = join(f.directory, 'objects', 'staging'),
      installed = join(f.directory, 'objects', 'installed');
    for (let i = 0; (await readdir(staging)).length === 0 && i < 100; i++) await delay(20);
    assert.equal((await readdir(staging)).length, 1);
    const ambiguous = `${uuid()}-${uuid()}`;
    await writeFile(join(installed, ambiguous), 'retain without owner evidence');
    child.kill('SIGKILL');
    await childExit;
    req.destroy();
    await requestClosed;
    await f.restart();
    assert.deepEqual(await readdir(staging), []);
    assert.deepEqual(await readdir(installed), [ambiguous]);
    assert.deepEqual(await readdir(join(f.directory, 'captures')), []);
    assert.equal(ok(await f.call('GetAsset', { asset_id: asset.id })).id, asset.id);
    assert.equal((await f.call('GetObject', { object_id: input.object_id })).status, 404);
    assert.equal(
      (await f.call('ReleaseSnapshot', { release_token: snapshot.release_token })).json.error.code,
      'allocation_expired',
    );
  },
);
