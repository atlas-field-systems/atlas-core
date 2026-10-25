import { z } from 'zod';
import {
  Counter,
  NewId,
  Opaque,
  ordered,
  PageSize,
  Secret,
  Timestamp,
  Uuid,
  unique,
} from './scalars.js';
import { Asset, Geofeature, Track } from './entities.js';
import { Task } from './tasks.js';
import { ObjectImage } from './objects.js';
import { NegotiatedLimits } from './administration.js';
import { Continuation, Release, Released } from './history.js';
import { ErrorObject } from './errors.js';
import { contract } from './json.js';

export const ResourceKind = z.enum(['asset', 'track', 'geofeature', 'task', 'object']);
const putFields = { kind: z.literal('put'), resource_id: Uuid, version: Counter };
const PutDefinition = z
  .discriminatedUnion('resource_kind', [
    z.strictObject({ ...putFields, resource_kind: z.literal('asset'), image: Asset }),
    z.strictObject({ ...putFields, resource_kind: z.literal('track'), image: Track }),
    z.strictObject({ ...putFields, resource_kind: z.literal('geofeature'), image: Geofeature }),
    z.strictObject({ ...putFields, resource_kind: z.literal('task'), image: Task }),
    z.strictObject({ ...putFields, resource_kind: z.literal('object'), image: ObjectImage }),
  ])
  .refine(
    (value) =>
      value.version === value.image.version &&
      value.resource_id ===
        (value.resource_kind === 'task'
          ? value.image.task_id
          : value.resource_kind === 'object'
            ? value.image.object_id
            : value.image.id),
    'Put identity differs',
  )
  .meta({ id: 'Put' });
type PutDefinitionSchema = typeof PutDefinition;
export interface PutSchema extends PutDefinitionSchema {}
export const Put: PutSchema = PutDefinition;
export const Delete = z
  .strictObject({
    kind: z.literal('delete'),
    resource_kind: z.enum(['asset', 'geofeature', 'object']),
    resource_id: Uuid,
    version: Counter,
  })
  .meta({ id: 'Delete' });
export const Change = z.union([Put, Delete]).meta({ id: 'Change' });
const changeKey = (value: z.output<typeof Change>) => `${value.resource_kind}:${value.resource_id}`;
const ChangesDefinition = z
  .array(Change)
  .min(1)
  .max(1000)
  .refine((values) => unique(values, changeKey), 'Duplicate change');
type ChangesDefinitionSchema = typeof ChangesDefinition;
export interface ChangesSchema extends ChangesDefinitionSchema {}
export const Changes: ChangesSchema = ChangesDefinition;
const negotiation = NegotiatedLimits.shape;
export const ReadSnapshot = z
  .union([
    z.strictObject({
      allocation_context: Opaque,
      load_id: NewId,
      page_size: PageSize,
      ...negotiation,
    }),
    Continuation,
  ])
  .meta({ id: 'ReadSnapshot' });
const SnapshotPageDefinition = z
  .strictObject({
    load_id: Uuid,
    capture_id: Uuid,
    baseline_cursor: Opaque,
    expires_at: Timestamp,
    limits: NegotiatedLimits,
    items: z
      .array(Put)
      .max(1000)
      .refine((values) => unique(values, changeKey), 'Duplicate item'),
    next_page_token: Opaque.nullable(),
    release_token: Opaque,
  })
  .refine(
    (value) => value.items.length <= value.limits.max_changes && ordered(value.items, changeKey),
    'Snapshot order or negotiated changes differ',
  )
  .meta({ id: 'SnapshotPage' });
type SnapshotPageDefinitionSchema = typeof SnapshotPageDefinition;
export interface SnapshotPageSchema extends SnapshotPageDefinitionSchema {}
export const SnapshotPage: SnapshotPageSchema = SnapshotPageDefinition;
const ChangeBatchData = z
  .strictObject({ previous_cursor: Opaque, commit_cursor: Opaque, changes: Changes })
  .refine((value) => value.previous_cursor !== value.commit_cursor, 'Batch cursor did not advance');
const ReplayBatchDefinition = z
  .strictObject({
    type: z.literal('change_batch'),
    data: ChangeBatchData,
  })
  .meta({ id: 'ReplayBatch' });
type ReplayBatchDefinitionSchema = typeof ReplayBatchDefinition;
export interface ReplayBatchSchema extends ReplayBatchDefinitionSchema {}
export const ReplayBatch: ReplayBatchSchema = ReplayBatchDefinition;
export const ReplayProgress = z
  .strictObject({
    type: z.literal('progress'),
    data: z.strictObject({ previous_cursor: Opaque, through_cursor: Opaque }),
  })
  .meta({ id: 'ReplayProgress' });
const ReplayMessageDefinition = z
  .discriminatedUnion('type', [ReplayBatch, ReplayProgress])
  .meta({ id: 'ReplayMessage' });
type ReplayMessageDefinitionSchema = typeof ReplayMessageDefinition;
export interface ReplayMessageSchema extends ReplayMessageDefinitionSchema {}
export const ReplayMessage: ReplayMessageSchema = ReplayMessageDefinition;
export const ReadChanges = z
  .union([z.strictObject({ from_cursor: Opaque, ...negotiation }), Continuation])
  .meta({ id: 'ReadChanges' });
const maxReplayMessages = 1000;
const ReplayPageDefinition = z
  .strictObject({
    replay_boundary: Opaque,
    messages: z.array(ReplayMessage).max(maxReplayMessages),
    through_cursor: Opaque,
    next_page_token: Opaque.nullable(),
  })
  .refine((value) => {
    if (value.messages.length > maxReplayMessages) return false;
    const first = value.messages[0];
    if (!first) return true;
    let cursor = first.data.previous_cursor;
    const visited = new Set([cursor]);
    for (const message of value.messages) {
      const next =
        message.type === 'change_batch' ? message.data.commit_cursor : message.data.through_cursor;
      if (message.data.previous_cursor !== cursor || (next !== cursor && visited.has(next)))
        return false;
      visited.add(next);
      cursor = next;
    }
    return true;
  }, 'Replay gap or cursor cycle')
  .refine((value) => {
    const last = value.messages[value.messages.length - 1];
    return (
      !last ||
      value.through_cursor ===
        (last.type === 'change_batch' ? last.data.commit_cursor : last.data.through_cursor)
    );
  }, 'Replay through cursor differs')
  .refine(
    (value) => value.next_page_token !== null || value.through_cursor === value.replay_boundary,
    'Replay incomplete at boundary',
  )
  .meta({ id: 'ReplayPage' });
type ReplayPageDefinitionSchema = typeof ReplayPageDefinition;
export interface ReplayPageSchema extends ReplayPageDefinitionSchema {}
export const ReplayPage: ReplayPageSchema = ReplayPageDefinition;
export const SubscribeChanges = z
  .strictObject({ subscription_id: NewId, from_cursor: Opaque, ...negotiation })
  .meta({ id: 'SubscribeChanges' });
export const UnsubscribeChanges = z
  .strictObject({ subscription_id: Uuid })
  .meta({ id: 'UnsubscribeChanges' });
export const Subscribed = z
  .strictObject({ subscription_id: Uuid, handoff_cursor: Opaque, limits: NegotiatedLimits })
  .meta({ id: 'Subscribed' });
export const Unsubscribed = z.strictObject({ subscription_id: Uuid }).meta({ id: 'Unsubscribed' });
const context = { dataset_id: Uuid, protocol_version: Opaque };
function control<const T extends string, S extends z.ZodType>(type: T, data: S) {
  return z.strictObject({ type: z.literal(type), ...context, request_id: NewId, data });
}
function event<const T extends string, S extends z.ZodType>(type: T, data: S) {
  return z.strictObject({ type: z.literal(type), ...context, data });
}
export const Authenticate = z
  .strictObject({ type: z.literal('authenticate'), request_id: NewId, ...context, api_key: Secret })
  .meta({ id: 'Authenticate' });
const ClientFrameDefinition = z
  .discriminatedUnion('type', [
    Authenticate,
    control('read_snapshot', ReadSnapshot),
    control('read_changes', ReadChanges),
    control('release_snapshot', Release),
    control('subscribe_changes', SubscribeChanges),
    control('unsubscribe_changes', UnsubscribeChanges),
  ])
  .meta({ id: 'ClientFrame' });
type ClientFrameDefinitionSchema = typeof ClientFrameDefinition;
export interface ClientFrameSchema extends ClientFrameDefinitionSchema {}
export const ClientFrame: ClientFrameSchema = ClientFrameDefinition;
const liveBatch = event('change_batch', ChangeBatchData.safeExtend({ subscription_id: Uuid }));
const liveProgress = event(
  'progress',
  z.strictObject({ ...ReplayProgress.shape.data.shape, subscription_id: Uuid }),
);
const ServerFrameDefinition = z
  .discriminatedUnion('type', [
    control('authenticated', z.strictObject({ core_run_id: Uuid, limits: NegotiatedLimits })),
    control('read_snapshot_result', SnapshotPage),
    control('read_changes_result', ReplayPage),
    control('snapshot_released', Released),
    control('subscribed', Subscribed),
    control('unsubscribed', Unsubscribed),
    liveBatch,
    liveProgress,
    event('handoff_complete', z.strictObject({ subscription_id: Uuid, handoff_cursor: Opaque })),
    event(
      'gap',
      z.strictObject({
        subscription_id: Uuid,
        reason: z.enum(['cursor_expired', 'resource_limit', 'limits_changed']),
        earliest_recoverable_cursor: Opaque,
      }),
    ),
    z.strictObject({
      type: z.literal('error'),
      ...context,
      request_id: NewId.exactOptional(),
      error: ErrorObject,
    }),
  ])
  .refine((frame) => {
    const matches = (put: z.output<typeof Put>) => put.image.dataset_id === frame.dataset_id;
    if (frame.type === 'change_batch')
      return frame.data.changes.every((change) => change.kind === 'delete' || matches(change));
    if (frame.type === 'read_snapshot_result') return frame.data.items.every(matches);
    if (frame.type === 'read_changes_result')
      return frame.data.messages.every(
        (message) =>
          message.type !== 'change_batch' ||
          message.data.changes.every((change) => change.kind === 'delete' || matches(change)),
      );
    return true;
  }, 'Frame Dataset differs')
  .meta({ id: 'ServerFrame' });
type ServerFrameDefinitionSchema = typeof ServerFrameDefinition;
export interface ServerFrameSchema extends ServerFrameDefinitionSchema {}
export const ServerFrame: ServerFrameSchema = ServerFrameDefinition;
export const wss = Object.freeze({
  clientFrame: contract(ClientFrame, 'wss_control'),
  serverFrame: {
    ...contract(ServerFrame, 'wss_data'),
    controlTypes: [
      'authenticated',
      'snapshot_released',
      'subscribed',
      'unsubscribed',
      'handoff_complete',
      'gap',
      'error',
    ],
    messageLimits: { path: ['data', 'limits'], frameType: 'read_snapshot_result' },
  },
});
export type ServerFrame = z.output<typeof ServerFrame>;
export type ClientFrame = z.output<typeof ClientFrame>;
export type ResourceKind = z.output<typeof ResourceKind>;
export type Put = z.output<typeof Put>;
export type Delete = z.output<typeof Delete>;
export type Change = z.output<typeof Change>;
export type Changes = z.output<typeof Changes>;
export type ReadSnapshot = z.output<typeof ReadSnapshot>;
export type SnapshotPage = z.output<typeof SnapshotPage>;
export type ReplayBatch = z.output<typeof ReplayBatch>;
export type ReplayProgress = z.output<typeof ReplayProgress>;
export type ReplayMessage = z.output<typeof ReplayMessage>;
export type ReadChanges = z.output<typeof ReadChanges>;
export type ReplayPage = z.output<typeof ReplayPage>;
export type SubscribeChanges = z.output<typeof SubscribeChanges>;
export type UnsubscribeChanges = z.output<typeof UnsubscribeChanges>;
export type Subscribed = z.output<typeof Subscribed>;
export type Unsubscribed = z.output<typeof Unsubscribed>;
export type Authenticate = z.output<typeof Authenticate>;
