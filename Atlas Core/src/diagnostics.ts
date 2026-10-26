import { open, mkdir, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Uuid, exchanges } from '@atlas/protocol';

const Frames = z.array(z.object({ file: z.string().regex(/^[a-z-]+\.js$/), function: z.string().regex(/^[\w.$<> ]{1,80}$/), line: z.number().int().positive() })).max(8);
const Event = z.strictObject({ at: z.string(), severity: z.enum(['INFO', 'WARN', 'ERROR', 'DEBUG']), event: z.string().regex(/^[a-z_]{1,64}$/),
  component: z.enum(['http', 'database', 'objects', 'synchronization', 'lifecycle', 'runtime']), release: z.literal('0.1.0'),
  dataset: Uuid.optional(), run: Uuid.optional(), request_id: Uuid.optional(), attempt_id: Uuid.optional(),
  route: z.enum(Object.values(exchanges).map(e => e.path)).optional(), code: z.string().regex(/^[a-z_]{1,64}$/).optional(),
  bytes: z.number().nonnegative().optional(), count: z.number().int().nonnegative().optional(), duration_ms: z.number().nonnegative().optional(),
  frames: Frames.optional(), evidence: z.literal('unavailable').optional() });
export type Diagnostic = Omit<z.infer<typeof Event>, 'at' | 'release'>;
export function faultFrames(error: unknown): Pick<Diagnostic, 'frames' | 'evidence'> {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return { evidence: 'unavailable' };
  const root = fileURLToPath(new URL('.', import.meta.url));
  const frames: z.infer<typeof Frames> = [];
  for (const line of error.stack.split('\n').slice(1, 17)) {
    const match = /^\s*at ([\w.$<> ]+) \((?:file:\/\/)?([^()]+):(\d+):\d+\)$/.exec(line);
    const path = match?.[2], name = match?.[1], number = match?.[3];
    if (!path || !name || !number || !path.startsWith(root)) continue;
    const frame = Frames.element.safeParse({ file: basename(path), function: name, line: Number(number) });
    if (frame.success) frames.push(frame.data);
    if (frames.length >= 8) break;
  }
  return frames.length === 0 ? { evidence: 'unavailable' } : { frames };
}
export class Diagnostics {
  private readonly queue: Buffer[] = [];
  private queued = 0;
  private file: FileHandle | undefined;
  private writing: Promise<void> | undefined;
  private size = 0;
  private closed = false;
  private debugWindow = 0;
  private debugCount = 0;
  dropped = 0;
  suppressed = 0;
  failed = 0;
  constructor(private readonly directory: string, private readonly capacity: number, private readonly level: Diagnostic['severity']) {}
  emit(input: Diagnostic): void {
    if (this.closed) return;
    const levels = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
    if (levels[input.severity] < levels[this.level]) return;
    if (input.severity === 'DEBUG') {
      const window = Math.floor(performance.now() / 1000);
      if (window !== this.debugWindow) { this.debugWindow = window; this.debugCount = 0; }
      if (++this.debugCount > 100) { this.suppressed++; return; }
    }
    if (this.queued >= 1_048_576 - 8192) { this.dropped++; return; }
    const event = Event.safeParse({ ...input, at: new Date().toISOString(), release: '0.1.0' });
    if (!event.success) { this.dropped++; return; }
    const line = Buffer.from(JSON.stringify(event.data) + '\n');
    if (line.byteLength > 8192 || this.capacity < line.byteLength * 2) { this.dropped++; return; }
    this.queue.push(line); this.queued += line.byteLength;
    this.start();
  }
  private start(): void {
    if (this.writing) return;
    this.writing = this.drain().catch(() => { this.failed++; this.dropped += this.queue.length; this.queue.length = 0; this.queued = 0; })
      .finally(() => { this.writing = undefined; if (this.queue.length > 0) this.start(); });
  }
  private async drain(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const maximum = Math.max(1, Math.floor(this.capacity / 8));
    while (this.queue.length > 0) {
      const line = this.queue.shift();
      if (!line) break;
      this.queued -= line.byteLength;
      if (this.file === undefined) { this.file = await open(join(this.directory, 'events.0.jsonl'), 'a', 0o600); this.size = (await this.file.stat()).size; }
      if (this.size + line.byteLength > maximum) {
        await this.file.close(); this.file = undefined;
        await rm(join(this.directory, 'events.7.jsonl'), { force: true });
        for (let i = 6; i >= 0; i--) {
          try { await rename(join(this.directory, `events.${i}.jsonl`), join(this.directory, `events.${i + 1}.jsonl`)); }
          catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; }
        }
        this.file = await open(join(this.directory, 'events.0.jsonl'), 'a', 0o600); this.size = 0;
      }
      await this.file.write(line); this.size += line.byteLength;
    }
  }
  async close(): Promise<void> { this.closed = true; await this.writing; if (this.file) { await this.file.sync(); await this.file.close(); this.file = undefined; } }
  inspect() { return { queuedBytes: this.queued, dropped: this.dropped, suppressed: this.suppressed, sinkFailures: this.failed }; }
}
