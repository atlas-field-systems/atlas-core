import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile, readdir } from 'node:fs/promises';
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
const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.data; };
const descriptor = bytes => ({ request_id: uuid(), object_id: uuid(), byte_length: String(bytes.byteLength), sha256: createHash('sha256').update(bytes).digest('hex'), content_type: 'application/octet-stream', metadata: { associations: [] } });
test('startup reclaims escaped abandoned upload descriptors across bounded worker response pages', async t => {
  const f = await fixture(t, { resourceImageBytes: 65536, maxUploads: 64, limits: { ...defaults.limits, max_message_bytes: 212992 } }); await f.core.close();
  const engine = new Engine(f.directory, f.settings);
  const owner = { ...await processIdentity(), start: '0' };
  const authority = engine.identity.authorize(digest(f.apiKey));
  try {
    for (let i = 0; i < 65; i++) {
      const input = descriptor(Buffer.from('partial'));
      input.metadata.description = '"'.repeat(4096);
      const attempt = await engine.reserveStorage(admit => engine.store.db.transaction(() => engine.objects.prepare(input, uuid(), owner, authority.keyId, admit))());
      await engine.reserveStorage(admit => engine.objects.reserve(attempt.id, 7, admit)); engine.objects.abandon(attempt.id);
      await writeFile(join(f.directory, 'objects', attempt.staging), 'partial');
    }
  } finally { await engine.close(); }
  assert.equal((await readdir(join(f.directory, 'objects', 'staging'))).length, 65);
  await f.restart();
  assert.deepEqual(await readdir(join(f.directory, 'objects', 'staging')), []);
  assert.deepEqual(await f.core.rpc.call('file-owners', {}, 1024, true), []);
  assert.equal(ok(await f.call('GetHealth')).healthy, true);
});
test('stream publication, exact retry, integrity faults, permanent holds and deletion lifetime', async t => {
  const f = await fixture(t);
  const bytes = Buffer.alloc(1_000_000, 0x9a), request = descriptor(bytes);
  const first = await f.upload(request, bytes); const image = ok(first);
  const retry = await f.upload(request, bytes, true); assert.equal(ok(retry).object_id, image.object_id); assert.equal(first.json.commit_cursor, retry.json.commit_cursor);
  assert.equal((await readdir(join(f.directory, 'objects', 'installed'))).length, 1);
  assert.equal((await f.upload({ ...request, request_id: uuid() }, bytes)).json.error.code, 'identity_conflict');
  const asset = ok(await f.call('RegisterAsset', registration())).asset;
  const task = ok(await f.call('CreateTask', { request_id: uuid(), task_id: uuid(), asset_id: asset.id, command: 'pause', scheduling: 'immediate', inputs: {} }));
  const evidence = { dataset_id: f.core.dataset, asset_id: asset.id, origin: { kind: 'asset_process', process_generation: asset.process_generation }, report_id: uuid(), sequence: '1', generated_at: null, payload: { task_id: task.task_id, declarations: [{ object_id: image.object_id, required: true }] } };
  ok(await f.call('ReportTaskResults', { evidence }));
  assert.equal((await f.call('DeleteObject', { object_id: image.object_id, request_id: uuid() })).json.error.code, 'object_held');
  const names = await readdir(join(f.directory, 'objects', 'installed'));
  await writeFile(join(f.directory, 'objects', 'installed', names[0]), Buffer.alloc(bytes.length, 1));
  assert.equal((await f.call('ReadObjectContent', { object_id: image.object_id, disposition: 'inline' })).json.error.code, 'integrity_fault');
  assert.equal(ok(await f.call('GetObject', { object_id: image.object_id })).sha256, request.sha256);
  assert.equal(ok(await f.call('GetHealth')).healthy, false); assert.equal(ok(await f.call('GetReadiness')).ready, true);
  await writeFile(join(f.directory, 'objects', 'installed', names[0]), bytes);
  assert.deepEqual((await f.call('ReadObjectContent', { object_id: image.object_id, disposition: 'attachment' })).bytes, bytes);
  assert.equal(ok(await f.call('GetHealth')).healthy, true);
  const empty = Buffer.alloc(0), deletable = descriptor(empty); ok(await f.upload(deletable, empty));
  ok(await f.call('DeleteObject', { object_id: deletable.object_id, request_id: uuid() }));
  assert.equal((await f.upload(deletable, empty)).json.error.code, 'identity_conflict');
  assert.equal((await f.call('ReadObjectContent', { object_id: deletable.object_id, disposition: 'inline' })).status, 404);
});
test('digest and quota failures publish no partial metadata or surviving attempt files', async t => {
  const f = await fixture(t, { objectBytes: 1024 });
  const bytes = Buffer.from('exact bytes'); const request = descriptor(bytes);
  assert.equal((await f.upload({ ...request, sha256: '0'.repeat(64) }, bytes)).status, 400);
  assert.equal((await f.call('GetObject', { object_id: request.object_id })).status, 404);
  const large = Buffer.alloc(2048); assert.equal((await f.upload(descriptor(large), large)).json.error.code, 'storage_limit');
  assert.deepEqual(await readdir(join(f.directory, 'objects', 'installed')), []);
  assert.deepEqual(await readdir(join(f.directory, 'objects', 'staging')), []);
});
test('requests following early multipart refusals complete without a stale TLS connection', { timeout: 20000 }, async t => {
  const cleanups = [], f = await fixture({ after: cleanup => cleanups.push(cleanup) }, { objectBytes: 1048576 });
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(async () => {
    agent.destroy();
    f.core.app.server.closeAllConnections();
    for (const cleanup of cleanups) await cleanup();
  });
  const call = (method, path, body, contentType = 'application/json') => new Promise((resolve, reject) => {
    const request = httpsRequest(new URL(path, f.address), { method, agent, ca: f.ca, headers: {
      Authorization: `Bearer ${f.apiKey}`, 'Atlas-Dataset-ID': f.core.dataset, 'Atlas-Protocol-Version': '0.3.0',
      ...(body === undefined ? {} : { 'Content-Type': contentType, 'Content-Length': body.length }),
    } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        try { resolve({ status: response.statusCode, headers: response.headers, json: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (error) { reject(error); }
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error('following_request_stalled')));
    request.on('error', reject);
    request.end(body);
  });
  ok(await call('GET', '/health'));
  for (const reverse of [false, true]) {
    const bytes = Buffer.alloc(2 * 1048576, 7), input = descriptor(bytes), boundary = 'refused-upload-boundary';
    const description = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="descriptor"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(input)}\r\n`);
    const file = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="payload.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`), bytes, Buffer.from('\r\n')]);
    const body = Buffer.concat([...(reverse ? [file, description] : [description, file]), Buffer.from(`--${boundary}--\r\n`)]);
    const refused = await call('POST', '/objects', body, `multipart/form-data; boundary=${boundary}`);
    assert.equal(refused.status, 507);
    assert.equal(refused.json.error.code, 'storage_limit');
    t.diagnostic(JSON.stringify({ reverse, connection: refused.headers.connection }));
    assert.equal(ok(await call('GET', '/health')).healthy, true);
    assert.equal((await f.call('GetObject', { object_id: input.object_id })).status, 404);
    assert.deepEqual(await readdir(join(f.directory, 'objects', 'staging')), []);
    assert.deepEqual(await readdir(join(f.directory, 'objects', 'installed')), []);
  }
});
test('revocation interrupts an idle multipart writer and releases its files and admission slot', async t => {
  const f = await fixture(t, { maxUploads: 1 });
  const key = { api_key_id: uuid(), request_id: uuid(), secret: secret() };
  ok(await f.call('CreateApiKey', key));
  const payload = Buffer.alloc(100_000, 7), input = descriptor(payload);
  const req = httpsRequest(new URL('/objects', f.address), { method: 'POST', ca: f.ca, headers: {
    Authorization: `Bearer ${key.secret}`, 'Atlas-Dataset-ID': f.core.dataset, 'Atlas-Protocol-Version': '0.3.0',
    'Content-Type': 'multipart/form-data; boundary=idle',
  } });
  t.after(() => req.destroy());
  const closed = new Promise(resolve => { req.on('error', () => {}); req.once('close', resolve); req.once('response', res => res.resume()); });
  req.write(`--idle\r\nContent-Disposition: form-data; name="descriptor"\r\n\r\n${JSON.stringify(input)}\r\n--idle\r\nContent-Disposition: form-data; name="file"; filename="owned.bin"\r\n\r\n`);
  req.write(payload.subarray(0, 1024));
  const staging = join(f.directory, 'objects', 'staging');
  for (let i = 0; (await readdir(staging)).length === 0 && i < 100; i++) await delay(20);
  assert.equal((await readdir(staging)).length, 1);
  ok(await f.call('RevokeApiKey', { api_key_id: key.api_key_id, request_id: uuid() }));
  await Promise.race([closed, delay(3000).then(() => { throw new Error('revoked_upload_still_open'); })]);
  const cleanupDeadline = Date.now() + 2000;
  while ((await readdir(staging)).length !== 0 && Date.now() < cleanupDeadline) await delay(20);
  assert.deepEqual(await readdir(staging), []);
  assert.deepEqual(await readdir(join(f.directory, 'objects', 'installed')), []);
  assert.equal((await f.call('GetObject', { object_id: input.object_id })).status, 404);
  const nextBytes = Buffer.from('next'), nextInput = descriptor(nextBytes);
  let uploaded;
  do {
    uploaded = await f.upload(nextInput, nextBytes);
    if (uploaded.status === 200) break;
    assert.equal(uploaded.json?.error.code, 'resource_limit', JSON.stringify(uploaded.json));
    await delay(20);
  } while (Date.now() < cleanupDeadline);
  assert.equal(ok(uploaded).object_id, nextInput.object_id);
  assert.deepEqual((await f.call('ReadObjectContent', { object_id: nextInput.object_id, disposition: 'inline' })).bytes, nextBytes);
});
test('verified process exit reclaims owned attempts and captures while ambiguous files survive', { timeout: 15000 }, async t => {
  const cleanup = [];
  let child, childExit;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (childExit) await childExit;
    for (const close of cleanup.reverse()) await close();
  });
  const f = await fixture({ after: fn => cleanup.push(fn) });
  const asset = ok(await f.call('RegisterAsset', registration())).asset;
  await f.core.close();
  const source = `
    const {createCore} = await import(process.argv[2]);
    let input = ''; for await (const bytes of process.stdin) input += bytes;
    const core = await createCore(JSON.parse(input));
    process.stdout.write(JSON.stringify({ address: await core.listen() }) + '\\n');
  `;
  const entry = join(f.directory, 'owned-child.mjs'); await writeFile(entry, source, { mode: 0o600 });
  child = spawn(process.execPath, [entry, new URL('../dist/server.js', import.meta.url).href], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
  childExit = once(child, 'exit');
  child.stdin.end(JSON.stringify({ directory: f.directory, certificate: f.certificate, key: f.key, settings: f.settings }));
  const address = await new Promise((resolve, reject) => {
    let output = ''; child.once('error', reject);
    child.stdout.on('data', bytes => { output += bytes; if (output.includes('\n')) resolve(JSON.parse(output).address); });
    child.once('exit', () => reject(new Error('child_not_ready')));
  });
  function headers() { return { Authorization: `Bearer ${f.apiKey}`, 'Atlas-Dataset-ID': f.core.dataset, 'Atlas-Protocol-Version': '0.3.0' }; }
  async function call(path, input) {
    const body = input === undefined ? undefined : Buffer.from(JSON.stringify(input));
    return new Promise((resolve, reject) => {
      const req = httpsRequest(new URL(path, address), { ca: f.ca, method: body ? 'POST' : 'GET', headers: { ...headers(), ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}) } }, res => {
        const chunks = []; res.on('data', bytes => chunks.push(bytes)); res.on('end', () => { assert.equal(res.statusCode, 200); resolve(JSON.parse(Buffer.concat(chunks))); });
      }); req.on('error', reject); req.end(body);
    });
  }
  const health = (await call('/health')).data;
  const snapshot = (await call('/messages/read_snapshot', { load_id: uuid(), allocation_context: health.allocation_context, page_size: 100, max_message_bytes: 4194304, max_json_values: 262144, max_changes: 1000 })).data;
  assert.equal(snapshot.items.length, 1);
  assert.equal((await readdir(join(f.directory, 'captures'))).length, 1);
  const payload = Buffer.alloc(100000, 9), input = descriptor(payload);
  const req = httpsRequest(new URL('/objects', address), { ca: f.ca, method: 'POST', headers: { ...headers(), 'Content-Type': 'multipart/form-data; boundary=interrupted' } });
  const requestClosed = new Promise(resolve => { req.on('error', () => {}); req.once('close', resolve); });
  req.write(`--interrupted\r\nContent-Disposition: form-data; name="descriptor"\r\n\r\n${JSON.stringify(input)}\r\n--interrupted\r\nContent-Disposition: form-data; name="file"; filename="owned.bin"\r\n\r\n`);
  req.write(payload.subarray(0, 1024));
  const staging = join(f.directory, 'objects', 'staging'), installed = join(f.directory, 'objects', 'installed');
  for (let i = 0; (await readdir(staging)).length === 0 && i < 100; i++) await delay(20);
  assert.equal((await readdir(staging)).length, 1);
  const ambiguous = `${uuid()}-${uuid()}`;
  await writeFile(join(installed, ambiguous), 'retain without owner evidence');
  child.kill('SIGKILL'); await childExit; req.destroy(); await requestClosed;
  await f.restart();
  assert.deepEqual(await readdir(staging), []);
  assert.deepEqual(await readdir(installed), [ambiguous]);
  assert.deepEqual(await readdir(join(f.directory, 'captures')), []);
  assert.equal(ok(await f.call('GetAsset', { asset_id: asset.id })).id, asset.id);
  assert.equal((await f.call('GetObject', { object_id: input.object_id })).status, 404);
  assert.equal((await f.call('ReleaseSnapshot', { release_token: snapshot.release_token })).json.error.code, 'allocation_expired');
});
