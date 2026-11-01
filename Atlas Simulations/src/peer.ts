import type { ClientFrame, ServerFrame, Uuid } from '@atlas/protocol';
import { readWssServer, writeWssClient } from '@atlas/protocol';
import WebSocket from 'ws';
import { id } from './sdk.js';
export class Peer {
  private readonly socket: WebSocket;
  private readonly frames: (ServerFrame | { type: 'closed'; code: number })[] = [];
  private waiter: ((frame: ServerFrame | { type: 'closed'; code: number }) => void) | undefined;
  private closed = false;
  drainBatches = false;
  discardedBatches = 0;
  constructor(
    readonly baseUrl: string,
    readonly datasetId: Uuid,
    readonly secret: string,
  ) {
    this.socket = new WebSocket(baseUrl.replace('https:', 'wss:') + '/changes', {
      maxPayload: 4194304,
    });
    this.socket.once('open', () =>
      this.send({
        type: 'authenticate',
        request_id: id(),
        dataset_id: datasetId,
        protocol_version: '0.5.0',
        api_key: secret,
      }),
    );
    this.socket.on('message', (data) => {
      try {
        const length = Array.isArray(data)
          ? data.reduce((sum, b) => sum + b.length, 0)
          : data instanceof ArrayBuffer
            ? data.byteLength
            : data.length;
        if (length > 4194304) throw new Error('Peer frame limit');
        const bytes = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : data;
        const frame = readWssServer(bytes);
        if (this.drainBatches && (frame.type === 'change_batch' || frame.type === 'progress')) {
          this.discardedBatches++;
          return;
        }
        this.deliver(frame);
      } catch {
        this.socket.terminate();
      }
    });
    this.socket.once('error', () => this.socket.terminate());
    this.socket.once('close', (code) => {
      this.closed = true;
      this.deliver({ type: 'closed', code });
    });
  }
  private deliver(frame: ServerFrame | { type: 'closed'; code: number }) {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter(frame);
    } else {
      if (this.frames.length >= 16) {
        this.socket.terminate();
        return;
      }
      this.frames.push(frame);
    }
  }
  send(frame: ClientFrame): void {
    if (this.socket.bufferedAmount > 4194304) throw new Error('Peer output bound');
    this.socket.send(new TextDecoder().decode(writeWssClient(frame)));
  }
  next(timeoutMs = 5000): Promise<ServerFrame | { type: 'closed'; code: number }> {
    const frame = this.frames.shift();
    if (frame) return Promise.resolve(frame);
    if (this.closed) return Promise.resolve({ type: 'closed', code: 1006 });
    if (this.waiter) throw new Error('Concurrent peer consumer');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        reject(new Error('Peer deadline'));
      }, timeoutMs);
      this.waiter = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
    });
  }
  pause(): void {
    this.socket.pause();
  }
  resume(): void {
    this.socket.resume();
  }
  async close(): Promise<void> {
    if (this.closed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => this.socket.terminate(), 1000);
      this.socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.close();
    });
  }
}
