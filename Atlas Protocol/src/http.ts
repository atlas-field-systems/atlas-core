import { z } from 'zod';
import {
  readJson,
  readPreparedJson,
  checkJsonBytes,
  effectiveBudget,
  validateValue,
} from './json.js';
import type { Budget } from './json.js';
import type { CheckedBinding, Transport } from './exchange.js';
import type { HttpError } from './errors.js';
import { ProtocolError } from './failure.js';
import { NewId, PROTOCOL_VERSION } from './scalars.js';
import { headers as headerDefinitions } from './bindings.js';

export type ReceivedHttp = Readonly<{ status: number; headers: Headers; body?: Uint8Array }>;
type ResponseContext =
  | HttpError
  | Readonly<{ kind: 'success'; body: Readonly<{ dataset_id: string }> }>
  | Readonly<{ kind: 'content' | 'reference' }>;
type Binding<R extends z.ZodType, S extends z.ZodType<ResponseContext>> = CheckedBinding<R, S> &
  Transport<R> &
  Readonly<{
    operationId: string;
    method: 'GET' | 'POST';
    path: string;
    discovery: boolean;
    requestMedia: string;
    successStatuses: readonly number[];
  }>;
export type HttpContext = Readonly<{
  datasetId?: string;
  request?: unknown;
  referenceMedia?: 'application/vnd.oai.openapi+json' | 'text/html';
  budget?: Partial<Budget>;
}>;
function invalidHttp(
  path: string,
  message: 'missing' | 'invalid' | 'mismatch' | 'unsupported',
): never {
  throw new ProtocolError('invalid_http', [{ path, message }]);
}
function parsed<S extends z.ZodType>(schema: S, value: unknown, path?: string): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    if (path) invalidHttp(path, value === null ? 'missing' : 'invalid');
    throw new ProtocolError('invalid_http');
  }
  return result.data;
}
function header<S extends z.ZodType>(
  definition: Readonly<{ name: string; schema: S }>,
  values: Headers,
): z.output<S> {
  return parsed(definition.schema, values.get(definition.name), `header.${definition.name}`);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function uncompressed(headers: Headers): void {
  if (headers.has('content-encoding')) invalidHttp('header.Content-Encoding', 'unsupported');
}
function media(headers: Headers): string {
  const raw = headers.get('content-type');
  if (!raw) invalidHttp('media', 'missing');
  const match = /^\s*([^;\s]+)(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$(?![\s\S])/i.exec(raw);
  if (!match?.[1]) invalidHttp('media', 'invalid');
  return match[1].toLowerCase();
}
function sameDataset(value: unknown, dataset: string): boolean {
  if (Array.isArray(value)) return value.every((item) => sameDataset(item, dataset));
  if (!object(value)) return true;
  if (Object.hasOwn(value, 'dataset_id') && value.dataset_id !== dataset) return false;
  return Object.values(value).every((item) => sameDataset(item, dataset));
}
function length(headers: Headers, actual: number): void {
  const raw = headers.get('content-length');
  if (
    raw !== null &&
    (raw.length > 20 || !/^(0|[1-9][0-9]*)$(?![\s\S])/.test(raw) || BigInt(raw) !== BigInt(actual))
  )
    invalidHttp('header.Content-Length', 'invalid');
}
export function correlation(
  headers: Headers,
): Readonly<{ requestId?: z.output<typeof NewId>; attemptId?: z.output<typeof NewId> }> {
  const request = NewId.safeParse(headers.get('Atlas-Request-ID'));
  const attempt = NewId.safeParse(headers.get('Atlas-Attempt-ID'));
  return {
    ...(request.success ? { requestId: request.data } : {}),
    ...(attempt.success ? { attemptId: attempt.data } : {}),
  };
}

export function readHttp<R extends z.ZodType, S extends z.ZodType<ResponseContext>>(
  definition: Binding<R, S>,
  received: ReceivedHttp,
  context: HttpContext = {},
): z.output<S> {
  const budget = effectiveBudget('http_response', context.budget);
  const headers = received.headers;
  uncompressed(headers);
  const dataset = header(headerDefinitions.dataset, headers);
  const version = header(headerDefinitions.protocol, headers);
  const success = definition.successStatuses.includes(received.status);
  const bytes = received.body;
  if (
    success &&
    (version !== PROTOCOL_VERSION ||
      (context.datasetId !== undefined && dataset !== context.datasetId))
  )
    throw new ProtocolError('invalid_http');
  const request =
    success && context.request !== undefined
      ? validateValue(definition.request, context.request, context.budget)
      : undefined;
  const meta = { status: received.status, protocolVersion: version };
  if (success && definition.transport === 'content') {
    if (bytes !== undefined) throw new ProtocolError('invalid_http');
    const result = parsed(
      definition.response.schema,
      definition.prepareContent(
        request,
        {
          byte_length: headers.get('Content-Length'),
          sha256: headers.get('Atlas-Content-SHA256'),
          content_type: headers.get('Content-Type'),
          disposition: headers.get('Content-Disposition'),
        },
        received.status,
      ),
    );
    definition.checkResponse(result, request, meta);
    return result;
  }
  if (success && definition.transport === 'reference') {
    if (!bytes || bytes.byteLength > budget.maxBytes) throw new ProtocolError('payload_too_large');
    const type = media(headers);
    if (
      (type !== 'application/vnd.oai.openapi+json' && type !== 'text/html') ||
      (context.referenceMedia && context.referenceMedia !== type)
    )
      throw new ProtocolError('invalid_http');
    length(headers, bytes.byteLength);
    let document: string;
    try {
      document = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new ProtocolError('invalid_utf8');
    }
    if (type === 'application/vnd.oai.openapi+json')
      checkJsonBytes(bytes, 'http_response', context.budget);
    const result = parsed(definition.response.schema, {
      kind: 'reference',
      status: received.status,
      media: type,
      document,
    });
    definition.checkResponse(result, request, meta);
    return result;
  }
  if (!bytes || media(headers) !== 'application/json') throw new ProtocolError('invalid_http');
  length(headers, bytes.byteLength);
  const responseBudget = definition.responseBudget?.(request, budget) ?? budget;
  const result = readPreparedJson(
    definition.response,
    bytes,
    (body) => ({ kind: success ? 'success' : 'error', status: received.status, body }),
    responseBudget,
  );
  if (result.kind !== 'success' && result.kind !== 'error') throw new ProtocolError('invalid_http');
  if (!sameDataset(result.body, dataset)) throw new ProtocolError('invalid_http');
  if (result.kind === 'error') {
    const error = result.body.error;
    if (
      error.code === 'protocol_mismatch' &&
      error.details !== undefined &&
      error.details.protocol_version !== version
    )
      throw new ProtocolError('invalid_http');
    if (version !== PROTOCOL_VERSION && error.code !== 'protocol_mismatch')
      throw new ProtocolError('invalid_http');
  }
  definition.checkResponse(result, request, meta);
  return result;
}

export function readHttpRequest<R extends z.ZodType, S extends z.ZodType<ResponseContext>>(
  definition: Binding<R, S>,
  incoming: Readonly<{
    method: string;
    path: string;
    headers: Headers;
    body?: Uint8Array;
    uploadDescriptor?: Uint8Array;
  }>,
  lower?: Partial<Budget>,
): z.output<R> {
  effectiveBudget('http_request', lower);
  uncompressed(incoming.headers);
  if (incoming.method !== definition.method) invalidHttp('method', 'mismatch');
  header(headerDefinitions.authorization, incoming.headers);
  let dataset: string | undefined;
  if (!definition.discovery) {
    dataset = header(headerDefinitions.dataset, incoming.headers);
    const version = header(headerDefinitions.protocol, incoming.headers);
    if (version !== PROTOCOL_VERSION) invalidHttp('header.Atlas-Protocol-Version', 'mismatch');
  }
  if (definition.method === 'GET') {
    if (incoming.body?.byteLength || incoming.uploadDescriptor !== undefined)
      invalidHttp('body', 'unsupported');
    length(incoming.headers, 0);
    if (
      definition.transport === 'reference' &&
      !['application/vnd.oai.openapi+json', 'text/html'].includes(
        incoming.headers.get('Accept') ?? '',
      )
    )
      invalidHttp('media', 'unsupported');
    let value: unknown = {};
    if (definition.transport === 'content') {
      const match =
        /^\/objects\/([0-9a-f-]{36})\/content\?disposition=(inline|attachment)$(?![\s\S])/.exec(
          incoming.path,
        );
      if (!match) invalidHttp('path', 'mismatch');
      value = { object_id: match[1], disposition: match[2] };
    } else if (incoming.path !== definition.path) invalidHttp('path', 'mismatch');
    return parsed(definition.request.schema, value, 'path');
  }
  if (incoming.path !== definition.path) invalidHttp('path', 'mismatch');
  let bytes = incoming.body;
  if (definition.transport === 'upload') {
    const contentType = incoming.headers.get('content-type');
    if (
      !contentType ||
      !/^multipart\/form-data;\s*boundary=(?:[0-9A-Za-z'+_.-]{1,70}|"[0-9A-Za-z'()+_,.\/:=? -]{0,69}[0-9A-Za-z'()+_,.\/:=?-]")$(?![\s\S])/i.test(
        contentType,
      ) ||
      bytes !== undefined
    )
      invalidHttp('media', 'invalid');
    bytes = incoming.uploadDescriptor;
  } else if (media(incoming.headers) !== definition.requestMedia)
    invalidHttp('media', 'unsupported');
  if (!bytes) invalidHttp('body', 'missing');
  if (definition.transport !== 'upload') length(incoming.headers, bytes.byteLength);
  const value = readJson(definition.request, bytes, lower);
  if (dataset && !sameDataset(value, dataset)) throw new ProtocolError('invalid_http');
  return value;
}
