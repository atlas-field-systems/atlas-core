import { z } from 'zod';
import { Counter, Integer, numeric, Opaque, text, Time, Timestamp, Uuid } from './scalars.js';

export const Operator = z
  .strictObject({
    operator_id: Uuid,
    name: text(256, true),
    description: text(4096).exactOptional(),
    edit_revision: Counter,
  })
  .meta({ id: 'Operator' });
export const ApiKey = z
  .strictObject({
    api_key_id: Uuid,
    operator_id: Uuid.nullable(),
    created_at: Timestamp,
    revoked_at: Time,
  })
  .meta({ id: 'ApiKey' });
export const ResourceUsage = z
  .strictObject({ kind: text(128, true), used: Counter, capacity: Counter })
  .meta({ id: 'ResourceUsage' });
export const Activity = z
  .strictObject({
    activity_id: Uuid,
    at: Timestamp,
    category: text(128, true),
    message: text(4096),
    api_key_id: Uuid.nullable(),
    operator_id: Uuid.nullable(),
    operator_deleted: z.boolean(),
  })
  .refine(
    (value) => value.operator_id !== null || !value.operator_deleted,
    'Deleted attribution without operator',
  )
  .meta({ id: 'Activity' });
export const MessageLimits = z
  .strictObject({
    max_request_bytes: numeric({ integer: true, min: 0, max: 1048576 }),
    max_request_json_values: numeric({ integer: true, min: 0, max: 65536 }),
    max_message_bytes: numeric({ integer: true, min: 0, max: 4194304 }),
    max_json_values: numeric({ integer: true, min: 0, max: 262144 }),
    max_changes: numeric({ integer: true, min: 0, max: 1000 }),
    max_control_bytes: numeric({ integer: true, min: 0, max: 16384 }),
    max_control_json_values: numeric({ integer: true, min: 0, max: 4096 }),
    max_json_depth: numeric({ integer: true, min: 0, max: 32 }),
    max_object_bytes: numeric({ integer: true, min: 0, max: 2000000000 }),
  })
  .meta({ id: 'MessageLimits' });
export const NegotiatedLimits = MessageLimits.pick({
  max_message_bytes: true,
  max_json_values: true,
  max_changes: true,
}).meta({ id: 'NegotiatedLimits' });
export const TemporaryLimits = z
  .strictObject({
    max_snapshot_captures: Integer,
    max_snapshot_captures_per_key: Integer,
    max_snapshot_bytes: Counter,
    max_total_snapshot_bytes: Counter,
    max_history_views: Integer,
    max_history_views_per_key: Integer,
    max_history_references_per_view: Integer,
    max_total_history_references: Integer,
    max_history_bytes: Counter,
    max_contact_challenges: Integer,
    max_allocation_receipts: Integer,
  })
  .meta({ id: 'TemporaryLimits' });
export const HealthData = z
  .strictObject({
    healthy: z.boolean(),
    protocol_version: Opaque,
    core_run_id: Uuid,
    limits: MessageLimits,
    temporary_limits: TemporaryLimits,
    allocation_context: Opaque,
    allocation_expires_at: Timestamp,
  })
  .meta({ id: 'HealthData' });
export const Readiness = z.strictObject({ ready: z.boolean() }).meta({ id: 'Readiness' });
export type Operator = z.output<typeof Operator>;
export type ApiKey = z.output<typeof ApiKey>;
export type ResourceUsage = z.output<typeof ResourceUsage>;
export type Activity = z.output<typeof Activity>;
export type MessageLimits = z.output<typeof MessageLimits>;
export type NegotiatedLimits = z.output<typeof NegotiatedLimits>;
export type TemporaryLimits = z.output<typeof TemporaryLimits>;
export type HealthData = z.output<typeof HealthData>;
export type Readiness = z.output<typeof Readiness>;
