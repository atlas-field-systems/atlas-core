import { Measurements } from './measurements.js';
import { Position } from '@atlas/protocol';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
export const TruthEntry = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('world'),
    reading_id: z.string(),
    alias: z.string(),
    observed_at: z.string(),
    position: Position,
  }),
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
    source: z.enum(['runtime', 'fault']),
    identity: z.string(),
    operation: z.string(),
    facts: z.json(),
  }),
  z.strictObject({ kind: z.literal('attempt'), identity: z.string(), result: z.json() }),
  z.strictObject({ kind: z.literal('outcome'), identity: z.string(), outcome: z.json() }),
]);
export type TruthEntry = z.infer<typeof TruthEntry>;
export class Truth {
  readonly measurements = new Measurements();
  readonly commits = new Map<string, number>();
  private readonly pictureObserved = new Map<string, number>();
  pictureCommit(cursor: string): void {
    const committed = this.commits.get(cursor);
    if (committed !== undefined) {
      if (this.measurements.pictureLag.length >= 100000)
        throw new Error('Picture lag sample budget');
      this.measurements.pictureLag.push(performance.now() - committed);
      this.commits.delete(cursor);
    } else {
      if (this.pictureObserved.size >= 100000) throw new Error('Picture observation budget');
      this.pictureObserved.set(cursor, performance.now());
    }
  }
  private readonly accepted = new Set<string>();
  private queue = Promise.resolve();
  private queued = 0;
  private queuedBytes = 0;
  private writers = 0;
  reserveWriter(): () => void {
    if (this.writers >= 64) throw new Error('Aggregate writer budget');
    this.writers++;
    return () => {
      this.writers--;
    };
  }
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
    if (entry.kind === 'attempt') {
      this.measurements.attempt(entry.result);
      const commit = z
        .object({
          kind: z.literal('response'),
          response: z.object({
            kind: z.literal('success'),
            body: z.object({ commit_cursor: z.string() }),
          }),
        })
        .safeParse(entry.result);
      if (commit.success) {
        if (this.commits.size >= 100000) throw new Error('Commit measurement capacity');
        const cursor = commit.data.response.body.commit_cursor;
        if (this.pictureObserved.has(cursor)) {
          if (this.measurements.pictureLag.length >= 100000)
            throw new Error('Picture lag sample budget');
          this.measurements.pictureLag.push(0);
          this.pictureObserved.delete(cursor);
        } else this.commits.set(cursor, performance.now());
      }
    }
    if (
      entry.kind === 'outcome' &&
      z.object({ kind: z.string() }).parse(entry.outcome).kind === 'accepted' &&
      !this.accepted.has(entry.identity)
    ) {
      if (this.accepted.size >= 100000) throw new Error('Accepted identity budget');
      this.accepted.add(entry.identity);
      if (
        ['UpdateAsset', 'ReportTaskExecution', 'ReportObservation', 'ConfirmTaskOrder'].some(
          (operation) => entry.identity.startsWith(operation + '/'),
        )
      )
        this.measurements.acceptedReports++;
    }
    if (this.closed) throw new Error('Truth writer closed');
    if (this.failure) throw this.failure;
    if (this.queued >= 256) throw new Error('Truth queue exhausted');
    const line = JSON.stringify(TruthEntry.parse(entry)) + '\n';
    if (Buffer.byteLength(line) > 1048576 || this.bytes + Buffer.byteLength(line) > 134217728)
      throw new Error('Truth byte budget exhausted');
    const queuedBytes = Buffer.byteLength(line);
    if (queuedBytes + this.queuedBytes > 4194304)
      throw new Error('Truth aggregate queue byte budget');
    this.queuedBytes += queuedBytes;
    this.bytes += queuedBytes;
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
        this.queuedBytes -= queuedBytes;
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
