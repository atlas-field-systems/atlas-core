import type WebSocket from 'ws';
import type { RawData } from 'ws';
import { z } from 'zod';
import { PROTOCOL_VERSION, ReplayMessage, Secret, Subscribed, Uuid, readJson, wss, writeWssServer } from '@atlas/protocol';
import type { ClientFrame, NewId, ServerFrame, SubscribeChanges } from '@atlas/protocol';
import { canonical, digest } from './exact.js';
import { publicError, Refusal, refuse } from './fault.js';
import type { DatabaseWorker } from './rpc.js';
import type { Context } from './engine.js';
import type { Settings } from './settings.js';
import type { Diagnostics } from './diagnostics.js';

type Subscription = { request: SubscribeChanges; handoff: string; cursor: string; complete: boolean; ended: boolean };
export class ChangesConnection {
  private context: Context | undefined;
  private subscription: Subscription | undefined;
  private readonly queue: { bytes: Uint8Array; data: boolean; authorize: boolean; resolve: () => void; reject: () => void }[] = [];
  private dataBytes = 0;
  private controlBytes = 0;
  private sending = false;
  private incoming = 0;
  private incomingBytes = 0;
  private received: Promise<void> = Promise.resolve();
  private polling = false;
  private closed = false;
  private readonly authenticateTimer: NodeJS.Timeout;
  private readonly timer: NodeJS.Timeout;
  constructor(private readonly socket: WebSocket, private readonly rpc: DatabaseWorker, private readonly dataset: Uuid,
    private readonly run: Uuid, private readonly settings: Settings, private readonly diagnostics: Diagnostics, private readonly onClose: () => void) {
    this.authenticateTimer = setTimeout(() => { void this.error(new Refusal('unauthorized')).finally(() => this.close(1008)); }, 10_000);
    this.timer = setInterval(() => { void this.poll(); }, 250);
    socket.on('message', (raw, binary) => this.receive(raw, binary));
    socket.once('close', () => this.finish());
    socket.on('error', () => this.close(1011));
  }
  private receive(raw: RawData, binary: boolean): void {
    const length = Array.isArray(raw) ? raw.reduce((sum, part) => sum + part.byteLength, 0) : raw.byteLength;
    if (binary || length > this.settings.limits.max_control_bytes || this.incoming >= 8 || this.incomingBytes + length > 131_072) { this.close(1009); return; }
    this.incoming++; this.incomingBytes += length;
    const bytes = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw, length) : Buffer.from(raw);
    this.received = this.received.then(async () => {
      let frame: ClientFrame | undefined;
      try { frame = readJson(wss.clientFrame, bytes); await this.control(frame); }
      catch (error) { await this.error(error, frame && 'request_id' in frame ? frame.request_id : undefined); if (!this.context || error instanceof Refusal && error.code === 'unauthorized') this.close(1008); }
      finally { this.incoming--; this.incomingBytes -= length; }
    }).catch(() => this.close(1011));
  }
  private async control(frame: ClientFrame): Promise<void> {
    if (frame.protocol_version !== PROTOCOL_VERSION) refuse('protocol_mismatch');
    if (frame.dataset_id !== this.dataset) refuse('dataset_mismatch');
    if (frame.type === 'authenticate') {
      if (this.context !== undefined) refuse('invalid_request');
      const context: Context = { verifier: digest(Secret.parse(frame.api_key)), dataset: frame.dataset_id, protocol: frame.protocol_version };
      await this.rpc.call('authorize', { context, discovery: false }, 512, true);
      if (this.closed) return;
      this.context = context; clearTimeout(this.authenticateTimer);
      await this.send({ type: 'authenticated', dataset_id: this.dataset, protocol_version: PROTOCOL_VERSION, request_id: frame.request_id,
        data: { core_run_id: this.run, limits: { max_message_bytes: this.settings.limits.max_message_bytes, max_changes: this.settings.limits.max_changes, max_json_values: this.settings.limits.max_json_values } } });
      return;
    }
    const context = this.context;
    if (context === undefined) refuse('unauthorized');
    await this.rpc.call('authorize', { context, discovery: false }, 512, true);
    switch (frame.type) {
      case 'read_snapshot': {
        const result = await this.rpc.exchange('ReadSnapshot', frame.data, context, bytesOf(frame));
        if (result.kind === 'error') throw new Refusal(result.body.error.code, result.body.error.details);
        await this.send({ type: 'read_snapshot_result', dataset_id: this.dataset, protocol_version: PROTOCOL_VERSION, request_id: frame.request_id, data: result.body.data }); break;
      }
      case 'read_changes': {
        const result = await this.rpc.exchange('ReadChanges', frame.data, context, bytesOf(frame));
        if (result.kind === 'error') throw new Refusal(result.body.error.code, result.body.error.details);
        await this.send({ type: 'read_changes_result', dataset_id: this.dataset, protocol_version: PROTOCOL_VERSION, request_id: frame.request_id, data: result.body.data }); break;
      }
      case 'release_snapshot': {
        const result = await this.rpc.exchange('ReleaseSnapshot', frame.data, context, bytesOf(frame));
        if (result.kind === 'error') throw new Refusal(result.body.error.code, result.body.error.details);
        await this.send({ type: 'snapshot_released', dataset_id: this.dataset, protocol_version: PROTOCOL_VERSION, request_id: frame.request_id, data: result.body.data }); break;
      }
      case 'subscribe_changes': {
        if (this.subscription !== undefined) {
          if (this.subscription.ended || canonical(this.subscription.request) !== canonical(frame.data)) refuse('identity_conflict');
        } else {
          const data = Subscribed.parse(await this.rpc.call('subscribe', { context, request: frame.data }, 4096));
          this.subscription = { request: frame.data, handoff: data.handoff_cursor, cursor: frame.data.from_cursor, complete: false, ended: false };
        }
        await this.send({ type: 'subscribed', dataset_id: this.dataset, protocol_version: PROTOCOL_VERSION, request_id: frame.request_id,
          data: { subscription_id: this.subscription.request.subscription_id, handoff_cursor: this.subscription.handoff,
            limits: { max_message_bytes: this.settings.limits.max_message_bytes, max_json_values: this.settings.limits.max_json_values, max_changes: this.settings.limits.max_changes } } });
        void this.poll(); break;
      }
      case 'unsubscribe_changes': {
        if (this.subscription === undefined || this.subscription.request.subscription_id !== frame.data.subscription_id) refuse('identity_conflict');
        this.subscription.ended = true;
        await this.send({ type: 'unsubscribed', dataset_id: this.dataset, protocol_version: PROTOCOL_VERSION, request_id: frame.request_id, data: frame.data }); break;
      }
      default: { const exhaustive: never = frame; return exhaustive; }
    }
  }
  private async poll(): Promise<void> {
    if (this.polling || this.closed || this.context === undefined) return;
    this.polling = true;
    try {
      await this.rpc.call('authorize', { context: this.context, discovery: false }, 512, true);
      const subscription = this.subscription;
      if (!subscription || subscription.ended) return;
      const result = z.object({ through: z.string(), messages: z.array(ReplayMessage).max(1000), earliest: z.string() }).parse(
        await this.rpc.call('feed', { context: this.context, from: subscription.cursor, boundary: subscription.complete ? null : subscription.handoff }, this.settings.limits.max_message_bytes + 1024));
      for (const message of result.messages) {
        if (subscription.ended || this.closed) return;
        await this.rpc.call('authorize', { context: this.context, discovery: false }, 512, true);
        const frame: ServerFrame = message.type === 'change_batch'
          ? { type: 'change_batch', dataset_id: this.dataset, protocol_version: PROTOCOL_VERSION, data: { ...message.data, subscription_id: subscription.request.subscription_id } }
          : { type: 'progress', dataset_id: this.dataset, protocol_version: PROTOCOL_VERSION, data: { ...message.data, subscription_id: subscription.request.subscription_id } };
        await this.send(frame);
        subscription.cursor = message.type === 'change_batch' ? message.data.commit_cursor : message.data.through_cursor;
      }
      if (!subscription.complete && subscription.cursor === subscription.handoff) {
        await this.send({ type: 'handoff_complete', dataset_id: this.dataset, protocol_version: PROTOCOL_VERSION,
          data: { subscription_id: subscription.request.subscription_id, handoff_cursor: subscription.handoff } });
        subscription.complete = true;
        this.diagnostics.emit({ severity: 'INFO', component: 'synchronization', event: 'handoff_complete', cursor: subscription.handoff });
      }
    } catch (error) {
      if (error instanceof Refusal && error.code !== 'unauthorized' && this.subscription && !this.subscription.ended) {
        this.subscription.ended = true;
        const fault = publicError(error, this.dataset).body.error;
        const earliest = fault.code === 'cursor_expired' ? fault.details.earliest_recoverable_cursor : this.subscription.cursor;
        this.diagnostics.emit({ severity: 'WARN', component: 'synchronization', event: 'feed_gap', code: error.code, cursor: earliest });
        await this.send({ type: 'gap', dataset_id: this.dataset, protocol_version: PROTOCOL_VERSION,
          data: { subscription_id: this.subscription.request.subscription_id, reason: error.code === 'cursor_expired' ? 'cursor_expired' : 'resource_limit', earliest_recoverable_cursor: earliest } }).catch(() => this.close(1013));
      } else { await this.error(error).catch(() => {}); this.close(error instanceof Refusal && error.code === 'unauthorized' ? 1008 : 1011); }
    } finally { this.polling = false; }
  }
  private error(error: unknown, requestId?: NewId): Promise<void> {
    return this.send({ type: 'error', dataset_id: this.dataset, protocol_version: PROTOCOL_VERSION,
      ...(requestId === undefined ? {} : { request_id: requestId }), error: publicError(error, this.dataset).body.error });
  }
  private send(frame: ServerFrame): Promise<void> {
    if (this.closed) return Promise.reject(new Error('socket_closed'));
    const bytes = writeWssServer(frame);
    const data = frame.type === 'change_batch' || frame.type === 'progress' || frame.type === 'read_snapshot_result' || frame.type === 'read_changes_result';
    if (data ? this.dataBytes + bytes.byteLength + this.socket.bufferedAmount > 4_194_304 : this.controlBytes + bytes.byteLength > 65_536) return Promise.reject(new Refusal('resource_limit'));
    if (data) this.dataBytes += bytes.byteLength; else this.controlBytes += bytes.byteLength;
    return new Promise((resolve, reject) => {
      this.queue.push({ bytes, data, authorize: frame.type !== 'error', resolve, reject: () => reject(new Error('socket_write_failed')) });
      this.flush();
    });
  }
  private flush(): void {
    if (this.sending || this.closed) return;
    const next = this.queue.shift(); if (!next) return;
    this.sending = true;
    const timeout = setTimeout(() => this.close(1013), 5000);
    const written = (error?: Error) => {
      clearTimeout(timeout); this.sending = false;
      if (next.data) this.dataBytes -= next.bytes.byteLength; else this.controlBytes -= next.bytes.byteLength;
      if (error) { next.reject(); this.close(error instanceof Refusal && error.code === 'unauthorized' ? 1008 : 1011); } else { next.resolve(); this.flush(); }
    };
    void (async () => {
      if (next.authorize && this.context !== undefined) await this.rpc.call('authorize', { context: this.context, discovery: false }, 512, true);
      if (this.closed) throw new Error('socket_closed');
      this.socket.send(next.bytes, { binary: false }, written);
    })().catch(error => { written(error instanceof Error ? error : new Error('socket_write_failed')); });
  }
  close(code = 1001): void {
    if (this.closed) return;
    this.diagnostics.emit({ severity: code === 1013 ? 'WARN' : 'INFO', component: 'synchronization', event: code === 1013 ? 'slow_client_closed' : 'connection_closed', count: code });
    this.socket.close(code); const timer = setTimeout(() => this.socket.terminate(), 1000); timer.unref(); this.finish();
  }
  private finish(): void { if (this.closed) return; this.closed = true; clearTimeout(this.timer); clearTimeout(this.authenticateTimer); for (const item of this.queue) item.reject(); this.queue.length = 0; this.onClose(); }
}
function bytesOf(frame: ClientFrame): number { return Buffer.byteLength(JSON.stringify(frame)); }
