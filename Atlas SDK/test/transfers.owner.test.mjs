import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { TransferReader, verifiedStream } from '../dist/transfer-stream.js';
import { SdkError } from '../dist/contracts.js';

const mebibyte = 1024 * 1024;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('transfers: network split boundaries preserve exact bytes, EOF integrity and pull demand', async (t) => {
  for (const size of [mebibyte - 1, mebibyte, mebibyte + 1, 3 * mebibyte + 17]) {
    await t.test(`${size} network bytes`, async () => {
      const bytes = Buffer.alloc(size);
      for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
      let pulls = 0;
      const signal = new AbortController().signal;
      const incoming = new ReadableStream(
        {
          pull(controller) {
            if (++pulls === 1) controller.enqueue(bytes);
            else controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      const owner = new TransferReader(incoming, signal, size, digest(bytes), 'download');
      const content = verifiedStream(owner, signal);
      await setImmediate();
      assert.equal(pulls, 0, 'No input pull before consumer demand');
      let offset = 0;
      for await (const piece of content.stream) {
        assert.ok(piece.byteLength <= mebibyte);
        assert.ok(piece.buffer.byteLength <= mebibyte, 'Returned storage is bounded');
        assert.deepEqual(Buffer.from(piece), bytes.subarray(offset, offset + piece.byteLength));
        offset += piece.byteLength;
        assert.equal(owner.bytes, size, 'Count incoming bytes once before splitting');
        assert.equal(pulls, 1, 'Do not pull while the incoming chunk has a remainder');
      }
      await content.completed;
      assert.equal(offset, size);
      assert.equal(pulls, 2, 'Read EOF after the last piece');
      assert.equal(incoming.locked, false);
    });
  }
});

test('transfers: whole network chunks must fit remaining length before returning any piece', async () => {
  const first = Buffer.from('prefix');
  const excess = Buffer.alloc(2 * mebibyte + 1);
  const expected = Buffer.concat([first, excess.subarray(0, mebibyte + 1)]);
  const chunks = [first, excess];
  const signal = new AbortController().signal;
  let cancellations = 0;
  const incoming = new ReadableStream(
    {
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        cancellations++;
      },
    },
    { highWaterMark: 0 },
  );
  const owner = new TransferReader(incoming, signal, expected.length, digest(expected), 'download');
  try {
    assert.deepEqual(Buffer.from(await owner.read()), first);
    await assert.rejects(owner.read(), { code: 'integrity_mismatch' });
    assert.equal(owner.bytes, first.length + excess.length);
  } finally {
    await owner.close();
  }
  assert.equal(cancellations, 1);
  assert.equal(incoming.locked, false);
});

test('transfers: mixed network chunks preserve order across empty and split boundaries', async () => {
  const bytes = Buffer.alloc(3 * mebibyte + 31);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 239;
  const chunks = [
    bytes.subarray(0, 13),
    bytes.subarray(13, 2 * mebibyte + 19),
    new Uint8Array(0),
    bytes.subarray(2 * mebibyte + 19),
  ];
  const incoming = new ReadableStream(
    {
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const signal = new AbortController().signal;
  const owner = new TransferReader(incoming, signal, bytes.length, digest(bytes), 'download');
  const content = verifiedStream(owner, signal);
  let offset = 0;
  for await (const piece of content.stream) {
    assert.deepEqual(Buffer.from(piece), bytes.subarray(offset, offset + piece.byteLength));
    offset += piece.byteLength;
  }
  await content.completed;
  assert.equal(offset, bytes.length);
  assert.equal(owner.bytes, bytes.length);
  assert.equal(incoming.locked, false);
});

test('transfers: split network streams still reject short EOF and wrong digests', async (t) => {
  const expected = Buffer.alloc(2 * mebibyte + 17, 0x53);
  for (const [name, bytes] of [
    ['short EOF', expected.subarray(1)],
    ['wrong digest', Buffer.alloc(expected.length, 0x71)],
  ]) {
    await t.test(name, async () => {
      const signal = new AbortController().signal;
      const incoming = new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
      const owner = new TransferReader(incoming, signal, expected.length, digest(expected), 'download');
      const content = verifiedStream(owner, signal);
      const completed = assert.rejects(content.completed, { code: 'integrity_mismatch' });
      let received = 0;
      await assert.rejects(async () => {
        for await (const piece of content.stream) received += piece.length;
      }, { code: 'integrity_mismatch' });
      await completed;
      assert.equal(received, bytes.length, 'Bytes remain provisional until EOF');
      assert.equal(owner.bytes, bytes.length);
      assert.equal(incoming.locked, false);
    });
  }
});

test('transfers: cancellation and abort discard a pending network remainder without another pull', async (t) => {
  for (const mode of ['cancel', 'abort']) {
    await t.test(mode, async () => {
      const bytes = Buffer.alloc(2 * mebibyte + 17, 0x32);
      let pulls = 0,
        cancellations = 0;
      const abort = new AbortController();
      const incoming = new ReadableStream(
        {
          pull(controller) {
            pulls++;
            controller.enqueue(bytes);
          },
          cancel() {
            cancellations++;
          },
        },
        { highWaterMark: 0 },
      );
      const owner = new TransferReader(incoming, abort.signal, bytes.length, digest(bytes), 'download');
      const content = verifiedStream(owner, abort.signal);
      const completed = assert.rejects(content.completed, { code: 'cancelled' });
      const reader = content.stream.getReader();
      try {
        const first = await reader.read();
        assert.equal(first.done, false);
        assert.equal(first.value.length, mebibyte);
        if (mode === 'cancel') await reader.cancel();
        else {
          abort.abort(new SdkError('cancelled'));
          await assert.rejects(reader.read(), { code: 'cancelled' });
        }
        await completed;
        assert.equal(pulls, 1);
        assert.equal(cancellations, 1);
        assert.equal(owner.bytes, bytes.length);
        assert.equal(incoming.locked, false);
        await assert.rejects(owner.read(), { code: 'cancelled' });
      } finally {
        reader.releaseLock();
      }
    });
  }
});

test('transfers: stopped owners release pending network storage before cleanup settles', async (t) => {
  if (!globalThis.gc) {
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const result = await promisify(execFile)(process.execPath, [
      '--expose-gc',
      '--test',
      '--test-name-pattern=stopped owners release pending network storage',
      fileURLToPath(import.meta.url),
    ], { env: environment, maxBuffer: 1024 * 1024 });
    assert.match(result.stdout, /fail 0/);
    return;
  }
  for (const mode of ['stop', 'close', 'abort']) {
    await t.test(mode, async () => {
      const abort = new AbortController();
      let storage,
        release;
      const cleanup = new Promise((resolve) => { release = resolve; });
      const size = 2 * mebibyte + 17;
      const incoming = new ReadableStream(
        {
          pull(controller) {
            const chunk = new Uint8Array(size);
            storage = new WeakRef(chunk.buffer);
            controller.enqueue(chunk);
          },
          cancel() {
            return cleanup;
          },
        },
        { highWaterMark: 0 },
      );
      const owner = new TransferReader(incoming, abort.signal, size, digest(Buffer.alloc(size)), 'download');
      const first = await owner.read();
      await setImmediate();
      globalThis.gc();
      assert.ok(storage.deref(), 'The unread network remainder is still needed');
      let stopped;
      if (mode === 'close') stopped = owner.close();
      else {
        if (mode === 'abort') abort.abort(new SdkError('cancelled'));
        stopped = owner.stop();
      }
      try {
        let released = false;
        for (let attempt = 0; attempt < 10 && !released; attempt++) {
          await setImmediate();
          globalThis.gc();
          released = storage.deref() === undefined;
        }
        assert.equal(released, true, 'Cancellation releases the original network buffer');
        assert.equal(first.byteLength, mebibyte, 'Returned bytes remain alive independently');
        assert.equal(owner.bytes, size);
      } finally {
        release();
        await stopped;
        if (mode !== 'close') await owner.close();
      }
      assert.equal(incoming.locked, false);
    });
  }
});

test(
  'transfers: large real HTTPS streams stay within a bounded live buffer allowance',
  { timeout: 150_000 },
  async () => {
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const result = await promisify(execFile)(
      process.execPath,
      [
        '--expose-gc',
        '--max-old-space-size=128',
        '--test',
        fileURLToPath(new URL('./transfers-memory.mjs', import.meta.url)),
      ],
      { env: environment, maxBuffer: 1024 * 1024 },
    );
    assert.match(result.stdout, /pass 1/);
    console.log(result.stdout);
  },
);
