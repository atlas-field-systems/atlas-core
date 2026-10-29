import {
  PROTOCOL_VERSION,
  ProtocolError,
  correlation,
  readHttp,
  readJson,
  writeJson,
} from '@atlas/protocol';
import type { Budget, HttpError } from '@atlas/protocol';
import type { z } from 'zod';
import { SdkError } from './contracts.js';
import type { AttemptContext, AttemptResult, LocalCode } from './contracts.js';

export type JsonReply =
  | HttpError
  | {
      kind: 'success';
      status: number;
      body: { dataset_id: string; data: unknown; commit_cursor?: string };
    };
export type JsonBinding<R extends z.ZodType, S extends z.ZodType<JsonReply>> = Parameters<
  typeof readHttp<R, S>
>[0] & { transport: 'json' };

export function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function submission<R extends z.ZodType, S extends z.ZodType<JsonReply>>(
  binding: JsonBinding<R, S>,
  input: z.output<R>,
  budget: Budget,
) {
  const bytes = writeJson(binding.request, input, budget);
  const facts = freeze(readJson(binding.request, bytes, budget));
  return { facts, bytes };
}

export function failureCode(error: unknown): LocalCode {
  if (error instanceof ProtocolError || error instanceof SdkError) return error.code;
  return 'network';
}

class IngestionFailure extends SdkError {
  constructor(
    code: LocalCode,
    readonly cleanupFailure: LocalCode,
  ) {
    super(code);
  }
}

async function refuseBody(response: Response, code: LocalCode): Promise<never> {
  try {
    await response.body?.cancel();
  } catch (cleanup) {
    throw new IngestionFailure(code, failureCode(cleanup));
  }
  throw new SdkError(code);
}

export async function receive(
  response: Response,
  maximum: number,
  observed: (bytes: number) => void,
): Promise<Uint8Array> {
  const length = response.headers.get('content-length');
  if (length !== null && (length.length > 20 || !/^(0|[1-9][0-9]*)$/.test(length))) {
    return refuseBody(response, 'invalid_http');
  }
  if (
    response.headers.has('content-encoding') ||
    (length !== null && BigInt(length) > BigInt(maximum))
  ) {
    return refuseBody(
      response,
      response.headers.has('content-encoding') ? 'invalid_http' : 'payload_too_large',
    );
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  // One bounded buffer also bounds chunk metadata for byte-at-a-time responses.
  const storage = new Uint8Array(length === null ? maximum : Number(length));
  let used = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return storage.subarray(0, used);
      observed(value.byteLength);
      if (value.byteLength > storage.byteLength - used)
        throw new ProtocolError('payload_too_large');
      storage.set(value, used);
      used += value.byteLength;
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch (cleanup) {
      throw new IngestionFailure(failureCode(error), failureCode(cleanup));
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export type HttpLease = Readonly<{
  attemptId: string;
  credential: string;
  datasetId: string | null;
  generation: number;
  signal: AbortSignal;
  baseUrl: string;
}>;

export async function exchange<R extends z.ZodType, S extends z.ZodType<JsonReply>>(
  binding: JsonBinding<R, S>,
  input: Readonly<{ facts: z.output<R>; bytes: Uint8Array }>,
  lease: HttpLease,
  budget: Budget,
  selection: z.output<R> = input.facts,
): Promise<AttemptResult<z.output<S>>> {
  const started = performance.now();
  let receivedBytes = 0;
  let context: AttemptContext = {
    attemptId: lease.attemptId,
    elapsedMs: 0,
    receivedBytes: 0,
  };
  try {
    const headers = new Headers({
      Authorization: `Bearer ${lease.credential}`,
      'Atlas-Attempt-ID': lease.attemptId,
      'Atlas-Protocol-Version': PROTOCOL_VERSION,
      Accept: 'application/json',
    });
    if (lease.datasetId !== null) headers.set('Atlas-Dataset-ID', lease.datasetId);
    if (binding.method === 'POST') headers.set('Content-Type', 'application/json');
    const response = await fetch(new URL(binding.path, lease.baseUrl), {
      method: binding.method,
      headers,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: lease.signal,
      ...(binding.method === 'POST' ? { body: new TextDecoder().decode(input.bytes) } : {}),
    });
    const ids = correlation(response.headers);
    context = {
      ...context,
      ...(ids.requestId === undefined ? {} : { requestId: ids.requestId }),
    };
    const body = await receive(response, budget.maxBytes, (bytes) => {
      receivedBytes += bytes;
    });
    context = {
      ...context,
      receivedBytes: body.byteLength,
      elapsedMs: performance.now() - started,
    };
    const result = readHttp(
      binding,
      { status: response.status, headers: response.headers, body },
      {
        ...(lease.datasetId === null ? {} : { datasetId: lease.datasetId }),
        request: selection,
        budget,
      },
    );
    return { kind: 'response', response: freeze(result), context };
  } catch (error) {
    return {
      kind: 'failed',
      code: lease.signal.aborted ? failureCode(lease.signal.reason) : failureCode(error),
      context: {
        ...context,
        receivedBytes,
        elapsedMs: performance.now() - started,
        ...(error instanceof IngestionFailure ? { cleanupFailure: error.cleanupFailure } : {}),
      },
    };
  }
}
