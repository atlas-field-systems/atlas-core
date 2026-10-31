import { open, mkdir, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { Opaque, Timestamp, Uuid, exchanges } from '@atlas/protocol';
import { QueuePressure } from './rpc.js';

const Frames = z
  .array(
    z.object({
      file: z.string().regex(/^[a-z-]+\.js$/),
      function: z.string().regex(/^[\w.$<> ]{1,80}$/),
      line: z.number().int().positive(),
    }),
  )
  .max(8);
const Event = z.strictObject({
  at: Timestamp,
  severity: z.enum(['INFO', 'WARN', 'ERROR', 'DEBUG']),
  event: z.string().regex(/^[a-z_]{1,64}$/),
  component: z.enum(['http', 'database', 'objects', 'synchronization', 'lifecycle', 'runtime']),
  release: z.literal('0.3.0'),
  dataset: Uuid.optional(),
  run: Uuid.optional(),
  request_id: Uuid.optional(),
  attempt_id: Uuid.optional(),
  route: z.enum(Object.values(exchanges).map((e) => e.path)).optional(),
  code: z
    .string()
    .regex(/^[a-z_]{1,64}$/)
    .optional(),
  bytes: z.number().nonnegative().optional(),
  count: z.number().int().nonnegative().optional(),
  duration_ms: z.number().nonnegative().optional(),
  cursor: Opaque.refine((value) => value.length <= 128).optional(),
  outcome: z
    .enum(['first', 'replay', 'read', 'accepted', 'duplicate', 'rejected', 'written', 'failed'])
    .optional(),
  transaction_ms: z.number().nonnegative().optional(),
  writer_wait_ms: z.number().nonnegative().optional(),
  frames: Frames.optional(),
  evidence: z.literal('unavailable').optional(),
});
export type Diagnostic = Omit<z.infer<typeof Event>, 'at' | 'release'>;
export function faultFrames(error: unknown): Pick<Diagnostic, 'frames' | 'evidence'> {
  if (!(error instanceof Error) || typeof error.stack !== 'string')
    return { evidence: 'unavailable' };
  const root = fileURLToPath(new URL('.', import.meta.url));
  const frames: z.infer<typeof Frames> = [];
  for (const line of error.stack.split('\n').slice(1, 17)) {
    const match = /^\s*at ([\w.$<> ]+) \((?:file:\/\/)?([^()]+):(\d+):\d+\)$/.exec(line);
    const path = match?.[2],
      name = match?.[1],
      number = match?.[3];
    if (!path || !name || !number) continue;
    let decoded: string;
    try {
      decoded = fileURLToPath(`file://${path}`);
    } catch {
      continue;
    }
    if (!decoded.startsWith(root)) continue;
    const frame = Frames.element.safeParse({
      file: basename(decoded),
      function: name,
      line: Number(number),
    });
    if (frame.success) frames.push(frame.data);
    if (frames.length >= 8) break;
  }
  return frames.length === 0 ? { evidence: 'unavailable' } : { frames };
}
export function retainedEvent(value: unknown): string | undefined {
  const parsed = Event.safeParse(value);
  return parsed.success ? JSON.stringify(parsed.data) + '\n' : undefined;
}
export class Diagnostics {
  private readonly queue: Buffer[] = [];
  private queued = 0;
  private file: FileHandle | undefined;
  private writing: Promise<void> | undefined;
  private release: (() => Promise<void>) | undefined;
  private size = 0;
  private closed = false;
  private debugWindow = 0;
  private debugCount = 0;
  dropped = 0;
  suppressed = 0;
  failed = 0;
  constructor(
    private readonly directory: string,
    private readonly capacity: number,
    private readonly level: Diagnostic['severity'],
    private readonly reserve: (bytes: number) => Promise<() => Promise<void>>,
  ) {}
  emit(input: Diagnostic): void {
    if (this.closed) return;
    const levels = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
    if (levels[input.severity] < levels[this.level]) return;
    if (input.severity === 'DEBUG') {
      const window = Math.floor(performance.now() / 1000);
      if (window !== this.debugWindow) {
        this.debugWindow = window;
        this.debugCount = 0;
      }
      if (++this.debugCount > 100) {
        this.suppressed++;
        return;
      }
    }
    if (this.queued >= 1_048_576 - 8192) {
      this.dropped++;
      return;
    }
    const event = Event.safeParse({ ...input, at: new Date().toISOString(), release: '0.3.0' });
    if (!event.success) {
      this.dropped++;
      return;
    }
    const line = Buffer.from(JSON.stringify(event.data) + '\n');
    if (line.byteLength > 8192 || this.capacity < line.byteLength * 2) {
      this.dropped++;
      return;
    }
    this.queue.push(line);
    this.queued += line.byteLength;
    this.start();
  }
  private start(): void {
    if (this.writing) return;
    this.writing = this.drain()
      .catch(() => {
        this.failed++;
        this.dropped += this.queue.length;
        this.queue.length = 0;
        this.queued = 0;
      })
      .finally(() => {
        this.writing = undefined;
        if (this.queue.length > 0) this.start();
      });
  }
  private async drain(): Promise<void> {
    await this.releaseReservation();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const maximum = Math.max(1, Math.floor(this.capacity / 16));
    while (this.queue.length > 0) {
      const line = this.queue.shift();
      if (!line) break;
      this.queued -= line.byteLength;
      if (this.file === undefined) {
        this.file = await open(join(this.directory, 'events.0.jsonl'), 'a', 0o600);
        this.size = (await this.file.stat()).size;
      }
      if (this.size + line.byteLength > maximum) {
        await this.file.close();
        this.file = undefined;
        await rm(join(this.directory, 'events.7.jsonl'), { force: true });
        for (let i = 6; i >= 0; i--) {
          try {
            await rename(
              join(this.directory, `events.${i}.jsonl`),
              join(this.directory, `events.${i + 1}.jsonl`),
            );
          } catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT')
              throw error;
          }
        }
        this.file = await open(join(this.directory, 'events.0.jsonl'), 'a', 0o600);
        this.size = 0;
      }
      try {
        this.release = await this.reserve(line.byteLength);
      } catch {
        this.dropped++;
        continue;
      }
      try {
        let offset = 0;
        while (offset < line.byteLength) {
          const { bytesWritten } = await this.file.write(line, offset);
          if (bytesWritten === 0) throw new Error('diagnostic_write_incomplete');
          offset += bytesWritten;
          this.size += bytesWritten;
        }
      } catch (error) {
        try {
          await this.releaseReservation();
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'diagnostic_write_cleanup_failed');
        }
        throw error;
      }
      await this.releaseReservation();
    }
  }
  private async releaseReservation(): Promise<void> {
    for (let attempt = 0; this.release !== undefined; attempt++) {
      try {
        await this.release();
        this.release = undefined;
      } catch (error) {
        if (!(error instanceof QueuePressure) || attempt >= 3) throw error;
        await delay(25 * 2 ** attempt);
      }
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.writing;
    const failures: unknown[] = [];
    try {
      await this.releaseReservation();
    } catch (error) {
      failures.push(error);
    }
    if (this.file) {
      try {
        await this.file.sync();
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.file.close();
        this.file = undefined;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'diagnostic_cleanup_failed');
  }
  inspect() {
    return {
      queuedBytes: this.queued,
      dropped: this.dropped,
      suppressed: this.suppressed,
      sinkFailures: this.failed,
    };
  }
}
