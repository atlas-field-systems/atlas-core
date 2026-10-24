import { z } from 'zod';
import { caseFoldEquals } from 'unicode-case-folding';
import {
  contract,
  readJson,
  readPreparedJson,
  checkJsonBytes,
  effectiveBudget,
  messageBudget,
  validateValue,
} from './json.js';
import type { Budget, JsonContract } from './json.js';
import { ProtocolError } from './failure.js';
import { NewId, PROTOCOL_VERSION } from './scalars.js';
import { NegotiatedLimits } from './administration.js';
import { headers as headerDefinitions } from './bindings.js';

export type ReceivedHttp = Readonly<{ status: number; headers: Headers; body?: Uint8Array }>;
type Binding<R extends z.ZodType, S extends z.ZodType> = Readonly<{
  operationId: string;
  method: 'GET' | 'POST';
  path: string;
  transport: string;
  discovery: boolean;
  requestMedia: string;
  responseMedia: string;
  successStatuses: readonly number[];
  request: JsonContract<R>;
  response: JsonContract<S>;
  success: z.ZodType;
  historyKind?: 'asset' | 'observation' | 'track';
}>;
export type HttpContext = Readonly<{
  datasetId?: string;
  protocolVersion?: string;
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
function matchPageSize(request: Record<string, unknown>, data: Record<string, unknown>): boolean {
  if (Object.hasOwn(request, 'page_token')) return true;
  const entries = Array.isArray(data.items)
    ? data.items
    : Array.isArray(data.tasks)
      ? data.tasks
      : Array.isArray(data.readings)
        ? data.readings
        : undefined;
  return (
    entries === undefined ||
    entries.length <= (typeof request.page_size === 'number' ? request.page_size : 100)
  );
}
function matchHistory(
  kind: Binding<z.ZodType, z.ZodType>['historyKind'],
  request: Record<string, unknown>,
  data: Record<string, unknown>,
): boolean {
  if (!kind || request.entity_id === undefined || !Array.isArray(data.readings)) return true;
  return data.readings.every(
    (reading) =>
      object(reading) &&
      (kind === 'track'
        ? Array.isArray(reading.track_ids) && reading.track_ids.includes(request.entity_id)
        : reading.source_entity_kind === kind && reading.source_entity_id === request.entity_id),
  );
}
function matchRequest(
  operation: string,
  request: unknown,
  data: unknown,
  historyKind?: Binding<z.ZodType, z.ZodType>['historyKind'],
): boolean {
  if (!object(request) || !object(data)) return true;
  if (!matchPageSize(request, data) || !matchHistory(historyKind, request, data)) return false;
  const resource = object(data.asset)
    ? data.asset
    : object(data.observation)
      ? data.observation
      : object(data.task)
        ? data.task
        : data;
  if (
    [
      'GetAssetByAlias',
      'GetObservationByAlias',
      'GetTrackByAlias',
      'GetGeofeatureByAlias',
    ].includes(operation) &&
    (typeof request.alias !== 'string' ||
      typeof resource.alias !== 'string' ||
      !caseFoldEquals(request.alias, resource.alias))
  )
    return false;
  const pairs: readonly (readonly [string, string])[] = [
    [
      'asset_id',
      operation === 'BeginAssetContact' ||
      operation === 'GetAssetStatus' ||
      operation === 'GetAssignedTasks'
        ? 'asset_id'
        : 'id',
    ],
    ['observation_id', 'id'],
    ['track_id', 'id'],
    ['geofeature_id', 'id'],
    ['task_id', 'task_id'],
    ['object_id', 'object_id'],
    ['operator_id', 'operator_id'],
    ['api_key_id', 'api_key_id'],
  ];
  for (const [input, output] of pairs) {
    if (
      Object.hasOwn(request, input) &&
      Object.hasOwn(resource, output) &&
      request[input] !== resource[output]
    )
      return false;
  }
  if (
    request.asset_id !== undefined &&
    resource.asset_id !== undefined &&
    request.asset_id !== resource.asset_id
  )
    return false;
  if (
    object(data.observation) &&
    ((request.publisher_id !== undefined &&
      request.publisher_id !== data.observation.publisher_id) ||
      (request.source_asset_id !== undefined &&
        request.source_asset_id !== data.observation.source_asset_id))
  )
    return false;
  if (
    operation === 'CreateObservation' &&
    object(request.publisher_subject) &&
    (!object(resource.publisher_subject) ||
      request.publisher_subject.id !== resource.publisher_subject.id ||
      request.publisher_subject.lifetime_id !== resource.publisher_subject.lifetime_id)
  )
    return false;
  if (
    operation === 'CreateTask' &&
    ['request_id', 'task_id', 'asset_id', 'command', 'scheduling', 'inputs', 'expires_at'].some(
      (key) => JSON.stringify(request[key]) !== JSON.stringify(resource[key]),
    )
  )
    return false;
  if (
    operation === 'UploadObject' &&
    ['byte_length', 'sha256', 'content_type'].some((key) => request[key] !== data[key])
  )
    return false;
  if (operation === 'CreateApiKey' && (request.operator_id ?? null) !== data.operator_id)
    return false;
  if (
    operation === 'RegisterAsset' &&
    (!object(data.api_key) || data.api_key.api_key_id !== request.api_key_id)
  )
    return false;
  if (
    operation === 'GetAssignedTasks' &&
    ['read_id', 'process_generation', 'asset_id'].some(
      (key) => Object.hasOwn(request, key) && request[key] !== data[key],
    )
  )
    return false;
  if (
    operation === 'ReadSnapshot' &&
    request.load_id !== undefined &&
    request.load_id !== data.load_id
  )
    return false;
  if (historyKind && request.query_id !== undefined && request.query_id !== data.query_id)
    return false;
  if (
    operation === 'ReadChanges' &&
    request.from_cursor !== undefined &&
    Array.isArray(data.messages)
  ) {
    const first: unknown = data.messages[0];
    if (
      first === undefined
        ? data.through_cursor !== request.from_cursor
        : !object(first) ||
          !object(first.data) ||
          first.data.previous_cursor !== request.from_cursor
    )
      return false;
  }
  if (
    operation === 'GetTrackObservations' &&
    request.track_id !== undefined &&
    Array.isArray(data.items) &&
    data.items.some((item) => !object(item) || item.track_id !== request.track_id)
  )
    return false;
  if (
    operation === 'BeginAssetContact' &&
    ['mode', 'process_generation', 'expected_process_generation'].some(
      (key) => request[key] !== data[key],
    )
  )
    return false;
  if (
    operation === 'ReplaceAssetProcess' &&
    resource.process_generation !== request.process_generation
  )
    return false;
  if (object(request.evidence)) {
    if (
      object(data.task) &&
      (request.evidence.asset_id !== data.task.asset_id ||
        !object(request.evidence.payload) ||
        request.evidence.payload.task_id !== data.task.task_id)
    )
      return false;
    if (object(data.asset) && request.evidence.asset_id !== data.asset.id) return false;
  }
  return true;
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

export function readHttp<R extends z.ZodType, S extends z.ZodType>(
  definition: Binding<R, S>,
  received: ReceivedHttp,
  context: HttpContext = {},
): z.output<S> {
  const budget = effectiveBudget('http_response', context.budget);
  const headers = received.headers;
  uncompressed(headers);
  const dataset = header(headerDefinitions.dataset, headers);
  const version = header(headerDefinitions.protocol, headers);
  const expectedVersion = context.protocolVersion ?? PROTOCOL_VERSION;
  const success = definition.successStatuses.includes(received.status);
  const bytes = received.body;
  if (
    success &&
    (version !== expectedVersion ||
      (context.datasetId !== undefined && dataset !== context.datasetId))
  )
    throw new ProtocolError('invalid_http');
  if (success && definition.transport === 'content') {
    if (bytes !== undefined || context.request === undefined)
      throw new ProtocolError('invalid_http');
    const request = validateValue(definition.request, context.request, context.budget);
    if (!object(request)) throw new ProtocolError('invalid_http');
    const result = parsed(definition.response.schema, {
      kind: 'content',
      status: received.status,
      descriptor: {
        object_id: request.object_id,
        byte_length: headers.get('Content-Length'),
        sha256: headers.get('Atlas-Content-SHA256'),
        content_type: headers.get('Content-Type'),
        disposition: headers.get('Content-Disposition'),
      },
    });
    if (
      !object(result) ||
      !object(result.descriptor) ||
      result.descriptor.disposition !== request.disposition
    )
      throw new ProtocolError('invalid_http');
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
    return parsed(definition.response.schema, {
      kind: 'reference',
      status: received.status,
      media: type,
      document,
    });
  }
  if (!bytes || media(headers) !== 'application/json') throw new ProtocolError('invalid_http');
  length(headers, bytes.byteLength);
  const request =
    success && context.request !== undefined
      ? validateValue(definition.request, context.request, context.budget)
      : undefined;
  const requestedLimits =
    object(request) && request.max_message_bytes !== undefined
      ? parsed(NegotiatedLimits, {
          max_message_bytes: request.max_message_bytes,
          max_json_values: request.max_json_values,
          max_changes: request.max_changes,
        })
      : undefined;
  const responseBudget =
    requestedLimits &&
    (definition.operationId === 'ReadSnapshot' || definition.operationId === 'ReadChanges')
      ? messageBudget(budget, requestedLimits)
      : budget;
  const responseContract = {
    ...contract(definition.response.schema, 'http_response'),
    ...(success && definition.operationId === 'ReadSnapshot'
      ? { messageLimits: { path: ['data', 'limits'] } }
      : {}),
  };
  const result = readPreparedJson(
    responseContract,
    bytes,
    (body) => ({ kind: success ? 'success' : 'error', status: received.status, body }),
    responseBudget,
  );
  if (!object(result) || !object(result.body)) throw new ProtocolError('invalid_http');
  const body = result.body;
  if (!sameDataset(body, dataset)) throw new ProtocolError('invalid_http');
  if (!success) {
    if (!object(body.error)) throw new ProtocolError('invalid_http');
    if (
      body.error.code === 'protocol_mismatch' &&
      object(body.error.details) &&
      body.error.details.protocol_version !== version
    )
      throw new ProtocolError('invalid_http');
    if (version !== expectedVersion && body.error.code !== 'protocol_mismatch')
      throw new ProtocolError('invalid_http');
    return result;
  }
  if (!matchRequest(definition.operationId, request, body.data, definition.historyKind))
    throw new ProtocolError('invalid_http');
  if (requestedLimits && object(body.data) && body.data.limits !== undefined) {
    const limits = parsed(NegotiatedLimits, body.data.limits);
    if (
      limits.max_message_bytes > requestedLimits.max_message_bytes ||
      limits.max_json_values > requestedLimits.max_json_values ||
      limits.max_changes > requestedLimits.max_changes
    )
      throw new ProtocolError('invalid_http');
  }
  if (
    definition.operationId === 'GetHealth' &&
    object(body.data) &&
    body.data.protocol_version !== version
  )
    throw new ProtocolError('invalid_http');
  if (
    definition.operationId === 'GetReadiness' &&
    object(body.data) &&
    body.data.ready !== (received.status === 200)
  )
    throw new ProtocolError('invalid_http');
  if (
    definition.operationId === 'UpdateAsset' &&
    object(request) &&
    ['alias', 'description', 'type', 'capabilities'].some((key) => Object.hasOwn(request, key)) &&
    !Object.hasOwn(body, 'commit_cursor')
  )
    throw new ProtocolError('invalid_http');
  if (
    (definition.operationId === 'UpdateAsset' || definition.operationId === 'CreateObservation') &&
    object(request) &&
    object(body.data) &&
    (request.report !== undefined) !== (body.data.evidence_disposition !== undefined)
  )
    throw new ProtocolError('invalid_http');
  if (
    definition.operationId === 'RevokeApiKey' &&
    object(body.data) &&
    body.data.revoked_at === null
  )
    throw new ProtocolError('invalid_http');
  if (
    definition.operationId === 'RequestTaskCancellation' &&
    object(body.data) &&
    body.data.execution_state !== 'completed' &&
    body.data.execution_state !== 'failed' &&
    body.data.execution_state !== 'cancelled' &&
    (body.data.cancellation_request_id === null ||
      !Object.hasOwn(body, 'commit_cursor') ||
      (object(request) && body.data.cancellation_request_id !== request.request_id))
  )
    throw new ProtocolError('invalid_http');
  return result;
}

export function readHttpRequest<R extends z.ZodType, S extends z.ZodType>(
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
