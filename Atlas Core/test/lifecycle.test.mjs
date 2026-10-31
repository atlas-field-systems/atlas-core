import { mutableRoot } from './paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fixture, uuid, registration } from './helpers.mjs';
import { installationLock, recoveryDecision, readJsonFile } from '../dist/installation.js';
import { z } from 'zod';
import { processIdentity } from '../dist/ownership.js';
import { mkdtemp, mkdir, open, readFile, readlink, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from './helpers.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createCore } from '../dist/server.js';
import { DatabaseWorker } from '../dist/rpc.js';
import { Transfers } from '../dist/transfers.js';
import { defaults } from '../dist/settings.js';
import { digest } from '../dist/exact.js';
import Database from 'better-sqlite3';
import { Administration } from '../dist/admin.js';
const run = (data) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../dist/offline.js', import.meta.url), { workerData: data });
    let value;
    worker.on('message', (result) => {
      value = result;
    });
    worker.once('error', reject);
    worker.once('exit', (code) =>
      code === 0 ? resolve(value) : reject(new Error('offline_failed')),
    );
  });
test(
  'local JSON reads enforce the byte limit before an input reaches EOF',
  { timeout: 10000 },
  async (t) => {
    const directory = await mkdtemp(join(mutableRoot, 'local-record-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const schema = z.strictObject({ value: z.string() }),
      value = { value: 'é' };
    const bytes = Buffer.from(JSON.stringify(value));
    const record = join(directory, 'record.json');
    await writeFile(record, Buffer.concat([bytes, Buffer.alloc(65536 - bytes.length, 32)]));
    assert.deepEqual(await readJsonFile(record, schema), value);
    await writeFile(record, Buffer.alloc(65537, 32));
    await assert.rejects(readJsonFile(record, schema), /record_limit/);
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            join(root, 'dist', 'cli.js'),
            'settings',
            'save',
            '--installation',
            join(directory, 'installation'),
            '--expected-revision',
            '0',
            '--file',
            record,
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        ),
      (error) => {
        assert.equal(error.status, 1);
        assert.equal(JSON.parse(error.stdout).code, 'record_limit');
        return true;
      },
    );
    const fifo = join(directory, 'record.pipe');
    execFileSync('mkfifo', [fifo]);
    const reading = readJsonFile(fifo, schema).then(
      () => 'accepted',
      (error) => error.message,
    );
    const writer = await open(fifo, 'w');
    let outcome;
    try {
      await writer.writeFile(Buffer.alloc(65537, 32));
      outcome = await Promise.race([reading, delay(1500).then(() => 'waiting_for_eof')]);
    } finally {
      await writer.close();
    }
    await reading;
    assert.equal(
      outcome,
      'record_limit',
      'Oversized input must be refused while its writer is still open',
    );
  },
);
test('update compatibility inspects retained SQLite without opening an Engine or changing data', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await run({ mode: 'check-update', directory: f.directory }), {
    compatible: true,
  });
  await f.core.close();
  const path = join(f.directory, 'core.sqlite');
  for (const format of ['1', null]) {
    const db = new Database(path);
    try {
      if (format === null) db.prepare("DELETE FROM core_meta WHERE key='format'").run();
      else db.prepare("UPDATE core_meta SET value=? WHERE key='format'").run(format);
    } finally {
      db.close();
    }
    const before = await readFile(path);
    assert.deepEqual(await run({ mode: 'check-update', directory: f.directory }), {
      compatible: false,
    });
    assert.deepEqual(
      await readFile(path),
      before,
      'Refusal must leave all retained database bytes unchanged',
    );
  }
});
test('installation mutation lock excludes contenders after dead and ownerless commands', async (t) => {
  const directory = await mkdtemp(join(mutableRoot, 'locks-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ended = { ...(await processIdentity()), start: '0' };
  for (let round = 0; round < 20; round++) {
    const installation = join(directory, String(round));
    const oldLock = join(installation, 'control', 'command.lock');
    await mkdir(oldLock, { recursive: true });
    await writeFile(join(oldLock, 'owner.json'), JSON.stringify({ id: uuid(), owner: ended }));
    let active = 0,
      overlap = false;
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        installationLock(installation, async () => {
          if (++active > 1) overlap = true;
          await delay(20);
          active--;
        }),
      ),
    );
    assert.equal(overlap, false, 'Dead-owner takeover must never overlap protected actions');
    assert.ok(results.some((result) => result.status === 'fulfilled'));
    for (const result of results)
      if (result.status === 'rejected') assert.equal(result.reason.message, 'management_busy');
  }
  const ownerless = join(directory, 'ownerless');
  await mkdir(join(ownerless, 'control', 'command.lock'), { recursive: true });
  assert.equal(await installationLock(ownerless, async () => 'acquired'), 'acquired');
  const installation = join(directory, 'killed');
  const source = `import { installationLock } from ${JSON.stringify(new URL('../dist/installation.js', import.meta.url).href)}; await installationLock(${JSON.stringify(installation)}, async () => { process.stdout.write('locked'); await new Promise(() => { setInterval(() => {}, 1000); }); });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  await once(child.stdout, 'data');
  await assert.rejects(
    installationLock(installation, async () => {}),
    /management_busy/,
  );
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  assert.equal(await installationLock(installation, async () => 'recovered'), 'recovered');
});
test('atomic Dataset marker preserves setup, matching recovery regenerates proof, ambiguity refuses', async (t) => {
  const f = await fixture(t);
  const old = f.core.dataset;
  const registered = registration();
  const operator = { operator_id: uuid(), request_id: uuid(), name: 'Retained operator' };
  assert.equal((await f.call('CreateOperator', operator)).status, 200);
  assert.equal((await f.call('RegisterAsset', registered)).status, 200);
  await f.core.close();
  const retained = new Database(join(f.directory, 'core.sqlite'));
  try {
    retained.prepare("UPDATE core_meta SET value='4' WHERE key='format'").run();
  } finally {
    retained.close();
  }
  assert.deepEqual(await run({ mode: 'check-update', directory: f.directory }), {
    compatible: true,
  });
  const dataset = uuid(),
    actionId = uuid();
  const established = await run({
    mode: 'establish',
    directory: f.directory,
    settings: f.settings,
    dataset,
    action: actionId,
    hard: false,
  });
  assert.equal(established.established, true);
  const marker = await run({ mode: 'inspect-marker', directory: f.directory });
  assert.equal(marker.dataset, dataset);
  assert.deepEqual(marker.marker, { dataset, actionId });
  const action = {
    format: 1,
    action_id: actionId,
    installation_id: uuid(),
    kind: 'reset',
    old_dataset: old,
    intended_dataset: dataset,
    writer: null,
    image: `sha256:${'0'.repeat(64)}`,
    phase: 'cleaned',
    primary_failure: null,
    cleanup_failure: null,
  };
  assert.equal(recoveryDecision(action, marker, undefined), 'preserve');
  assert.throws(
    () =>
      recoveryDecision(
        { ...action, phase: 'established' },
        { exists: false, dataset: null, marker: null },
        undefined,
      ),
    /repair_required/,
  );
  assert.throws(
    () =>
      recoveryDecision(action, marker, {
        action_id: actionId,
        dataset: uuid(),
        installation_id: action.installation_id,
      }),
    /repair_required/,
  );
  await f.restart();
  assert.equal(f.core.dataset, dataset);
  assert.equal((await f.call('GetHealth')).status, 200);
  const keptOperator = await f.call('GetOperator', { operator_id: operator.operator_id });
  assert.equal(keptOperator.status, 200);
  assert.equal(keptOperator.json.data.name, 'Retained operator');
  assert.deepEqual((await f.call('ListAssets')).json.data.items, []);
  assert.equal(
    (await f.call('ListAssets', {}, { 'Atlas-Dataset-ID': old })).json.error.code,
    'dataset_mismatch',
  );
  assert.equal((await f.call('RegisterAsset', registered)).json.error.code, 'identity_conflict');
  const replacement = { ...registration(), asset_id: registered.asset_id };
  assert.equal((await f.call('RegisterAsset', replacement)).status, 200);
  assert.equal(
    (await f.call('DeleteAsset', { asset_id: replacement.asset_id, request_id: uuid() })).status,
    200,
  );
  assert.equal(
    (await f.call('GetHealth', {}, { Authorization: `Bearer ${registered.secret}` })).status,
    200,
  );
});

const objectDescriptor = (bytes) => ({
  request_id: uuid(),
  object_id: uuid(),
  byte_length: String(bytes.byteLength),
  sha256: createHash('sha256').update(bytes).digest('hex'),
  content_type: 'application/octet-stream',
  metadata: { associations: [] },
});

for (const phase of ['file', 'integrity'])
  test(
    `Stop owns download preparation awaiting the ${phase} worker reply`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t);
      const bytes = Buffer.from('owned download'),
        descriptor = objectDescriptor(bytes);
      assert.equal((await f.upload(descriptor, bytes)).status, 200);
      const held = Promise.withResolvers(),
        release = Promise.withResolvers(),
        cleaning = Promise.withResolvers();
      t.after(() => release.resolve());
      const call = f.core.rpc.call;
      let intercepted = false,
        cleanupFinished = false;
      t.mock.method(f.core.rpc, 'call', async function (kind, data, ...args) {
        const value = await call.call(this, kind, data, ...args);
        if (!intercepted && kind === phase && data.object === descriptor.object_id) {
          intercepted = true;
          held.resolve();
          await release.promise;
        }
        return value;
      });
      const closeTransfers = Transfers.prototype.close,
        download = Transfers.prototype.download;
      const lateStreams = [];
      t.mock.method(Transfers.prototype, 'close', async function () {
        cleaning.resolve();
        await closeTransfers.call(this);
        cleanupFinished = true;
      });
      t.mock.method(Transfers.prototype, 'download', async function (...args) {
        const result = await download.apply(this, args);
        if (cleanupFinished) lateStreams.push(result.stream);
        return result;
      });
      const response = f.call('ReadObjectContent', {
        object_id: descriptor.object_id,
        disposition: 'inline',
      });
      await held.promise;
      const stopped = f.core.close();
      await cleaning.promise;
      await new Promise((resolve) => setImmediate(resolve));
      release.resolve();
      const result = await response;
      await stopped;
      assert.deepEqual(lateStreams, [], 'No outgoing stream may start after transfer cleanup');
      assert.equal(
        result.status,
        429,
        'Stop refuses the prepared download without requiring client disconnect',
      );
      assert.equal(result.json.error.code, 'resource_limit');
      assert.equal(f.core.rpc.worker.threadId, -1, 'Stop awaits actual database worker exit');
    },
  );

test('transfer cleanup closes a prepared download that the caller never starts', async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from('unconsumed'),
    descriptor = objectDescriptor(bytes);
  assert.equal((await f.upload(descriptor, bytes)).status, 200);
  const transfers = new Transfers(
    f.core.rpc,
    join(f.directory, 'objects'),
    f.settings,
    f.core.diagnostics,
    new Set(),
  );
  await transfers.initialize();
  const probe = await open(f.certificate),
    prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const createReadStream = prototype.createReadStream,
    handles = new Set(),
    sources = [];
  t.after(async () => {
    for (const source of sources) source.destroy();
    for (const handle of handles) await handle.close();
  });
  t.mock.method(prototype, 'createReadStream', function (...args) {
    handles.add(this);
    const stream = createReadStream.apply(this, args);
    sources.push(stream);
    return stream;
  });
  const download = await transfers.download(descriptor.object_id, {
    verifier: digest(f.apiKey),
    dataset: f.core.dataset,
    protocol: '0.4.0',
  });
  assert.equal(download.stream.readableDidRead, false);
  assert.ok(handles.size > 0, 'The download acquired a real file handle');
  await transfers.close();
  for (const handle of handles)
    await assert.rejects(
      handle.stat(),
      { code: 'EBADF' },
      'Cleanup awaits file closure even when the iterator never starts',
    );
});

test('Stop retains a completed download handle cleanup failure and records it', async (t) => {
  const f = await fixture({ after() {} });
  const cleanupFailure = new Error('download_handle_cleanup_test_failure'),
    attempted = Promise.withResolvers();
  const includesFailure = (error) =>
    error === cleanupFailure ||
    (error instanceof AggregateError && error.errors.some(includesFailure));
  let handle, closeHandle;
  t.after(async () => {
    if (handle) {
      handle.close.mock.restore();
      await closeHandle.call(handle);
    }
    await f.core.close().catch((error) => assert.ok(includesFailure(error)));
    await rm(f.directory, { recursive: true, force: true });
  });
  const bytes = Buffer.from('cleanup failure'),
    descriptor = objectDescriptor(bytes);
  assert.equal((await f.upload(descriptor, bytes)).status, 200);
  const probe = await open(f.certificate),
    prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const createReadStream = prototype.createReadStream;
  t.mock.method(prototype, 'createReadStream', function (...args) {
    if (!handle) {
      handle = this;
      closeHandle = this.close;
      t.mock.method(this, 'close', async () => {
        attempted.resolve();
        throw cleanupFailure;
      });
    }
    return createReadStream.apply(this, args);
  });
  assert.deepEqual(
    (await f.call('ReadObjectContent', { object_id: descriptor.object_id, disposition: 'inline' }))
      .bytes,
    bytes,
  );
  await attempted.promise;
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    f.core.close(),
    includesFailure,
    'A settled transfer must not lose its cleanup failure before Stop',
  );
  assert.equal(
    f.core.rpc.worker.threadId,
    -1,
    'Other shutdown owners still finish after transfer cleanup fails',
  );
  const logs = join(f.directory, 'logs');
  const events = (
    await Promise.all((await readdir(logs)).map((name) => readFile(join(logs, name), 'utf8')))
  ).flatMap((text) =>
    text
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  );
  assert.ok(
    events.some((event) => event.event === 'download_cleanup_failed' && event.severity === 'ERROR'),
  );
});

for (const cleanupFails of [false, true])
  test(`failed Core initialization awaits worker cleanup${cleanupFails ? ' and retains both failures' : ''}`, async (t) => {
    const directory = await mkdtemp(join(mutableRoot, 'failed-start-'));
    const call = DatabaseWorker.prototype.call,
      closeWorker = DatabaseWorker.prototype.close;
    let rpc;
    t.after(async () => {
      if (rpc?.worker.threadId !== -1 && rpc) await closeWorker.call(rpc);
      await rm(directory, { recursive: true, force: true });
    });
    t.mock.method(DatabaseWorker.prototype, 'call', function (...args) {
      rpc = this;
      return call.apply(this, args);
    });
    const cleanupFailure = new Error('worker_cleanup_test_failure');
    if (cleanupFails)
      t.mock.method(DatabaseWorker.prototype, 'close', async function () {
        await closeWorker.call(this);
        throw cleanupFailure;
      });
    await assert.rejects(
      createCore({
        directory,
        certificate: join(directory, 'missing.pem'),
        key: join(directory, 'missing.key'),
        settings: { ...defaults, freeDiskBytes: 0 },
      }),
      (error) => {
        if (!cleanupFails) return error.code === 'ENOENT';
        return (
          error instanceof AggregateError &&
          error.errors[0].code === 'ENOENT' &&
          error.errors.includes(cleanupFailure)
        );
      },
    );
    assert.ok(rpc, 'The real database worker was initialized before TLS failed');
    assert.equal(
      rpc.worker.threadId,
      -1,
      'Initialization rejects only after the acquired worker exits',
    );
  });

test('multipart independently bounds descriptor and content when the Object ceiling is smaller', async (t) => {
  const f = await fixture(t, {
    limits: { ...defaults.limits, max_request_bytes: 65_536, max_object_bytes: 1024 },
  });
  const bytes = Buffer.from('twelve bytes');
  assert.equal(bytes.length, 12);
  for (const reverse of [false, true]) {
    const descriptor = objectDescriptor(bytes);
    descriptor.metadata.description = 'd'.repeat(2300);
    assert.ok(Buffer.byteLength(JSON.stringify(descriptor)) > 2048);
    const uploaded = await f.upload(descriptor, bytes, reverse);
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.json));
    assert.deepEqual(
      (
        await f.call('ReadObjectContent', {
          object_id: descriptor.object_id,
          disposition: 'inline',
        })
      ).bytes,
      bytes,
    );
  }
  for (const reverse of [false, true]) {
    const oversized = Buffer.alloc(1025),
      descriptor = objectDescriptor(oversized);
    const rejected = await f.upload(descriptor, oversized, reverse);
    assert.equal(rejected.status, 413, JSON.stringify(rejected.json));
    assert.equal(rejected.json.error.code, 'payload_too_large');
    assert.equal((await f.call('GetObject', { object_id: descriptor.object_id })).status, 404);
  }
  const descriptor = objectDescriptor(bytes),
    boundary = 'descriptor-ceiling';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="descriptor"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(descriptor).padEnd(65_537, ' ')}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="content.bin"\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const rejected = await f.http('POST', '/objects', body, {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
  });
  assert.equal(rejected.status, 413, JSON.stringify(rejected.json));
  assert.equal(rejected.json.error.code, 'payload_too_large');
  assert.equal((await f.call('GetObject', { object_id: descriptor.object_id })).status, 404);
});

for (const phase of ['prepare-upload', 'installed'])
  test(
    `Stop awaits upload ownership held at the ${phase} worker reply`,
    { timeout: 15_000 },
    async (t) => {
      const held = Promise.withResolvers(),
        release = Promise.withResolvers(),
        cleaning = Promise.withResolvers();
      const f = await fixture({ after() {} });
      t.after(async () => {
        release.resolve();
        try {
          await f.core.close();
        } finally {
          await rm(f.directory, { recursive: true, force: true });
        }
      });
      const bytes = Buffer.from('owned upload bytes'),
        descriptor = objectDescriptor(bytes);
      const call = f.core.rpc.call,
        closeTransfers = Transfers.prototype.close;
      let intercepted = false;
      t.mock.method(f.core.rpc, 'call', async function (kind, ...args) {
        const value = await call.call(this, kind, ...args);
        if (!intercepted && kind === phase) {
          intercepted = true;
          held.resolve();
          await release.promise;
        }
        return value;
      });
      t.mock.method(Transfers.prototype, 'close', async function () {
        cleaning.resolve();
        await closeTransfers.call(this);
      });
      const uploading = f.upload(descriptor, bytes);
      await held.promise;
      let settled = false;
      const stopping = f.core.close();
      void stopping.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await cleaning.promise;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        settled,
        false,
        'Stop remains pending while the upload owns an unanswered worker operation',
      );
      assert.notEqual(f.core.rpc.worker.threadId, -1);
      release.resolve();
      const response = await uploading;
      assert.equal(response.status, 429);
      assert.equal(response.json.error.code, 'resource_limit');
      await stopping;
      assert.equal(f.core.rpc.worker.threadId, -1);
      assert.deepEqual(await readdir(join(f.directory, 'objects', 'staging')), []);
      assert.deepEqual(await readdir(join(f.directory, 'objects', 'installed')), []);
      const db = new Database(join(f.directory, 'core.sqlite'), { readonly: true });
      try {
        assert.equal(db.prepare('SELECT count(*) AS count FROM object_images').get().count, 0);
        assert.equal(
          db.prepare("SELECT count(*) AS count FROM object_attempts WHERE state<>'reclaimed'").get()
            .count,
          0,
        );
      } finally {
        db.close();
      }
    },
  );

test(
  'Stop awaits diagnostic reservation release while its database worker remains alive',
  { timeout: 15_000 },
  async (t) => {
    const held = Promise.withResolvers(),
      release = Promise.withResolvers(),
      draining = Promise.withResolvers();
    const f = await fixture({ after() {} });
    t.after(async () => {
      release.resolve();
      try {
        await f.core.close();
      } finally {
        await rm(f.directory, { recursive: true, force: true });
      }
    });
    const call = f.core.rpc.call,
      closeDiagnostics = f.core.diagnostics.close;
    let intercepted = false,
      released = false;
    t.mock.method(f.core.rpc, 'call', async function (kind, ...args) {
      if (kind === 'release-diagnostics' && !intercepted) {
        intercepted = true;
        held.resolve();
        await release.promise;
        assert.equal(
          this.available,
          true,
          'The reservation owner stays alive until diagnostic release',
        );
      }
      const value = await call.call(this, kind, ...args);
      if (kind === 'release-diagnostics') released = true;
      return value;
    });
    t.mock.method(f.core.diagnostics, 'close', async function () {
      draining.resolve();
      await closeDiagnostics.call(this);
    });
    f.core.diagnostics.emit({ severity: 'INFO', component: 'runtime', event: 'held_release_test' });
    await held.promise;
    let settled = false;
    const stopping = f.core.close();
    void stopping.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await draining.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(f.core.rpc.available, true);
    assert.equal(released, false);
    release.resolve();
    await stopping;
    assert.equal(released, true);
    assert.equal(f.core.rpc.worker.threadId, -1);
    const logs = join(f.directory, 'logs');
    const events = (
      await Promise.all((await readdir(logs)).map((name) => readFile(join(logs, name), 'utf8')))
    ).flatMap((text) =>
      text
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
    assert.ok(
      events.some((event) => event.event === 'held_release_test'),
      'The owned diagnostic write reaches the retained file before Stop returns',
    );
  },
);

for (const name of ['certificate.pem', 'private.key']) {
  for (const failure of ['sync', 'close', 'both'])
    test(
      `setup ${name} ${failure} failure prevents a completed manifest and preserves failures`,
      { timeout: 10_000 },
      async (t) => {
        const directory = await mkdtemp(join(mutableRoot, 'tls-flush-'));
        const syncing = Promise.withResolvers(),
          release = Promise.withResolvers();
        let rejected;
        t.after(async () => {
          release.resolve();
          try {
            await rejected;
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        });
        const certificate = join(directory, 'source.pem'),
          key = join(directory, 'source.key'),
          installation = join(directory, 'installation');
        execFileSync(
          'openssl',
          [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-days',
            '2',
            '-subj',
            '/CN=localhost',
            '-keyout',
            key,
            '-out',
            certificate,
          ],
          { stdio: 'ignore' },
        );
        const probe = await open(certificate),
          prototype = Object.getPrototypeOf(probe),
          sync = prototype.sync;
        await probe.close();
        const syncFailure = new Error('tls_sync_test_failure'),
          closeFailure = new Error('tls_close_test_failure');
        let handle;
        t.mock.method(prototype, 'sync', async function () {
          if (!(await readlink(`/proc/self/fd/${this.fd}`)).match(new RegExp(`/setup/tls/[0-9a-f-]+/${name.replace('.', '\\.')}$$`)))
            return sync.call(this);
          handle = this;
          if (failure !== 'sync') {
            const close = this.close;
            t.mock.method(this, 'close', async function () {
              await close.call(this);
              throw closeFailure;
            });
          }
          syncing.resolve();
          await release.promise;
          if (failure !== 'close') throw syncFailure;
          return sync.call(this);
        });
        const pending = new Administration(installation).setup({
          image: `sha256:${'0'.repeat(64)}`,
          certificate,
          key,
          credential: { request_id: uuid(), api_key_id: uuid(), secret: 's'.repeat(43) },
        });
        rejected = assert.rejects(pending, (error) => {
          assert.ok(error instanceof AggregateError);
          assert.deepEqual(
            error.errors,
            failure === 'sync'
              ? [syncFailure]
              : failure === 'close'
                ? [closeFailure]
                : [syncFailure, closeFailure],
          );
          return true;
        });
        await syncing.promise;
        await assert.rejects(
          readFile(join(installation, 'setup', 'installation.json')),
          { code: 'ENOENT' },
          'Held TLS sync cannot publish setup completion',
        );
        await assert.rejects(readFile(join(installation, 'software.json')), { code: 'ENOENT' });
        release.resolve();
        await rejected;
        assert.ok(handle);
        await assert.rejects(
          handle.stat(),
          { code: 'EBADF' },
          'The TLS handle is closed even when flushing fails',
        );
        await assert.rejects(readFile(join(installation, 'setup', 'installation.json')), {
          code: 'ENOENT',
        });
        await assert.rejects(readFile(join(installation, 'setup', 'settings.json')), {
          code: 'ENOENT',
        });
        const journal = JSON.parse(await readFile(join(installation, 'setup', 'tls-journal.json')));
        const generation = join(installation, 'setup', 'tls', journal.next.generation);
        assert.deepEqual(await readFile(join(generation, 'certificate.pem')), await readFile(certificate));
        if (name === 'private.key') assert.deepEqual(await readFile(join(generation, 'private.key')), await readFile(key));
        await assert.rejects(readFile(join(installation, 'setup', 'tls-state.json')), { code: 'ENOENT' });
      },
    );
}
