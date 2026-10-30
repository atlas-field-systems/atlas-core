import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixture, uuid } from './harness.mjs';
import { Session } from '../dist/connection.js';
import { Operations } from '../dist/prepared.js';
import { createTransfers } from '../dist/transfers.js';

test(
  '64 MiB upload and download retain less than 16 MiB of live array buffers',
  { timeout: 120_000 },
  async (t) => {
    assert.equal(typeof global.gc, 'function');
    const f = await fixture(t);
    const session = new Session({
      baseUrl: f.address,
      credentials: () => f.apiKey,
      timeoutMs: 120_000,
    });
    const operations = new Operations(session);
    t.after(async () => {
      await session.close();
      operations.close();
    });
    assert.equal((await session.discover()).response.kind, 'success');
    const transfers = createTransfers(session, operations);
    const chunk = Buffer.alloc(65536, 0x67),
      count = 1024;
    const expected = createHash('sha256');
    for (let i = 0; i < count; i++) expected.update(chunk);
    const facts = {
      object_id: uuid(),
      request_id: uuid(),
      byte_length: String(chunk.length * count),
      sha256: expected.digest('hex'),
      content_type: 'application/octet-stream',
      metadata: { associations: [] },
    };
    global.gc();
    const baseline = process.memoryUsage().arrayBuffers;
    let peak = baseline,
      pulls = 0;
    const measure = () => {
      global.gc();
      peak = Math.max(peak, process.memoryUsage().arrayBuffers);
      assert.ok(
        peak - baseline < 16 * 1024 * 1024,
        `live array buffers grew by ${peak - baseline}`,
      );
    };
    const operation = transfers.prepareUpload(facts, {
      open() {
        let remaining = count;
        return new ReadableStream(
          {
            pull(controller) {
              if (remaining-- > 0) {
                pulls++;
                controller.enqueue(chunk);
                if (pulls % 64 === 0) measure();
              } else controller.close();
            },
          },
          { highWaterMark: 0 },
        );
      },
    });
    const upload = await operation.send();
    assert.equal(upload.attempt.response?.kind, 'success', JSON.stringify(upload));
    assert.equal(upload.outcome.kind, 'accepted');
    assert.equal(pulls, count);
    assert.equal(upload.attempt.context.suppliedBytes, count * chunk.length);
    const job = transfers.getContent({ object_id: facts.object_id, disposition: 'attachment' });
    const opened = await job.open();
    assert.equal(opened.response?.kind, 'content');
    const received = createHash('sha256');
    let length = 0,
      chunks = 0;
    for await (const value of opened.response.stream) {
      received.update(value);
      length += value.length;
      if (++chunks % 64 === 0) measure();
    }
    assert.equal(received.digest('hex'), facts.sha256);
    assert.equal(length, count * chunk.length);
    assert.equal((await job.settled).response?.kind, 'content');
    measure();
    console.log(
      JSON.stringify({
        fileBytes: length,
        largestSourceChunk: chunk.length,
        liveArrayBufferGrowth: peak - baseline,
        gc: 'explicit every 64 chunks',
        transport: 'direct Core HTTPS; no buffering proxy',
      }),
    );
    await session.close();
  },
);
