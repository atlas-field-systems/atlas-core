import { z } from 'zod';
import { NewId, Opaque, text, Uuid } from './scalars.js';

const base = { message: text(1024), request_id: NewId };
const empty = z.strictObject({}).exactOptional();
const error400 = z.strictObject({
  ...base,
  code: z.enum(['invalid_request', 'dataset_required']),
  details: empty,
});
const error401 = z.strictObject({ ...base, code: z.literal('unauthorized'), details: empty });
const error404 = z.strictObject({
  ...base,
  code: z.enum(['asset_not_found', 'entity_not_found', 'operator_not_found']),
  details: empty,
});
const error409 = z.union([
  z.strictObject({
    ...base,
    code: z.enum([
      'counter_exhausted',
      'allocation_conflict',
      'generation_mismatch',
      'challenge_context_mismatch',
      'challenge_consumed',
      'queue_changed',
      'cancellation_pending',
      'evidence_conflict',
      'cancellation_changed',
      'terminal_state_conflict',
      'control_not_confirmed',
      'report_identity_conflict',
      'section_sequence_conflict',
      'constituent_conflict',
      'identity_conflict',
      'edit_conflict',
      'object_held',
    ]),
    details: empty,
  }),
  z.strictObject({
    ...base,
    code: z.literal('protocol_mismatch'),
    details: z.strictObject({ protocol_version: Opaque }).exactOptional(),
  }),
  z.strictObject({
    ...base,
    code: z.literal('dataset_mismatch'),
    details: z.strictObject({ dataset_id: Uuid }).exactOptional(),
  }),
]);
const error410 = z.union([
  z.strictObject({
    ...base,
    code: z.enum(['allocation_expired', 'challenge_expired', 'operator_deleted']),
    details: empty,
  }),
  z.strictObject({
    ...base,
    code: z.literal('cursor_expired'),
    details: z.strictObject({ earliest_recoverable_cursor: Opaque }),
  }),
]);
const error413 = z.strictObject({ ...base, code: z.literal('payload_too_large'), details: empty });
const error422 = z.strictObject({
  ...base,
  code: z.enum([
    'invalid_geometry',
    'unsupported_geometry',
    'geometry_limit_exceeded',
    'unsupported_filter',
    'unsupported_command',
  ]),
  details: empty,
});
const error429 = z.strictObject({
  ...base,
  code: z.enum(['resource_limit', 'contact_busy']),
  details: empty,
});
const error500 = z.strictObject({ ...base, code: z.literal('integrity_fault'), details: empty });
const error507 = z.strictObject({ ...base, code: z.literal('storage_limit'), details: empty });
export const errorCatalog = Object.freeze({
  400: error400,
  401: error401,
  404: error404,
  409: error409,
  410: error410,
  413: error413,
  422: error422,
  429: error429,
  500: error500,
  507: error507,
});
export const ErrorObject = z
  .union([
    error400,
    error401,
    error404,
    error409,
    error410,
    error413,
    error422,
    error429,
    error500,
    error507,
  ])
  .meta({ id: 'ErrorObject' });
export function errorEnvelope<S extends z.ZodType>(error: S) {
  return z.strictObject({ dataset_id: Uuid, error });
}
function reply<const N extends number, S extends z.ZodType>(status: N, error: S) {
  return z.strictObject({
    kind: z.literal('error'),
    status: z.literal(status),
    body: errorEnvelope(error),
  });
}
const HttpErrorDefinition = z
  .union([
    reply(400, error400),
    reply(401, error401),
    reply(404, error404),
    reply(409, error409),
    reply(410, error410),
    reply(413, error413),
    reply(422, error422),
    reply(429, error429),
    reply(500, error500),
    reply(507, error507),
  ])
  .meta({ id: 'HttpError' });
export type ErrorObject = z.output<typeof ErrorObject>;

export type HttpError = z.output<typeof HttpErrorDefinition>;
export const HttpError: z.ZodType<HttpError> = HttpErrorDefinition;
