import { z } from 'zod';
import { Counter, NewId, Sequence, text, Time, Timestamp, Uuid, uniqueArray } from './scalars.js';
import { commandCatalog } from './commands.js';
import { AssetOrigin } from './reports.js';
import { orderedTimes } from './history.js';
function counterAtMost(left: string, right: string): boolean {
  return left.length < right.length || (left.length === right.length && left <= right);
}

export const ExecutionState = z.enum([
  'pending',
  'acknowledged',
  'in_progress',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);
export const NonterminalState = z.enum(['pending', 'acknowledged', 'in_progress', 'paused']);
export const ResultDeclaration = z
  .strictObject({ object_id: Uuid, required: z.boolean() })
  .meta({ id: 'ResultDeclaration' });
export const ResultDeclarations = z
  .array(ResultDeclaration)
  .max(128)
  .refine(
    (values) => new Set(values.map((value) => value.object_id)).size === values.length,
    'Duplicate declaration',
  );
const taskFields = {
  dataset_id: Uuid,
  task_id: Uuid,
  request_id: NewId,
  asset_id: Uuid,
  version: Counter,
  accepted_at: Timestamp,
  submission_sequence: Sequence,
  result_declarations: ResultDeclarations,
};
function taskVariants<S extends z.ZodRawShape>(command: S) {
  return z.union([
    z.strictObject({
      ...command,
      ...taskFields,
      execution_state: NonterminalState,
      cancellation_request_id: NewId.nullable(),
    }),
    z.strictObject({
      ...command,
      ...taskFields,
      execution_state: z.enum(['completed', 'failed', 'cancelled']),
      cancellation_request_id: z.null(),
    }),
  ]);
}
const TaskDefinition = z
  .union([
    taskVariants(commandCatalog.move_to.shape),
    taskVariants(commandCatalog.pause.shape),
    taskVariants(commandCatalog.resume.shape),
  ])
  .meta({ id: 'Task' });
export const TaskQueue = z
  .strictObject({
    requested_task_ids: uniqueArray(Uuid),
    revision: Counter,
    confirmed: z.strictObject({ revision: Counter, process_generation: Uuid }).nullable(),
  })
  .refine(
    (value) => value.confirmed === null || counterAtMost(value.confirmed.revision, value.revision),
    'Future queue confirmation',
  )
  .meta({ id: 'TaskQueue' });
export const TaskControl = z
  .strictObject({
    revision: Counter,
    requested: z
      .discriminatedUnion('command', [
        z.strictObject({ task_id: Uuid, command: z.literal('pause'), expires_at: z.null() }),
        z.strictObject({ task_id: Uuid, command: z.literal('resume'), expires_at: Timestamp }),
      ])
      .nullable(),
    confirmed: z
      .strictObject({
        revision: Counter,
        task_id: Uuid,
        process_generation: Uuid,
        queue_state: z.enum(['paused', 'running']),
      })
      .nullable(),
  })
  .refine(
    (value) => (value.revision === '0') === (value.requested === null),
    'Control request missing',
  )
  .refine(
    (value) =>
      value.confirmed === null ||
      (value.confirmed.revision !== '0' && counterAtMost(value.confirmed.revision, value.revision)),
    'Future control confirmation',
  )
  .refine(
    (value) =>
      !value.confirmed ||
      value.confirmed.revision !== value.revision ||
      (value.requested?.task_id === value.confirmed.task_id &&
        value.confirmed.queue_state ===
          (value.requested.command === 'pause' ? 'paused' : 'running')),
    'Control confirmation differs',
  )
  .meta({ id: 'TaskControl' });

const executionFields = { task_id: Uuid, message: text(1024).exactOptional() };
const geometryRevision = { geometry_revision: Counter.exactOptional() };
const controlEffect = { control_revision: Counter, applied_at: Timestamp };
const resumeEffect = z
  .strictObject({
    ...executionFields,
    event: z.literal('state'),
    state: z.literal('completed'),
    ...controlEffect,
    queue_state: z.literal('running'),
    read_id: NewId,
    core_run_id: Uuid,
    captured_at: Timestamp,
    instructions_valid_until: Timestamp,
    queue_revision: Counter,
  })
  .refine(
    (value) =>
      orderedTimes(value.captured_at, value.applied_at, true) &&
      orderedTimes(value.applied_at, value.instructions_valid_until),
    'Resume outside observed instruction interval',
  );
export const ExecutionPayload = z
  .union([
    z.strictObject({
      ...executionFields,
      ...geometryRevision,
      event: z.literal('state'),
      state: z.enum(['acknowledged', 'in_progress', 'paused']),
    }),
    z.strictObject({
      ...executionFields,
      ...geometryRevision,
      event: z.literal('state'),
      state: z.literal('failed'),
      reason: text(64, true),
    }),
    z.strictObject({
      ...executionFields,
      ...geometryRevision,
      event: z.literal('state'),
      state: z.literal('cancelled'),
      cancellation_request_id: NewId,
    }),
    z.strictObject({
      ...executionFields,
      ...geometryRevision,
      event: z.literal('state'),
      state: z.literal('completed'),
    }),
    z.strictObject({
      ...executionFields,
      event: z.literal('state'),
      state: z.literal('completed'),
      ...controlEffect,
      queue_state: z.literal('paused'),
    }),
    resumeEffect,
    z.strictObject({
      ...executionFields,
      ...geometryRevision,
      event: z.literal('cancellation_refused'),
      state: NonterminalState,
      cancellation_request_id: NewId,
      reason: text(64, true),
    }),
  ])
  .meta({ id: 'ExecutionPayload' });
export function executionEvidence<P extends z.ZodType>(payload: P) {
  return z.strictObject({
    dataset_id: Uuid,
    asset_id: Uuid,
    origin: AssetOrigin,
    report_id: NewId,
    sequence: Sequence,
    generated_at: Time,
    payload,
  });
}
export const ExecutionEvidence = executionEvidence(ExecutionPayload).meta({
  id: 'ExecutionEvidence',
});
export const ReportTaskExecution = z
  .strictObject({ evidence: ExecutionEvidence })
  .meta({ id: 'ReportTaskExecution' });
const declarationBatch = z
  .array(ResultDeclaration)
  .min(1)
  .max(128)
  .refine((values) => {
    const flags = new Map<string, boolean>();
    for (const value of values) {
      if (flags.has(value.object_id) && flags.get(value.object_id) !== value.required) return false;
      flags.set(value.object_id, value.required);
    }
    return true;
  }, 'Conflicting declaration');
export const ReportTaskResults = z
  .strictObject({
    evidence: executionEvidence(z.strictObject({ task_id: Uuid, declarations: declarationBatch })),
  })
  .meta({ id: 'ReportTaskResults' });
export const QueueConfirmation = z
  .union([
    z.strictObject({ queue_revision: Counter }),
    z.strictObject({
      queue_revision: Counter,
      control_revision: Counter,
      queue_state: z.enum(['paused', 'running']),
    }),
  ])
  .meta({ id: 'QueueConfirmation' });
export const ConfirmTaskOrder = z
  .strictObject({ evidence: executionEvidence(QueueConfirmation) })
  .meta({ id: 'ConfirmTaskOrder' });
export type Task = z.output<typeof TaskDefinition>;
export const Task: z.ZodType<Task> = TaskDefinition;
export type TaskQueue = z.output<typeof TaskQueue>;
export type TaskControl = z.output<typeof TaskControl>;
export type ExecutionState = z.output<typeof ExecutionState>;
export type NonterminalState = z.output<typeof NonterminalState>;
export type ResultDeclaration = z.output<typeof ResultDeclaration>;
export type ResultDeclarations = z.output<typeof ResultDeclarations>;
export type ExecutionPayload = z.output<typeof ExecutionPayload>;
export type ExecutionEvidence = z.output<typeof ExecutionEvidence>;
export type ReportTaskExecution = z.output<typeof ReportTaskExecution>;
export type ReportTaskResults = z.output<typeof ReportTaskResults>;
export type QueueConfirmation = z.output<typeof QueueConfirmation>;
export type ConfirmTaskOrder = z.output<typeof ConfirmTaskOrder>;
