import { ErrorObject, HttpError, ProtocolError, PROTOCOL_VERSION } from '@atlas/protocol';
import { z } from 'zod';
import type { Uuid } from '@atlas/protocol';
import { id } from './exact.js';

export type Code = ErrorObject['code'];
const statuses: Record<Code, HttpError['status']> = {
  invalid_request: 400, dataset_required: 400, unauthorized: 401,
  asset_not_found: 404, entity_not_found: 404, operator_not_found: 404,
  protocol_mismatch: 409, dataset_mismatch: 409, counter_exhausted: 409,
  allocation_conflict: 409, generation_mismatch: 409, challenge_context_mismatch: 409,
  challenge_consumed: 409, queue_changed: 409, cancellation_pending: 409,
  evidence_conflict: 409, cancellation_changed: 409, terminal_state_conflict: 409,
  control_not_confirmed: 409, report_identity_conflict: 409, section_sequence_conflict: 409,
  constituent_conflict: 409, identity_conflict: 409, edit_conflict: 409, object_held: 409,
  cursor_expired: 410, allocation_expired: 410, challenge_expired: 410, operator_deleted: 410,
  payload_too_large: 413, invalid_geometry: 422, unsupported_geometry: 422,
  geometry_limit_exceeded: 422, unsupported_filter: 422, unsupported_command: 422,
  resource_limit: 429, contact_busy: 429, integrity_fault: 500, storage_limit: 507,
};
export class Refusal extends Error {
  constructor(readonly code: Code, readonly details?: ErrorObject['details']) { super(code); }
}
export function refuse(code: Code, details?: ErrorObject['details']): never { throw new Refusal(code, details); }
export function publicError(error: unknown, dataset: Uuid, requestId = id()): HttpError {
  for (let depth = 0; error instanceof AggregateError && depth < 8; depth++) error = error.errors[0];
  let code: Code = 'integrity_fault';
  let details: ErrorObject['details'];
  if (error instanceof Refusal) { code = error.code; details = error.details; }
  else if (error instanceof ProtocolError) {
    switch (error.code) {
      case 'payload_too_large': case 'resource_limit': case 'invalid_geometry':
      case 'unsupported_geometry': case 'geometry_limit_exceeded': code = error.code; break;
      default: code = 'invalid_request';
    }
  } else if (error instanceof RangeError && error.message === 'counter_exhausted') code = 'counter_exhausted';
  else if (error instanceof Error && 'code' in error && ['ENOSPC', 'EDQUOT', 'SQLITE_FULL'].includes(String(error.code))) code = 'storage_limit';
  if (code === 'protocol_mismatch') details = { protocol_version: PROTOCOL_VERSION };
  if (code === 'dataset_mismatch') details = { dataset_id: dataset };
  return HttpError.parse({ kind: 'error', status: statuses[code], body: { dataset_id: dataset,
    error: { code, message: code.replaceAll('_', ' '), request_id: requestId,
      ...(details === undefined ? {} : { details }) } } });
}
export const WorkerFailure = z.strictObject({ error: HttpError, causes: z.tuple([HttpError, HttpError]).optional() });
export function workerFailure(error: unknown, dataset: Uuid): z.infer<typeof WorkerFailure> {
  const failure: z.infer<typeof WorkerFailure> = { error: publicError(error, dataset) };
  if (error instanceof AggregateError && error.errors.length >= 2) {
    failure.causes = [publicError(error.errors[0], dataset), publicError(error.errors[1], dataset)];
  }
  return failure;
}
