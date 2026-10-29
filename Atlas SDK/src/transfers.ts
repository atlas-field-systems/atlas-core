import {
  PROTOCOL_VERSION,
  correlation,
  exchanges,
  readHttp,
  readHttpRequest,
} from '@atlas/protocol';
import type { HttpError, RequestOf, ResponseOf } from '@atlas/protocol';
import { attempt } from './connection.js';
import type { NetworkLease, Session } from './connection.js';
import { SdkError } from './contracts.js';
import type {
  AttemptContext,
  AttemptResult,
  Prepared,
  RequestOptions,
  WaitResult,
} from './contracts.js';
import { CleanupFailure, failed, failureCode, freeze, receive, submission } from './http.js';
import type { Operations } from './prepared.js';
import { TransferReader, verifiedStream } from './transfer-stream.js';

export type UploadSource =
  | Blob
  | ReadableStream<Uint8Array>
  | Readonly<{
      open: (signal: AbortSignal) => ReadableStream<Uint8Array>;
    }>;
export type PreparedUpload = Prepared<RequestOf<'UploadObject'>, ResponseOf<'UploadObject'>>;
export type ReferenceMedia = Extract<ResponseOf<'GetReference'>, { kind: 'reference' }>['media'];
type ContentReply = ResponseOf<'ReadObjectContent'>;
export type ContentHandle = Extract<ContentReply, { kind: 'content' }> &
  Readonly<{
    // Bytes are provisional until the download's settled result confirms EOF and digest.
    stream: ReadableStream<Uint8Array>;
  }>;
export type ContentDownload = Readonly<{
  id: string;
  open: (signal?: AbortSignal) => Promise<WaitResult<ContentHandle | HttpError>>;
  settled: Promise<AttemptResult<ContentReply>>;
  cancel: () => Promise<AttemptResult<ContentReply>>;
}>;
export type ContentOptions = Readonly<{ timeoutMs?: number; maxBytes?: number }>;
export type Transfers = Readonly<{
  prepareUpload: (descriptor: RequestOf<'UploadObject'>, source: UploadSource) => PreparedUpload;
  getContent: (
    request: RequestOf<'ReadObjectContent'>,
    options?: ContentOptions,
  ) => ContentDownload;
  getReference: (
    media: ReferenceMedia,
    options?: RequestOptions,
  ) => Promise<WaitResult<ResponseOf<'GetReference'>>>;
}>;

function headers(lease: NetworkLease): Headers {
  return new Headers({
    Authorization: `Bearer ${lease.credential}`,
    'Atlas-Dataset-ID': lease.datasetId,
    'Atlas-Protocol-Version': PROTOCOL_VERSION,
    'Atlas-Attempt-ID': lease.attemptId,
  });
}

function streamingRequests(): boolean {
  // Core uses HTTP/1.1. Browser request streams require HTTP/2 even when Request accepts duplex.
  const host: object = globalThis;
  return (
    'process' in host &&
    typeof host.process === 'object' &&
    host.process !== null &&
    'versions' in host.process &&
    typeof host.process.versions === 'object' &&
    host.process.versions !== null &&
    'node' in host.process.versions &&
    typeof host.process.versions.node === 'string'
  );
}

async function discard(response: Response, primary: unknown): Promise<never> {
  try {
    await response.body?.cancel();
  } catch (cleanup) {
    throw new CleanupFailure(failureCode(primary), failureCode(cleanup));
  }
  throw primary;
}

function multipart(
  reader: TransferReader,
  descriptor: Uint8Array,
  contentType: string,
  boundary: string,
) {
  const encode = (text: string) => new TextEncoder().encode(text);
  const parts = [
    encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="descriptor"\r\nContent-Type: application/json\r\n\r\n`,
    ),
    descriptor,
    encode(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="content"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
  ];
  let part = 0;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const prefix = parts[part];
          if (prefix !== undefined) {
            part++;
            controller.enqueue(prefix);
            return;
          }
          const chunk = await reader.read();
          if (chunk !== undefined) controller.enqueue(chunk);
          else {
            controller.enqueue(encode(`\r\n--${boundary}--\r\n`));
            controller.close();
          }
        } catch (error) {
          controller.error(error);
        }
      },
      cancel() {
        return reader.stop();
      },
    },
    { highWaterMark: 0 },
  );
}

export function createTransfers(session: Session, operations: Operations): Transfers {
  if (operations.session !== session) throw new SdkError('invalid_options');

  const prepareUpload: Transfers['prepareUpload'] = (descriptor, source) => {
    if (
      !(source instanceof Blob) &&
      !(source instanceof ReadableStream) &&
      (source === null || typeof source !== 'object' || typeof source.open !== 'function')
    )
      throw new SdkError('unsupported_source');
    const open =
      source instanceof Blob || source instanceof ReadableStream
        ? () => source
        : source.open.bind(source);
    return operations.bindTransport(
      exchanges.UploadObject,
      {
        kind: 'mutation',
        identity: (facts) => facts.request_id,
        noEffect: () => false,
      },
      (input, owned) =>
        session.startNetwork(
          'UploadObject',
          async (lease) => {
            const started = performance.now();
            let reader: TransferReader | undefined;
            let sent = false;
            let sourceClosed = false;
            let context: AttemptContext = {
              attemptId: lease.attemptId,
              elapsedMs: 0,
              receivedBytes: 0,
              suppliedBytes: 0,
              observedTransportBytes: null,
            };
            let result: AttemptResult<ResponseOf<'UploadObject'>>;
            let primary: unknown;
            try {
              lease.signal.throwIfAborted();
              const length = Number(input.facts.byte_length);
              const state = session.state;
              if (state.kind === 'ready' && length > state.health.limits.max_object_bytes)
                throw new SdkError('payload_too_large');
              const requestHeaders = headers(lease);
              requestHeaders.set('Accept', 'application/json');
              let body: FormData | ReadableStream<Uint8Array>;
              if (source instanceof Blob) {
                if (source.size !== length) throw new SdkError('integrity_mismatch');
                const form = new FormData();
                form.set(
                  'descriptor',
                  new Blob([new TextDecoder().decode(input.bytes)], { type: 'application/json' }),
                  'descriptor.json',
                );
                form.set('file', source.slice(0, source.size, input.facts.content_type), 'content');
                body = form;
                context = { ...context, suppliedBytes: source.size };
              } else {
                if (!streamingRequests()) throw new SdkError('unsupported_source');
                let stream: Blob | ReadableStream<Uint8Array>;
                try {
                  stream = open(lease.signal);
                } catch {
                  throw new SdkError('source_failure');
                }
                if (!(stream instanceof ReadableStream)) throw new SdkError('unsupported_source');
                if (stream.locked) throw new SdkError('non_replayable_source');
                // Fetch's Body boundary also rejects streams disturbed outside this SDK.
                try {
                  new Response(stream);
                } catch {
                  throw new SdkError('non_replayable_source');
                }
                reader = new TransferReader(
                  stream,
                  lease.signal,
                  length,
                  input.facts.sha256,
                  'source_failure',
                );
                const boundary = `atlas-${crypto.randomUUID()}`;
                requestHeaders.set('Content-Type', `multipart/form-data; boundary=${boundary}`);
                body = multipart(reader, input.bytes, input.facts.content_type, boundary);
              }
              lease.signal.throwIfAborted();
              const init = {
                method: 'POST',
                headers: requestHeaders,
                body,
                signal: lease.signal,
                redirect: 'error',
                credentials: 'omit',
                cache: 'no-store',
                ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
              } satisfies RequestInit & { duplex?: string };
              const request = new Request(
                new URL(exchanges.UploadObject.path, lease.baseUrl),
                init,
              );
              readHttpRequest(
                exchanges.UploadObject,
                {
                  method: request.method,
                  path: exchanges.UploadObject.path,
                  headers: request.headers,
                  uploadDescriptor: input.bytes,
                },
                session.requestBudget,
              );
              sent = true;
              const response = await fetch(request);
              const ids = correlation(response.headers);
              context = {
                ...context,
                ...(ids.requestId === undefined ? {} : { requestId: ids.requestId }),
              };
              const bytes = await receive(response, session.responseBudget.maxBytes, (count) => {
                context = { ...context, receivedBytes: context.receivedBytes + count };
              });
              try {
                await reader?.close();
              } catch (cleanup) {
                context = {
                  ...context,
                  cleanupFailure:
                    cleanup instanceof CleanupFailure
                      ? cleanup.cleanupFailure
                      : failureCode(cleanup),
                };
              }
              sourceClosed = true;
              const validation = performance.now();
              const reply = freeze(
                readHttp(
                  exchanges.UploadObject,
                  { status: response.status, headers: response.headers, body: bytes },
                  {
                    datasetId: lease.datasetId,
                    request: input.facts,
                    budget: session.responseBudget,
                  },
                ),
              );
              context = { ...context, validationMs: performance.now() - validation };
              result = { kind: 'response', response: reply, context };
            } catch (error) {
              primary = reader?.failure ?? error;
              result = sent
                ? failed(primary, lease, context)
                : { kind: 'not_sent', code: failureCode(primary), attemptId: lease.attemptId };
            }
            if (result.kind === 'failed') context = result.context;
            try {
              if (!sourceClosed) await reader?.close(primary);
            } catch (cleanup) {
              // A validated success still establishes the effect even if source cleanup fails.
              context = {
                ...context,
                cleanupFailure:
                  cleanup instanceof CleanupFailure ? cleanup.cleanupFailure : failureCode(cleanup),
              };
              if (result.kind !== 'response') result = failed(cleanup, lease, context);
            }
            context = {
              ...context,
              elapsedMs: performance.now() - started,
              suppliedBytes: reader?.bytes ?? context.suppliedBytes ?? 0,
            };
            return result.kind === 'not_sent' ? result : { ...result, context };
          },
          owned,
        ),
    )(descriptor);
  };

  const getReference: Transfers['getReference'] = (media, options = {}) => {
    if (options.signal?.aborted)
      return session.refuse<ResponseOf<'GetReference'>>('GetReference', 'cancelled').settled;
    return session
      .startNetwork<ResponseOf<'GetReference'>>(
        'GetReference',
        async (lease) => {
          const started = performance.now();
          let context: AttemptContext = {
            attemptId: lease.attemptId,
            receivedBytes: 0,
            elapsedMs: 0,
            observedTransportBytes: null,
          };
          let sent = false;
          try {
            const requestHeaders = headers(lease);
            requestHeaders.set('Accept', media);
            readHttpRequest(
              exchanges.GetReference,
              { method: 'GET', path: '/reference', headers: requestHeaders },
              session.requestBudget,
            );
            lease.signal.throwIfAborted();
            sent = true;
            const response = await fetch(new URL('/reference', lease.baseUrl), {
              headers: requestHeaders,
              signal: lease.signal,
              redirect: 'error',
              credentials: 'omit',
              cache: 'no-store',
            });
            const ids = correlation(response.headers);
            context = {
              ...context,
              ...(ids.requestId === undefined ? {} : { requestId: ids.requestId }),
            };
            const body = await receive(response, session.responseBudget.maxBytes, (count) => {
              context = { ...context, receivedBytes: context.receivedBytes + count };
            });
            const validation = performance.now();
            const reply = freeze(
              readHttp(
                exchanges.GetReference,
                { status: response.status, headers: response.headers, body },
                {
                  datasetId: lease.datasetId,
                  referenceMedia: media,
                  request: {},
                  budget: session.responseBudget,
                },
              ),
            );
            return {
              kind: 'response',
              response: reply,
              context: {
                ...context,
                elapsedMs: performance.now() - started,
                validationMs: performance.now() - validation,
              },
            };
          } catch (error) {
            return sent
              ? failed(error, lease, { ...context, elapsedMs: performance.now() - started })
              : { kind: 'not_sent', code: failureCode(error), attemptId: lease.attemptId };
          }
        },
        options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
      )
      .wait(options.signal);
  };

  const getContent: Transfers['getContent'] = (request, options = {}) => {
    const cancellation = new AbortController();
    let publish: (result: AttemptResult<ContentHandle | HttpError>) => void;
    const opened = new Promise<AttemptResult<ContentHandle | HttpError>>((resolve) => {
      publish = resolve;
    });
    const start = () => {
      let facts: RequestOf<'ReadObjectContent'>;
      const maximum = options.maxBytes ?? 2_000_000_000;
      try {
        if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 2_000_000_000)
          throw new SdkError('invalid_options');
        facts = submission(exchanges.ReadObjectContent, request, session.requestBudget).facts;
      } catch (error) {
        return session.refuse<ContentReply>('ReadObjectContent', failureCode(error));
      }
      return session.startNetwork<ContentReply>(
        'ReadObjectContent',
        async (lease) => {
          const started = performance.now();
          const signal = AbortSignal.any([lease.signal, cancellation.signal]);
          let context: AttemptContext = {
            attemptId: lease.attemptId,
            receivedBytes: 0,
            elapsedMs: 0,
            observedTransportBytes: null,
          };
          let reader: TransferReader | undefined;
          let sent = false;
          try {
            signal.throwIfAborted();
            const path = `/objects/${facts.object_id}/content?disposition=${facts.disposition}`;
            const requestHeaders = headers(lease);
            readHttpRequest(
              exchanges.ReadObjectContent,
              { method: 'GET', path, headers: requestHeaders },
              session.requestBudget,
            );
            sent = true;
            const response = await fetch(new URL(path, lease.baseUrl), {
              headers: requestHeaders,
              signal,
              redirect: 'error',
              credentials: 'omit',
              cache: 'no-store',
            });
            const ids = correlation(response.headers);
            context = {
              ...context,
              ...(ids.requestId === undefined ? {} : { requestId: ids.requestId }),
            };
            const validation = performance.now();
            let reply: ContentReply;
            try {
              const body =
                response.status === 200
                  ? undefined
                  : await receive(response, session.responseBudget.maxBytes, (count) => {
                      context = { ...context, receivedBytes: context.receivedBytes + count };
                    });
              reply = freeze(
                readHttp(
                  exchanges.ReadObjectContent,
                  {
                    status: response.status,
                    headers: response.headers,
                    ...(body === undefined ? {} : { body }),
                  },
                  { datasetId: lease.datasetId, request: facts, budget: session.responseBudget },
                ),
              );
              if (reply.kind === 'content' && Number(reply.descriptor.byte_length) > maximum)
                throw new SdkError('payload_too_large');
              signal.throwIfAborted();
              if (!lease.current()) throw new SdkError('superseded');
            } catch (error) {
              return await discard(response, error);
            }
            context = { ...context, validationMs: performance.now() - validation };
            if (reply.kind === 'error')
              return {
                kind: 'response',
                response: reply,
                context: { ...context, elapsedMs: performance.now() - started },
              };
            if (!response.body) throw new SdkError('invalid_http');
            reader = new TransferReader(
              response.body,
              signal,
              Number(reply.descriptor.byte_length),
              reply.descriptor.sha256,
              'network',
            );
            const content = verifiedStream(reader, signal);
            publish({
              kind: 'response',
              response: Object.freeze({ ...reply, stream: content.stream }),
              context: { ...context, elapsedMs: performance.now() - started },
            });
            await content.completed;
            return {
              kind: 'response',
              response: reply,
              context: {
                ...context,
                receivedBytes: reader.bytes,
                elapsedMs: performance.now() - started,
              },
            };
          } catch (error) {
            return sent
              ? failed(
                  error,
                  { ...lease, signal },
                  {
                    ...context,
                    receivedBytes: reader?.bytes ?? context.receivedBytes,
                    elapsedMs: performance.now() - started,
                  },
                )
              : { kind: 'not_sent', code: failureCode(error), attemptId: lease.attemptId };
          }
        },
        options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
      );
    };
    const running = start();
    void running.settled.then((result) => {
      if (result.kind === 'response') {
        if (result.response.kind === 'error') publish({ ...result, response: result.response });
      } else publish(result);
    });
    return Object.freeze({
      id: running.id,
      open: attempt(running.id, opened).wait,
      settled: running.settled,
      cancel: () => {
        cancellation.abort(new SdkError('cancelled'));
        return running.settled;
      },
    });
  };
  return Object.freeze({ prepareUpload, getContent, getReference });
}
