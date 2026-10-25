import { z } from 'zod';
import { contract } from './json.js';
import type { Budget, JsonContract } from './json.js';
import { Opaque, Uuid, timestampNanoseconds, text } from './scalars.js';
import { Asset, Observation, Track } from './entities.js';
import { EvidenceDisposition } from './reports.js';
import { Task } from './tasks.js';
import { ContentDescriptor } from './objects.js';
import { HealthData, Readiness } from './administration.js';
import { HttpError } from './errors.js';
import { headers } from './bindings.js';
import type { Continuation, HistoryQuery, HistoryPage } from './history.js';
import { ProtocolError } from './failure.js';

export type CheckMeta = Readonly<{ status: number; protocolVersion: string }>;
export type SuccessCheck<R extends z.ZodType, S extends z.ZodType> = (
  request: z.output<R> | undefined,
  envelope: z.output<S>,
  meta: CheckMeta,
) => boolean;
export type CheckedBinding<R extends z.ZodType, S extends z.ZodType> = Readonly<{
  request: JsonContract<R>;
  response: JsonContract<S>;
  checkResponse: (result: z.output<S>, request: z.output<R> | undefined, meta: CheckMeta) => void;
  responseBudget?: (request: z.output<R> | undefined, budget: Budget) => Budget;
}>;
export type ContentHeaders = Readonly<{
  byte_length: string | null;
  sha256: string | null;
  content_type: string | null;
  disposition: string | null;
}>;
export type Transport<R extends z.ZodType> =
  | Readonly<{ transport: 'json' | 'upload' | 'reference' }>
  | Readonly<{
      transport: 'content';
      prepareContent: (
        request: z.output<R> | undefined,
        headers: ContentHeaders,
        status: number,
      ) => unknown;
    }>;

export function checked<R extends z.ZodType, S extends z.ZodType>(
  request: JsonContract<R>,
  response: JsonContract<S>,
  check: (result: z.output<S>, request: z.output<R> | undefined, meta: CheckMeta) => boolean,
): CheckedBinding<R, S> {
  return {
    request,
    response,
    checkResponse(result, input, meta) {
      if (!check(result, input, meta)) throw new ProtocolError('invalid_http');
    },
  };
}

export const assetResult = z.strictObject({
  asset: Asset,
  evidence_disposition: EvidenceDisposition.exactOptional(),
});
export const observationResult = z
  .strictObject({
    observation: Observation,
    track: Track,
    evidence_disposition: EvidenceDisposition.exactOptional(),
  })
  .refine(
    (value) =>
      value.observation.dataset_id === value.track.dataset_id &&
      value.observation.track_id === value.track.id &&
      value.track.sources.some(
        (source) =>
          source.observation_id === value.observation.id &&
          source.publisher_id === value.observation.publisher_id &&
          source.source_asset_id === value.observation.source_asset_id,
      ),
    'Observation Track pair differs',
  )
  .refine(
    (value) =>
      (['type', 'telemetry', 'attitude', 'geometry'] as const).every(
        (section) =>
          JSON.stringify(value.observation[section]) === JSON.stringify(value.track[section]),
      ),
    'Observation Track sections differ',
  );
export const taskResult = z.strictObject({ task: Task, evidence_disposition: EvidenceDisposition });
export const assetEvidenceResult = assetResult.extend({
  evidence_disposition: EvidenceDisposition,
});
export function durationMatches(
  from: string,
  until: string,
  minimum: bigint,
  maximum = minimum,
): boolean {
  try {
    const duration = timestampNanoseconds(until) - timestampNanoseconds(from);
    return duration >= minimum && duration <= maximum;
  } catch {
    return false;
  }
}
export function envelope<D extends z.ZodType>(data: D) {
  return z.strictObject({ dataset_id: Uuid, data, commit_cursor: Opaque.exactOptional() });
}
function committedEnvelope<D extends z.ZodType>(data: D) {
  return envelope(data).extend({ commit_cursor: Opaque });
}
function responseSchema<Output, Input, N extends readonly number[]>(
  success: z.ZodType<Output, Input>,
  statuses: N,
) {
  return z.union([
    z.strictObject({ kind: z.literal('success'), status: z.literal(statuses), body: success }),
    HttpError,
  ]);
}
export type JsonExchange<
  M extends 'GET' | 'POST',
  O extends string,
  P extends string,
  R extends z.ZodType,
  S extends z.ZodType,
  N extends readonly number[],
> = CheckedBinding<R, ReturnType<typeof responseSchema<z.output<S>, z.input<S>, N>>> &
  Readonly<{
    method: M;
    operationId: O;
    path: P;
    success: S;
    successStatuses: N;
    headers: typeof headers;
    requestMedia: string;
    responseMedia: string;
    transport: 'json';
    discovery: boolean;
    committed: boolean;
  }>;
export function exchange<
  const M extends 'GET' | 'POST',
  const O extends string,
  const P extends string,
  R extends z.ZodType,
  Output,
  Input,
  S extends z.ZodType<Output, Input>,
  const N extends readonly number[],
>(
  method: M,
  operationId: O,
  path: P,
  request: R,
  success: S & z.ZodType<Output, Input>,
  committed: boolean,
  statuses: N,
  checkSuccess: SuccessCheck<R, z.ZodType<Output, Input>>,
) {
  return Object.freeze({
    operationId,
    method,
    path,
    ...checked(
      contract(request),
      contract(responseSchema<Output, Input, N>(success, statuses), 'http_response'),
      (result, input, meta) => result.kind === 'error' || checkSuccess(input, result.body, meta),
    ),
    success,
    successStatuses: statuses,
    headers,
    requestMedia: 'application/json',
    responseMedia: 'application/json',
    transport: 'json' satisfies 'json',
    discovery: operationId === 'GetHealth',
    committed,
  });
}
export function post<
  const O extends string,
  const P extends string,
  R extends z.ZodType,
  D extends z.ZodType,
>(
  operationId: O,
  path: P,
  request: R,
  data: D,
  check: SuccessCheck<R, ReturnType<typeof envelope<D>>>,
): JsonExchange<'POST', O, P, R, ReturnType<typeof envelope<D>>, readonly [200]> {
  return exchange('POST', operationId, path, request, envelope(data), false, [200], check);
}
export function committedPost<
  const O extends string,
  const P extends string,
  R extends z.ZodType,
  D extends z.ZodType,
>(
  operationId: O,
  path: P,
  request: R,
  data: D,
  check: SuccessCheck<R, ReturnType<typeof committedEnvelope<D>>>,
): JsonExchange<'POST', O, P, R, ReturnType<typeof committedEnvelope<D>>, readonly [200]> {
  return exchange('POST', operationId, path, request, committedEnvelope(data), true, [200], check);
}
export function get<
  const O extends string,
  const P extends string,
  R extends z.ZodType,
  D extends z.ZodType,
>(
  operationId: O,
  path: P,
  request: R,
  data: D,
  check: SuccessCheck<R, ReturnType<typeof envelope<D>>>,
): JsonExchange<'GET', O, P, R, ReturnType<typeof envelope<D>>, readonly [200]> {
  return exchange('GET', operationId, path, request, envelope(data), false, [200], check);
}
type FirstPage = Exclude<HistoryQuery, Continuation>;
export function pageSize(
  request: Pick<FirstPage, 'page_size'> | Continuation | undefined,
  entries: readonly unknown[],
): boolean {
  return (
    request === undefined || 'page_token' in request || entries.length <= (request.page_size ?? 100)
  );
}
export function historyMatches(
  kind: 'asset' | 'observation' | 'track',
  request: HistoryQuery | undefined,
  data: HistoryPage,
): boolean {
  return (
    pageSize(request, data.readings) &&
    (request === undefined ||
      'page_token' in request ||
      (request.query_id === data.query_id &&
        data.readings.every((reading) =>
          kind === 'track'
            ? reading.track_ids.includes(request.entity_id)
            : reading.source_entity_kind === kind && reading.source_entity_id === request.entity_id,
        )))
  );
}

const empty = z.strictObject({});
const reference = get('GetReference', '/reference', empty, empty, () => true);
const referenceResult = z.strictObject({
  kind: z.literal('reference'),
  status: z.literal(200),
  media: z.enum(['application/vnd.oai.openapi+json', 'text/html']),
  document: text(4194304),
});
const contentRequest = z.strictObject({
  object_id: Uuid,
  disposition: z.enum(['inline', 'attachment']),
});
const contentResult = z.strictObject({
  kind: z.literal('content'),
  status: z.literal(200),
  descriptor: ContentDescriptor,
});
export const GetReferenceExchange = Object.freeze({
  ...reference,
  transport: 'reference',
  responseMedia: 'application/vnd.oai.openapi+json',
  ...checked(
    reference.request,
    contract(z.union([referenceResult, HttpError]), 'http_response'),
    () => true,
  ),
});
export const ReadObjectContentExchange = Object.freeze({
  operationId: 'ReadObjectContent',
  method: 'GET',
  path: '/objects/{object_id}/content',
  success: envelope(ContentDescriptor),
  successStatuses: [200] satisfies readonly [200],
  headers,
  requestMedia: 'application/json',
  transport: 'content',
  responseMedia: 'binary',
  discovery: false,
  committed: false,
  ...checked(
    contract(contentRequest),
    contract(z.union([contentResult, HttpError]), 'http_response'),
    (result, request) =>
      result.kind === 'error' ||
      (request !== undefined && result.descriptor.disposition === request.disposition),
  ),
  prepareContent(
    request: z.output<typeof contentRequest> | undefined,
    headers: ContentHeaders,
    status: number,
  ): unknown {
    if (request === undefined) throw new ProtocolError('invalid_http');
    return { kind: 'content', status, descriptor: { object_id: request.object_id, ...headers } };
  },
});

export const GetHealthExchange = get(
  'GetHealth',
  '/health',
  empty,
  HealthData,
  (_request, { data }, meta) => data.protocol_version === meta.protocolVersion,
);
export const GetReadinessExchange = exchange(
  'GET',
  'GetReadiness',
  '/readiness',
  empty,
  envelope(Readiness),
  false,
  [200, 503],
  (_request, { data }, meta) => data.ready === (meta.status === 200),
);
