import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { exchanges } from '@atlas/protocol';
const { createClient } = await import(process.env.ATLAS_SDK_ENTRY ?? '../dist/index.js');
import { fixture, barrier, uuid } from './harness.mjs';

const descriptor = (bytes) => ({
  object_id: uuid(),
  request_id: uuid(),
  byte_length: String(bytes.byteLength),
  sha256: createHash('sha256').update(bytes).digest('hex'),
  content_type: 'application/octet-stream',
  metadata: { associations: [] },
});
function response(result, kind = 'success') {
  assert.equal(result.kind, 'response', JSON.stringify(result));
  assert.equal(result.response.kind, kind, JSON.stringify(result));
  return result.response;
}
async function setup(t, f, options = {}) {
  const client = createClient({ baseUrl: f.proxyUrl, credentials: () => f.apiKey, ...options });
  t.after(() => client.close());
  response(await client.connect());
  return { client };
}

function source(bytes, opened = () => {}) {
  return {
    open() {
      opened();
      let offset = 0;
      return new ReadableStream(
        {
          pull(controller) {
            if (offset === bytes.byteLength) controller.close();
            else {
              const end = Math.min(offset + 65536, bytes.byteLength);
              controller.enqueue(bytes.subarray(offset, end));
              offset = end;
            }
          },
        },
        { highWaterMark: 0 },
      );
    },
  };
}
async function download(client, facts, options) {
  const job = client.objects.content(
    { object_id: facts.object_id, disposition: 'attachment' },
    options,
  );
  const opened = response(await job.open(), 'content');
  const chunks = [];
  for await (const chunk of opened.stream) chunks.push(chunk);
  response(await job.settled, 'content');
  return Buffer.concat(chunks);
}

test('transfers: native Blob publication, verified binary content, empty content and typed references', async (t) => {
  const f = await fixture(t);
  const { client } = await setup(t, f);
  for (const bytes of [Buffer.from('exact binary\0\xff'), Buffer.alloc(0)]) {
    const facts = descriptor(bytes);
    f.once('/objects', ({ request, forward }) => {
      assert.ok(request.indexOf('name="descriptor"') < request.indexOf('name="file"'));
      assert.match(
        request.toString('latin1'),
        /name="descriptor"[^\r]*\r\nContent-Type: application\/json/,
      );
      assert.match(
        request.toString('latin1'),
        /name="file"[^\r]*\r\nContent-Type: application\/octet-stream/,
      );
      forward();
    });
    const operation = client.objects.upload(facts, new Blob([bytes], { type: 'text/plain' }));
    const result = await operation.send();
    assert.equal(result.outcome.kind, 'accepted');
    assert.equal(response(result.attempt).body.data.object_id, facts.object_id);
    assert.equal(result.attempt.context.suppliedBytes, bytes.length);
    assert.equal(result.attempt.context.observedTransportBytes, null);
    assert.deepEqual(await download(client, facts), bytes);
  }
  const html = response(await client.reference('text/html'), 'reference');
  assert.equal(html.media, 'text/html');
  assert.match(html.document, /<html/i);
  const schema = response(await client.reference('application/vnd.oai.openapi+json'), 'reference');
  assert.equal(JSON.parse(schema.document).info.version, '0.3.0');
  await client.close();
});

test('transfers: fresh byte-zero streams recover a lost committed reply with one Object and shared immutable evidence', async (t) => {
  const f = await fixture(t);
  const { client } = await setup(t, f);
  const bytes = Buffer.alloc(180_000, 0xa3),
    facts = descriptor(bytes);
  let opens = 0;
  const replay = source(bytes, () => opens++);
  const operation = client.objects.upload(facts, replay);
  const same = client.objects.upload(structuredClone(facts), replay);
  facts.metadata.name = 'changed after preparation';
  assert.equal(operation.submission.facts.metadata.name, undefined);
  assert.throws(() => client.objects.upload(facts, replay), { code: 'identity_conflict' });
  f.once('/objects', ({ outgoing }) => outgoing.destroy());
  assert.equal((await operation.send()).outcome.kind, 'unknown_outcome');
  assert.equal(same.outcome.kind, 'unknown_outcome');
  const recovered = await same.send();
  response(recovered.attempt);
  assert.equal(recovered.outcome.kind, 'accepted');
  assert.equal(operation.outcome.kind, 'accepted');
  assert.equal(opens, 2);
  assert.equal(recovered.attempt.context.suppliedBytes, bytes.length);
  const listed = response(await client.objects.list({}).next()).body.data;
  assert.deepEqual(
    listed.items.map((x) => x.object_id),
    [facts.object_id],
  );
  assert.deepEqual(await download(client, facts), bytes);
  await client.close();
});

test('transfers: malformed or mismatched upload replies remain unknown until exact retry validates the committed Object', async (t) => {
  const f = await fixture(t);
  const { client } = await setup(t, f);
  for (const malformed of [true, false]) {
    const bytes = Buffer.from('committed despite bad reply'),
      facts = descriptor(bytes);
    f.once('/objects', ({ body, forward }) => {
      if (malformed) forward(Buffer.from('{'));
      else {
        const reply = JSON.parse(body);
        reply.data.object_id = uuid();
        forward(Buffer.from(JSON.stringify(reply)));
      }
    });
    const operation = client.objects.upload(facts, source(bytes));
    const uncertain = await operation.send();
    assert.equal(uncertain.attempt.kind, 'failed');
    assert.equal(uncertain.outcome.kind, 'unknown_outcome');
    assert.equal(response((await operation.send()).attempt).body.data.object_id, facts.object_id);
    assert.equal(operation.outcome.kind, 'accepted');
  }
  assert.equal(response(await client.objects.list({}).next()).body.data.items.length, 2);
  await client.close();
});

test('transfers: diagnostics observe settled evidence and count source bytes without leaking source facts', async (t) => {
  const f = await fixture(t);
  const events = [],
    delivered = barrier();
  let operation, observedOutcome;
  const { client } = await setup(t, f, {
    diagnostics: {
      mode: 'debug',
      observer(event) {
        events.push(event);
        if (
          event.kind === 'request' &&
          event.operation === 'UploadObject' &&
          event.outcome === 'success'
        ) {
          observedOutcome = operation.outcome.kind;
          delivered.resolve();
        }
      },
    },
  });
  const bytes = Buffer.from('private file bytes'),
    facts = descriptor(bytes);
  facts.metadata.name = 'private-operational-filename';
  operation = client.objects.upload(facts, source(bytes));
  f.once('/objects', ({ outgoing }) => outgoing.destroy());
  assert.equal((await operation.send()).outcome.kind, 'unknown_outcome');
  response((await operation.send()).attempt);
  await delivered.promise;
  assert.equal(observedOutcome, 'accepted');
  const attempts = events.filter(
    (event) =>
      event.kind === 'request' && event.operation === 'UploadObject' && event.phase === 'attempt',
  );
  assert.equal(attempts.length, 2);
  assert.deepEqual(
    attempts.map((event) => event.bytes.supplied),
    [bytes.length, bytes.length],
  );
  assert.deepEqual(
    attempts.map((event) => event.bytes.observedTransport),
    [null, null],
  );
  assert.deepEqual(
    attempts.map((event) => event.operationOutcome),
    ['unknown_outcome', 'accepted'],
  );
  assert.equal(attempts[1].resolution, true);
  assert.equal(attempts[0].retryId, facts.request_id);
  const serialized = JSON.stringify(events);
  for (const secret of [facts.metadata.name, facts.sha256, bytes.toString(), f.apiKey])
    assert.ok(!serialized.includes(secret));
  await client.close();
});

test('transfers: one-shot and externally disturbed streams fail before a repeat transmission', async (t) => {
  const f = await fixture(t);
  const { client } = await setup(t, f);
  const bytes = Buffer.from('one shot'),
    facts = descriptor(bytes);
  const stream = source(bytes).open();
  const operation = client.objects.upload(facts, stream);
  response((await operation.send()).attempt);
  const before = f.traffic.length;
  const repeat = await operation.send();
  assert.equal(repeat.attempt.kind, 'not_sent');
  assert.equal(repeat.attempt.code, 'non_replayable_source');
  assert.equal(repeat.outcome.kind, 'accepted');
  const external = source(bytes).open();
  const reader = external.getReader();
  await reader.read();
  reader.releaseLock();
  const disturbed = client.objects.upload(descriptor(bytes), { open: () => external });
  assert.equal((await disturbed.send()).attempt.code, 'non_replayable_source');
  await external.cancel();
  assert.equal(f.traffic.length, before);
  await client.close();
});

test('transfers: malformed descriptors and Blob length mismatch publish nothing and leave not_submitted', async (t) => {
  const f = await fixture(t);
  const { client } = await setup(t, f);
  const bytes = Buffer.from('facts'),
    facts = descriptor(bytes);
  assert.throws(() => client.objects.upload({ ...facts, byte_length: '0005' }, new Blob([bytes])));
  assert.throws(() =>
    client.objects.upload(
      { ...facts, metadata: { associations: [], name: null } },
      new Blob([bytes]),
    ),
  );
  const operation = client.objects.upload(facts, new Blob([]));
  const before = f.traffic.length;
  const result = await operation.send();
  assert.equal(result.attempt.code, 'integrity_mismatch');
  assert.equal(result.attempt.kind, 'not_sent');
  assert.equal(result.outcome.kind, 'not_submitted');
  assert.equal(f.traffic.length, before);
  await client.close();
});

test('transfers: declared limits refuse before opening and source-side close awaits cleanup without transmission', async (t) => {
  const f = await fixture(t, {
    limits: {
      max_request_bytes: 1048576,
      max_request_json_values: 65536,
      max_message_bytes: 4194304,
      max_json_values: 262144,
      max_changes: 1000,
      max_control_bytes: 16384,
      max_control_json_values: 4096,
      max_json_depth: 32,
      max_object_bytes: 1024,
    },
  });
  const { client } = await setup(t, f);
  let opened = 0;
  const oversized = client.objects.upload(descriptor(Buffer.alloc(2048)), {
    open() {
      opened++;
      return new ReadableStream();
    },
  });
  const before = f.traffic.length;
  assert.equal((await oversized.send()).attempt.code, 'payload_too_large');
  assert.equal(opened, 0);
  const release = barrier(),
    cancelling = barrier();
  let closing;
  const operation = client.objects.upload(descriptor(Buffer.from('bounded')), {
    open() {
      closing = client.close();
      return new ReadableStream(
        {
          cancel() {
            cancelling.resolve();
            return release.promise;
          },
        },
        { highWaterMark: 0 },
      );
    },
  });
  const active = operation.start();
  await cancelling.promise;
  release.resolve();
  const result = await active.settled;
  assert.equal(result.kind, 'not_sent');
  assert.equal(result.code, 'closed');
  assert.equal(operation.outcome.kind, 'not_submitted');
  assert.equal(f.traffic.length, before);
  await closing;
});

test('transfers: oversized source chunks fail without proportional copies or publication', async (t) => {
  const f = await fixture(t);
  const { client } = await setup(t, f, { baseUrl: f.address });
  const bytes = Buffer.alloc(1024 * 1024 + 1, 1);
  let cancelled = false;
  const operation = client.objects.upload(descriptor(bytes), {
    open() {
      return new ReadableStream(
        {
          pull(controller) {
            controller.enqueue(bytes);
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
    },
  });
  const result = await operation.send();
  assert.equal(result.attempt.code, 'resource_limit');
  assert.equal(cancelled, true);
  assert.equal(result.attempt.context.suppliedBytes, bytes.length);
  assert.equal(result.outcome.kind, 'unknown_outcome');
  const list = response(await client.objects.list({}).next()).body.data;
  assert.deepEqual(list.items, []);
  await client.close();
});

test('transfers: source and content failures never establish publication', async (t) => {
  const f = await fixture(t);
  const { client } = await setup(t, f, { baseUrl: f.address });
  const bytes = Buffer.from('complete');
  for (const input of [
    { source: source(bytes.subarray(1)), code: 'integrity_mismatch' },
    { source: source(Buffer.from('wrong!!!')), code: 'integrity_mismatch' },
    {
      source: {
        open() {
          throw new Error('secret filename');
        },
      },
      code: 'source_failure',
      notSent: true,
    },
    {
      source: {
        open() {
          return new ReadableStream({
            pull() {
              throw new Error('private');
            },
          });
        },
      },
      code: 'source_failure',
    },
  ]) {
    const facts = descriptor(bytes);
    const operation = client.objects.upload(facts, input.source);
    const result = await operation.send();
    assert.equal(result.attempt.code, input.code);
    assert.equal(result.outcome.kind, input.notSent ? 'not_submitted' : 'unknown_outcome');
    const missing = response(await client.objects.get({ object_id: facts.object_id }), 'error');
    assert.equal(missing.body.error.code, 'entity_not_found');
  }
  const facts = descriptor(bytes);
  const wrongHash = client.objects.upload({ ...facts, sha256: '0'.repeat(64) }, new Blob([bytes]));
  assert.equal(
    response((await wrongHash.send()).attempt, 'error').body.error.code,
    'invalid_request',
  );
  await client.close();
});

test('transfers: content refuses corrupted bytes, wrong context, malformed headers and declared limits', async (t) => {
  const f = await fixture(t);
  const { client } = await setup(t, f);
  const bytes = Buffer.from('content integrity'),
    facts = descriptor(bytes);
  response((await client.objects.upload(facts, new Blob([bytes])).send()).attempt);
  const path = `/objects/${facts.object_id}/content?disposition=inline`;
  for (const change of [
    { headers: { 'atlas-dataset-id': uuid() }, code: 'invalid_http' },
    { headers: { 'atlas-protocol-version': 'other' }, code: 'invalid_http' },
    { headers: { 'atlas-content-sha256': 'not-a-digest' }, code: 'invalid_http' },
    { headers: { 'content-disposition': 'attachment' }, code: 'invalid_http' },
    { headers: { 'content-encoding': 'identity' }, code: 'invalid_http' },
  ]) {
    f.once(path, ({ headers, forward }) => forward(bytes, 200, { ...headers, ...change.headers }));
    const job = client.objects.content({ object_id: facts.object_id, disposition: 'inline' });
    assert.equal((await job.open()).code, change.code);
    assert.equal((await job.settled).code, change.code);
  }
  for (const altered of [Buffer.alloc(bytes.length, 1), bytes.subarray(1)]) {
    f.once(path, ({ forward }) => forward(altered));
    const job = client.objects.content({ object_id: facts.object_id, disposition: 'inline' });
    const opened = response(await job.open(), 'content');
    await assert.rejects(
      async () => {
        for await (const chunk of opened.stream) void chunk;
      },
      { code: 'integrity_mismatch' },
    );
    assert.equal((await job.settled).code, 'integrity_mismatch');
  }
  const bounded = client.objects.content(
    { object_id: facts.object_id, disposition: 'inline' },
    { maxBytes: bytes.length - 1 },
  );
  assert.equal((await bounded.open()).code, 'payload_too_large');
  const missing = client.objects.content({ object_id: uuid(), disposition: 'inline' });
  assert.equal(response(await missing.open(), 'error').body.error.code, 'entity_not_found');
  await client.close();
});

test('transfers: reference responses enforce media, UTF-8, JSON and response bounds', async (t) => {
  const f = await fixture(t);
  const { client } = await setup(t, f);
  for (const value of [
    {
      bytes: Buffer.from('<html>bad'),
      headers: { 'content-type': 'text/plain' },
      code: 'invalid_http',
    },
    { bytes: Buffer.from([0xff]), headers: { 'content-type': 'text/html' }, code: 'invalid_utf8' },
    {
      bytes: Buffer.from('{"a":1,"a":2}'),
      headers: { 'content-type': 'application/vnd.oai.openapi+json' },
      code: 'invalid_json',
      media: 'application/vnd.oai.openapi+json',
    },
  ]) {
    f.once('/reference', ({ headers, forward }) =>
      forward(value.bytes, 200, { ...headers, ...value.headers }),
    );
    assert.equal((await client.reference(value.media ?? 'text/html')).code, value.code);
  }
  const bounded = await setup(t, f, { limits: { response: { maxBytes: 4096 } } });
  assert.equal(
    (await bounded.client.reference('application/vnd.oai.openapi+json')).code,
    'payload_too_large',
  );
  await bounded.client.close();
  await client.close();
});

test('transfers: an unread download retains admission until cancellation and close stops its network owner', async (t) => {
  const f = await fixture(t);
  const { client } = await setup(t, f, { limits: { concurrentAttempts: 1 } });
  const bytes = Buffer.alloc(256_000, 4),
    facts = descriptor(bytes);
  response((await client.objects.upload(facts, new Blob([bytes])).send()).attempt);
  const job = client.objects.content({ object_id: facts.object_id, disposition: 'inline' });
  const opened = response(await job.open(), 'content');
  assert.equal((await client.reference('text/html')).code, 'capacity');
  let opens = 0;
  const refused = client.objects.upload(
    descriptor(bytes),
    source(bytes, () => opens++),
  );
  assert.equal((await refused.send()).attempt.code, 'capacity');
  assert.equal(opens, 0);
  await opened.stream.cancel();
  assert.equal((await job.settled).code, 'cancelled');
  response(await client.reference('text/html'), 'reference');
  const other = client.objects.content({ object_id: facts.object_id, disposition: 'inline' });
  const active = response(await other.open(), 'content');
  await client.close();
  assert.equal((await other.settled).code, 'closed');
  await assert.rejects(active.stream.getReader().read(), { code: 'closed' });
});

test('transfers: caller cancellation leaves a bounded attempt able to validate its matching late success', async (t) => {
  const f = await fixture(t);
  const { client } = await setup(t, f);
  const bytes = Buffer.from('late acceptance'),
    facts = descriptor(bytes);
  const captured = barrier(),
    release = barrier();
  f.once('/objects', async ({ forward }) => {
    captured.resolve();
    await release.promise;
    forward();
  });
  const operation = client.objects.upload(facts, source(bytes));
  const running = operation.start();
  await captured.promise;
  const caller = new AbortController();
  caller.abort();
  assert.equal((await running.wait(caller.signal)).kind, 'cancelled');
  assert.equal(operation.outcome.kind, 'unknown_outcome');
  release.resolve();
  response(await running.settled);
  assert.equal(operation.outcome.kind, 'accepted');
  await client.close();
});

test('transfers: content wait cancellation is independent and an idle body still meets its deadline', async (t) => {
  const f = await fixture(t);
  const { client } = await setup(t, f);
  const bytes = Buffer.alloc(32768, 0x42),
    facts = descriptor(bytes);
  response((await client.objects.upload(facts, new Blob([bytes])).send()).attempt);
  const path = `/objects/${facts.object_id}/content?disposition=inline`;
  const held = barrier(),
    release = barrier();
  f.once(path, async ({ forward }) => {
    held.resolve();
    await release.promise;
    forward();
  });
  const read = client.objects.content({ object_id: facts.object_id, disposition: 'inline' });
  await held.promise;
  const caller = new AbortController();
  caller.abort();
  assert.equal((await read.open(caller.signal)).kind, 'cancelled');
  release.resolve();
  const opened = response(await read.open(), 'content');
  let received = 0;
  for await (const chunk of opened.stream) received += chunk.length;
  assert.equal(received, bytes.length);
  response(await read.settled, 'content');
  const idle = client.objects.content(
    { object_id: facts.object_id, disposition: 'inline' },
    { timeoutMs: 150 },
  );
  const idleContent = response(await idle.open(), 'content');
  assert.equal((await idle.settled).code, 'deadline');
  await assert.rejects(idleContent.stream.getReader().read(), { code: 'deadline' });
  await client.close();
});

test('transfers: authority pause and Dataset fencing prevent all traffic and source opening', async (t) => {
  const f = await fixture(t);
  const { client } = await setup(t, f);
  const bytes = Buffer.from('never opened');
  let opens = 0;
  const operation = client.objects.upload(
    descriptor(bytes),
    source(bytes, () => opens++),
  );
  const published = descriptor(bytes);
  response((await client.objects.upload(published, new Blob([bytes])).send()).attempt);
  const active = client.objects.content({ object_id: published.object_id, disposition: 'inline' });
  const handle = response(await active.open(), 'content');
  const admin = f.client();
  response(await admin.connect());
  response(
    (await admin.apiKeys.revoke({ api_key_id: f.apiKeyId, request_id: uuid() }).send()).attempt,
    'error',
  );
  response(await client.reference('text/html'), 'error');
  assert.equal(client.state.kind, 'authorization-required');
  assert.equal((await active.settled).code, 'authorization_required');
  await assert.rejects(handle.stream.getReader().read(), { code: 'authorization_required' });
  const before = f.traffic.length;
  assert.equal((await operation.send()).attempt.code, 'authorization_required');
  assert.equal((await client.reference('text/html')).code, 'authorization_required');
  assert.equal(
    (await client.objects.content({ object_id: uuid(), disposition: 'inline' }).open()).code,
    'authorization_required',
  );
  assert.equal(opens, 0);
  assert.equal(f.traffic.length, before);
  await client.close();
});

test('transfers: original Dataset submissions stay fenced after Reset while accepted evidence remains', async (t) => {
  const f = await fixture(t);
  const { client } = await setup(t, f);
  const bytes = Buffer.from('old dataset');
  let opens = 0;
  const operation = client.objects.upload(
    descriptor(bytes),
    source(bytes, () => opens++),
  );
  response((await operation.send()).attempt);
  await f.reset();
  response(await client.connect());
  const before = f.traffic.length;
  assert.equal((await operation.send()).attempt.code, 'dataset_invalidated');
  assert.equal(operation.outcome.evidence.kind, 'accepted');
  assert.equal(opens, 1);
  assert.equal(f.traffic.length, before);
  await client.close();
});

test('transfers: source cancellation holds admission and shutdown through awaited cleanup', async (t) => {
  const f = await fixture(t);
  const { client } = await setup(t, f, {
    baseUrl: f.address,
    limits: { concurrentAttempts: 1 },
  });
  const reading = barrier(),
    stopping = barrier(),
    release = barrier();
  const operation = client.objects.upload(descriptor(Buffer.from('one')), {
    open() {
      return new ReadableStream(
        {
          pull() {
            reading.resolve();
            return new Promise(() => {});
          },
          cancel() {
            stopping.resolve();
            return release.promise;
          },
        },
        { highWaterMark: 0 },
      );
    },
  });
  const running = operation.start({ timeoutMs: 100 });
  await reading.promise;
  await stopping.promise;
  assert.equal((await client.reference('text/html')).code, 'capacity');
  let closed = false;
  const closing = client.close().then(() => {
    closed = true;
  });
  await delay(20);
  assert.equal(closed, false);
  release.resolve();
  const result = await running.settled;
  assert.equal(result.code, 'deadline');
  assert.equal(operation.outcome.kind, 'unknown_outcome');
  await closing;
  assert.equal(closed, true);
});

test('transfers: source cleanup rejection preserves both primary deadline and safe cleanup failure', async (t) => {
  const f = await fixture(t);
  const { client } = await setup(t, f, { baseUrl: f.address });
  const operation = client.objects.upload(descriptor(Buffer.from('one')), {
    open() {
      return new ReadableStream(
        {
          pull() {
            return new Promise(() => {});
          },
          cancel() {
            throw new Error('private cleanup filename');
          },
        },
        { highWaterMark: 0 },
      );
    },
  });
  const result = await operation.start({ timeoutMs: 100 }).settled;
  assert.equal(result.code, 'deadline');
  assert.equal(result.context.cleanupFailure, 'network');
  assert.equal(operation.outcome.kind, 'unknown_outcome');
  await client.close();
});
