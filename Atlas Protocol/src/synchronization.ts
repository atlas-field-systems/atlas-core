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
export const Put = z
  .discriminatedUnion('resource_kind', [
    z
      .strictObject({ ...putFields, resource_kind: z.literal('asset'), image: Asset })
      .refine(
        (value) => value.resource_id === value.image.id && value.version === value.image.version,
        'Put identity differs',
      ),
    z
      .strictObject({ ...putFields, resource_kind: z.literal('track'), image: Track })
      .refine(
        (value) => value.resource_id === value.image.id && value.version === value.image.version,
        'Put identity differs',
      ),
    z
      .strictObject({ ...putFields, resource_kind: z.literal('geofeature'), image: Geofeature })
      .refine(
        (value) => value.resource_id === value.image.id && value.version === value.image.version,
        'Put identity differs',
      ),
    z
      .strictObject({ ...putFields, resource_kind: z.literal('task'), image: Task })
      .refine(
        (value) =>
          value.resource_id === value.image.task_id && value.version === value.image.version,
        'Put identity differs',
      ),
    z
      .strictObject({ ...putFields, resource_kind: z.literal('object'), image: ObjectImage })
      .refine(
        (value) =>
          value.resource_id === value.image.object_id && value.version === value.image.version,
        'Put identity differs',
      ),
  ])
  .meta({ id: 'Put' });
export const Delete = z
  .strictObject({
    kind: z.literal('delete'),
    resource_kind: ResourceKind,
    resource_id: Uuid,
    version: Counter,
  })
  .meta({ id: 'Delete' });
export const Change = z.union([Put, Delete]).meta({ id: 'Change' });
const changeKey = (value: z.output<typeof Change>) => `${value.resource_kind}:${value.resource_id}`;
export const Changes = z
  .array(Change)
  .min(1)
  .max(1000)
  .refine((values) => unique(values, changeKey), 'Duplicate change');
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
export const SnapshotPage = z
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
export const ReplayBatch = z
  .strictObject({
    type: z.literal('change_batch'),
    data: z.strictObject({ previous_cursor: Opaque, commit_cursor: Opaque, changes: Changes }),
  })
  .meta({ id: 'ReplayBatch' });
export const ReplayProgress = z
  .strictObject({
    type: z.literal('progress'),
    data: z.strictObject({ previous_cursor: Opaque, through_cursor: Opaque }),
  })
  .meta({ id: 'ReplayProgress' });
export const ReplayMessage = z
  .discriminatedUnion('type', [ReplayBatch, ReplayProgress])
  .meta({ id: 'ReplayMessage' });
export const ReadChanges = z
  .union([z.strictObject({ from_cursor: Opaque, ...negotiation }), Continuation])
  .meta({ id: 'ReadChanges' });
export const ReplayPage = z
  .strictObject({
    replay_boundary: Opaque,
    messages: z.array(ReplayMessage).max(1000),
    through_cursor: Opaque,
    next_page_token: Opaque.nullable(),
  })
  .refine(
    (value) =>
      value.messages.every((message, index) => {
        const prior = value.messages[index - 1];
        return (
          !prior ||
          message.data.previous_cursor ===
            (prior.type === 'change_batch' ? prior.data.commit_cursor : prior.data.through_cursor)
        );
      }),
    'Replay gap',
  )
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
export const ClientFrame = z
  .discriminatedUnion('type', [
    Authenticate,
    control('read_snapshot', ReadSnapshot),
    control('read_changes', ReadChanges),
    control('release_snapshot', Release),
    control('subscribe_changes', SubscribeChanges),
    control('unsubscribe_changes', UnsubscribeChanges),
  ])
  .meta({ id: 'ClientFrame' });
const liveBatch = event(
  'change_batch',
  z.strictObject({ ...ReplayBatch.shape.data.shape, subscription_id: Uuid }),
);
const liveProgress = event(
  'progress',
  z.strictObject({ ...ReplayProgress.shape.data.shape, subscription_id: Uuid }),
);
export const ServerFrame = z
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
      request_id: NewId.optional(),
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
