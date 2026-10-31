import { open, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { Position } from '@atlas/protocol';
export const TruthEntry = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('physical'),
    at: z.number(),
    asset: z.string(),
    event: z.enum(['start', 'arrive', 'pause', 'resume', 'cancel']),
    task: z.string(),
    position: Position,
  }),
  z.strictObject({
    kind: z.literal('submitted'),
    identity: z.string(),
    operation: z.string(),
    facts: z.json(),
  }),
  z.strictObject({ kind: z.literal('attempt'), identity: z.string(), result: z.json() }),
  z.strictObject({ kind: z.literal('outcome'), identity: z.string(), outcome: z.json() }),
]);
export type TruthEntry = z.infer<typeof TruthEntry>;
export class Truth {
  private queue = Promise.resolve();
  private queued = 0;
  private bytes = 0;
  private failure: unknown;
  private closed = false;
  private constructor(
    private readonly file: Awaited<ReturnType<typeof open>>,
    readonly path: string,
  ) {}
  static async create(directory: string): Promise<Truth> {
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'truth.jsonl');
    return new Truth(await open(path, 'wx', 0o600), path);
  }
  append(entry: TruthEntry): void {
    if (this.closed) throw new Error('Truth writer closed');
    if (this.failure) throw this.failure;
    if (this.queued >= 256) throw new Error('Truth queue exhausted');
    const line = JSON.stringify(TruthEntry.parse(entry)) + '\n';
    if (Buffer.byteLength(line) > 1048576 || this.bytes + Buffer.byteLength(line) > 134217728)
      throw new Error('Truth byte budget exhausted');
    this.bytes += Buffer.byteLength(line);
    this.queued++;
    this.queue = this.queue
      .then(async () => {
        await this.file.writeFile(line);
      })
      .catch((e: unknown) => {
        this.failure ??= e;
      })
      .finally(() => {
        this.queued--;
      });
  }
  async boundary(): Promise<void> {
    await this.queue;
    if (this.failure) throw this.failure;
    await this.file.sync();
  }
  async close(): Promise<void> {
    this.closed = true;
    try {
      await this.boundary();
    } finally {
      await this.file.close();
    }
  }
}
