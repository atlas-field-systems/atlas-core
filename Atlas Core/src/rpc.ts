import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { Uuid, exchanges } from '@atlas/protocol';
import type { ExchangeName, RequestOf, ResponseOf } from '@atlas/protocol';
import { Refusal, WorkerFailure } from './fault.js';
import type { Settings } from './settings.js';
import type { Context } from './engine.js';
import { requiredEffect } from './capacity.js';

const Ready = z.strictObject({ type: z.literal('ready'), dataset: Uuid, run: Uuid, engine: z.unknown() });
const Reply = z.strictObject({ type: z.literal('reply'), id: z.number().int(), value: z.unknown() });
const Failed = WorkerFailure.extend({ type: z.literal('refusal'), id: z.number().int() });
function isResponse<K extends ExchangeName>(name: K, value: unknown): value is ResponseOf<K> {
  return exchanges[name].response.schema.safeParse(value).success;
}
type Pending = { bytes: number; resolve: (value: unknown) => void; reject: (error: unknown) => void };
export class QueuePressure extends Refusal { constructor() { super('resource_limit'); } }
export class DatabaseWorker {
  readonly worker: Worker;
  readonly ready: Promise<z.infer<typeof Ready>>;
  private readonly pending = new Map<number, Pending>();
  private queuedBytes = 0;
  private serial = 0;
  private failed = false;
  private closing = false;
  private readonly exited: Promise<number>;
  constructor(directory: string, private readonly settings: Settings, establish?: { dataset: Uuid; actionId: Uuid }, accountingRoot = directory, private readonly onFailure: () => void = () => {}) {
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { directory, settings, establish, accountingRoot },
      resourceLimits: { maxOldGenerationSizeMb: 1024 }, stdout: true, stderr: true });
    this.worker.stdout.resume(); this.worker.stderr.resume();
    this.exited = new Promise(resolve => this.worker.once('exit', code => { this.fail(); resolve(code); }));
    this.ready = new Promise((resolve, reject) => {
      this.worker.once('error', () => { this.fail(); reject(new Error('database_worker_failed')); });
      this.worker.once('exit', () => reject(new Error('database_worker_failed')));
      this.worker.on('message', (message: unknown) => {
        const ready = Ready.safeParse(message);
        if (ready.success) { resolve(ready.data); return; }
        const reply = Reply.safeParse(message);
        const failure = Failed.safeParse(message);
        if (!reply.success && !failure.success) { this.fail(); return; }
        const messageId = reply.success ? reply.data.id : failure.success ? failure.data.id : -1;
        const pending = this.pending.get(messageId);
        if (!pending) { this.fail(); return; }
        this.pending.delete(messageId); this.queuedBytes -= pending.bytes;
        this.worker.postMessage({ type: 'received', id: messageId });
        if (reply.success) pending.resolve(reply.data.value);
        else if (failure.success) {
          const { error, causes } = failure.data;
          pending.reject(causes === undefined ? new Refusal(error.body.error.code, error.body.error.details)
            : new AggregateError(causes.map(cause => new Refusal(cause.body.error.code, cause.body.error.details)), 'worker_cleanup_failed'));
        }
      });
    });
  }
  get available(): boolean { return !this.failed && !this.closing; }
  get usage() { return { operations: this.pending.size, bytes: this.queuedBytes }; }
  private fail(): void {
    const notify = !this.failed && !this.closing;
    this.failed = true;
    if (notify) this.onFailure();
    for (const pending of this.pending.values()) pending.reject(new Error('database_worker_failed'));
    this.pending.clear(); this.queuedBytes = 0;
  }
  async call(kind: string, data: unknown, bytes: number, reserved = false): Promise<unknown> {
    await this.ready;
    if (this.failed || this.closing && kind !== 'close') throw new Error('database_worker_failed');
    const maxCount = this.settings.workerQueueCount - (reserved ? 0 : Math.min(4, Math.max(1, Math.floor(this.settings.workerQueueCount / 4))));
    const maxBytes = this.settings.workerQueueBytes - (reserved ? 0 : Math.min(1_048_576, Math.floor(this.settings.workerQueueBytes / 4)));
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.pending.size >= maxCount || this.queuedBytes + bytes > maxBytes) throw new QueuePressure();
    bytes = Math.max(bytes, Buffer.byteLength(JSON.stringify(data)) * 8 + 1024);
    if (this.queuedBytes + bytes > maxBytes) throw new QueuePressure();
    const serial = ++this.serial;
    return new Promise((resolve, reject) => {
      this.pending.set(serial, { bytes, resolve, reject }); this.queuedBytes += bytes;
      try { this.worker.postMessage({ id: serial, kind, data, reserved, enqueuedAtNs: process.hrtime.bigint() }); }
      catch (error) { this.pending.delete(serial); this.queuedBytes -= bytes; reject(error); }
    });
  }
  async exchange<K extends ExchangeName>(name: K, request: RequestOf<K>, context: Context, bytes: number): Promise<ResponseOf<K>> {
    return (await this.exchangeDetailed(name, request, context, bytes)).response;
  }
  async exchangeDetailed<K extends ExchangeName>(name: K, request: RequestOf<K>, context: Context, bytes: number): Promise<{ response: ResponseOf<K>; execution: 'first' | 'replay' | 'read' }> {
    const value = await this.call('exchange', { operation: { name, request }, context }, bytes,
      requiredEffect(name, request) || name === 'GetReadiness' || name === 'GetHealth' || name === 'ListResources');
    const result = z.object({ response: z.unknown(), execution: z.enum(['first', 'replay', 'read']) }).parse(value);
    if (!isResponse(name, result.response)) throw new Error('invalid_worker_response');
    return { response: result.response, execution: result.execution };
  }
  async close(): Promise<void> {
    if (this.failed) { await this.worker.terminate(); await this.exited; return; }
    this.closing = true;
    await this.call('close', {}, 0, true);
    const code = await this.exited;
    if (code !== 0) throw new Error('database_worker_exit_failed');
  }
}
