import {
  NewId,
  Opaque,
  PROTOCOL_VERSION,
  Uuid,
  effectiveBudget,
  readWssServer,
  writeWssClient,
} from '@atlas/protocol';
import type { Budget, NegotiatedLimits, ServerFrame } from '@atlas/protocol';
import type { Session, SocketLease } from './connection.js';
import { SdkError } from './contracts.js';
import { failureCode } from './http.js';
import type { DiagnosticCode } from './diagnostics.js';
import type { PictureMemory } from './picture-data.js';

export type SocketEnd = Readonly<{
  kind: 'transport' | 'rebuild' | 'capacity' | 'stopped';
  code: DiagnosticCode;
}>;
export type FeedFrame = Extract<
  ServerFrame,
  { type: 'change_batch' | 'progress' | 'handoff_complete' }
>;
export type FeedConnection = Readonly<{
  done: Promise<SocketEnd>;
  closed: Promise<void>;
  close: () => Promise<void>;
}>;
function messageBudget(budget: Budget, limits: NegotiatedLimits): Budget {
  return effectiveBudget('wss_data', {
    ...budget,
    maxBytes: Math.min(budget.maxBytes, limits.max_message_bytes),
    maxValues: Math.min(budget.maxValues, limits.max_json_values),
    maxChanges: Math.min(budget.maxChanges, limits.max_changes),
  });
}

export function feedSocket(
  session: Session,
  lease: SocketLease,
  memory: PictureMemory,
  from: string,
  limits: NegotiatedLimits,
  onFrame: (frame: FeedFrame, handoff: string, fingerprint: string) => void,
  onEnd: (result: SocketEnd) => void,
): FeedConnection {
  const dataset_id = Uuid.parse(lease.datasetId);
  const authentication = NewId.parse(crypto.randomUUID());
  const subscribe = NewId.parse(crypto.randomUUID());
  const subscription_id = NewId.parse(crypto.randomUUID());
  let budget: Budget = messageBudget(session.responseBudget, limits);
  let phase: 'authentication' | 'subscription' | 'feed' = 'authentication';
  let handoff = '';
  let ended = false;
  let closing: Promise<void> | undefined;
  const queued: { text: string; bytes: number }[] = [];
  let queuedBytes = 0;
  let reader: Promise<void> | undefined;
  let finish!: (end: SocketEnd) => void;
  const done = new Promise<SocketEnd>((resolve) => {
    finish = resolve;
  });
  const socket = new WebSocket(`${lease.baseUrl.replace('https:', 'wss:')}/changes`);
  socket.binaryType = 'arraybuffer';
  const authenticationTimer = setTimeout(
    () => end({ kind: 'transport', code: 'deadline' }),
    Math.min(session.timeoutMs, 10_000),
  );
  let subscriptionTimer: ReturnType<typeof setTimeout> | undefined;

  function end(result: SocketEnd): void {
    if (ended) return;
    ended = true;
    clearTimeout(authenticationTimer);
    clearTimeout(subscriptionTimer);
    for (const item of queued) memory.release(item.bytes);
    queued.length = 0;
    queuedBytes = 0;
    if (lease.current()) onEnd(result);
    finish(result);
    if (socket.readyState < WebSocket.CLOSING) socket.close();
  }
  function close(): Promise<void> {
    if (closing) return closing;
    end({ kind: 'stopped', code: 'cancelled' });
    closing = new Promise<void>((resolve, reject) => {
      if (socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        socket.removeEventListener('close', closed);
        reject(new SdkError('deadline'));
      }, 1000);
      function closed(): void {
        clearTimeout(timer);
        resolve();
      }
      socket.addEventListener('close', closed, { once: true });
    }).finally(async () => {
      lease.signal.removeEventListener('abort', aborted);
      socket.removeEventListener('message', message);
      await reader;
    });
    return closing;
  }
  function aborted(): void {
    end({ kind: 'stopped', code: 'superseded' });
  }
  lease.signal.addEventListener('abort', aborted, { once: true });
  socket.addEventListener('open', () => {
    if (!lease.current() || ended) {
      aborted();
      return;
    }
    try {
      socket.send(
        new TextDecoder().decode(
          writeWssClient({
            type: 'authenticate',
            request_id: authentication,
            dataset_id,
            protocol_version: PROTOCOL_VERSION,
            api_key: lease.credential,
          }),
        ),
      );
    } catch (error) {
      end({ kind: 'transport', code: failureCode(error) });
    }
  });
  function message(event: MessageEvent<unknown>): void {
    if (!lease.current() || ended) return;
    try {
      if (typeof event.data !== 'string') throw new SdkError('invalid_value');
      const bytes = event.data.length * 2 + 256;
      if (queued.length >= 64 || bytes + queuedBytes > budget.maxBytes * 2 + 256)
        throw new SdkError('capacity');
      memory.take(bytes);
      queued.push({ text: event.data, bytes });
      queuedBytes += bytes;
      reader ??= drain().finally(() => {
        reader = undefined;
      });
    } catch (error) {
      end({
        kind: failureCode(error) === 'capacity' ? 'capacity' : 'rebuild',
        code: failureCode(error),
      });
    }
  }
  async function drain(): Promise<void> {
    while (queued.length && lease.current() && !ended) {
      const item = queued.shift();
      if (!item) return;
      queuedBytes -= item.bytes;
      try {
        await process(item.text);
      } finally {
        memory.release(item.bytes);
      }
    }
  }
  async function process(text: string): Promise<void> {
    if (!lease.current() || ended) return;
    let release: (() => void) | undefined;
    try {
      const maximum = phase === 'authentication' ? 16_384 : budget.maxBytes;
      if (text.length > maximum) throw new SdkError('payload_too_large');
      release = memory.reserveDecode(
        phase === 'authentication' ? { ...budget, maxBytes: 16_384, maxValues: 4096 } : budget,
      );
      const bytes = new TextEncoder().encode(text);
      if (bytes.byteLength > maximum) throw new SdkError('payload_too_large');
      const started = performance.now();
      const frame = readWssServer(bytes, { budget, subscriptionId: subscription_id });
      if (
        frame.dataset_id !== dataset_id &&
        !(frame.type === 'error' && frame.error.code === 'dataset_mismatch')
      )
        throw new SdkError('invalid_value');
      if (session.diagnosticsEnabled)
        session.emit({
          kind: 'request',
          operation: 'socket',
          source: 'wss',
          phase: 'validation',
          outcome: 'success',
          elapsedMs: performance.now() - started,
          bytes: { received: bytes.byteLength },
          generation: lease.generation,
          datasetId: lease.datasetId,
        });
      if (!lease.current()) return;
      if (frame.type === 'error') {
        // A pre-auth timeout/error with no matching control ID says nothing about the key.
        if (phase !== 'authentication' || frame.request_id === authentication)
          session.observeAuthority(lease.generation, frame.error.code);
        end({
          kind:
            phase === 'authentication'
              ? 'transport'
              : frame.error.code === 'cursor_expired'
                ? 'rebuild'
                : frame.error.code === 'resource_limit' || frame.error.code === 'payload_too_large'
                  ? 'capacity'
                  : 'transport',
          code: frame.error.code,
        });
        return;
      }
      if (phase === 'authentication') {
        if (frame.type !== 'authenticated' || frame.request_id !== authentication)
          throw new SdkError('invalid_value');
        if (frame.data.core_run_id !== lease.coreRunId) {
          end({ kind: 'transport', code: 'superseded' });
          return;
        }
        clearTimeout(authenticationTimer);
        phase = 'subscription';
        subscriptionTimer = setTimeout(
          () => end({ kind: 'transport', code: 'deadline' }),
          session.timeoutMs,
        );
        socket.send(
          new TextDecoder().decode(
            writeWssClient({
              type: 'subscribe_changes',
              request_id: subscribe,
              dataset_id,
              protocol_version: PROTOCOL_VERSION,
              data: { subscription_id, from_cursor: Opaque.parse(from), ...limits },
            }),
          ),
        );
        return;
      }
      if (phase === 'subscription') {
        if (frame.type !== 'subscribed' || frame.request_id !== subscribe)
          throw new SdkError('invalid_value');
        handoff = frame.data.handoff_cursor;
        budget = messageBudget(budget, frame.data.limits);
        phase = 'feed';
        return;
      }
      switch (frame.type) {
        case 'change_batch':
        case 'progress':
        case 'handoff_complete':
          if (frame.type === 'handoff_complete') {
            if (frame.data.handoff_cursor !== handoff) throw new SdkError('invalid_value');
            clearTimeout(subscriptionTimer);
          }
          {
            const canonical =
              frame.type === 'change_batch'
                ? {
                    type: frame.type,
                    previous: frame.data.previous_cursor,
                    next: frame.data.commit_cursor,
                    changes: frame.data.changes,
                  }
                : frame.type === 'progress'
                  ? {
                      type: frame.type,
                      previous: frame.data.previous_cursor,
                      next: frame.data.through_cursor,
                    }
                  : { type: frame.type };
            const digest = await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(JSON.stringify(canonical)),
            );
            if (!lease.current() || ended) return;
            const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
              byte.toString(16).padStart(2, '0'),
            ).join('');
            onFrame(frame, handoff, fingerprint);
          }
          break;
        case 'gap':
          end({
            kind: frame.data.reason === 'cursor_expired' ? 'rebuild' : 'capacity',
            code: frame.data.reason === 'limits_changed' ? 'resource_limit' : frame.data.reason,
          });
          break;
        default:
          throw new SdkError('invalid_value');
      }
    } catch (error) {
      const code = failureCode(error);
      end({
        kind:
          code === 'capacity' ? 'capacity' : phase === 'authentication' ? 'transport' : 'rebuild',
        code,
      });
    } finally {
      release?.();
    }
  }
  socket.addEventListener('message', message);
  socket.addEventListener('error', () => end({ kind: 'transport', code: 'network' }));
  const closed = new Promise<void>((resolve) => {
    socket.addEventListener(
      'close',
      () => {
        end({ kind: 'transport', code: 'network' });
        resolve();
      },
      { once: true },
    );
  });
  if (!lease.current()) aborted();
  return { done, closed, close };
}
