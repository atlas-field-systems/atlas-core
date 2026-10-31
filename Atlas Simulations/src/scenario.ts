import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Alias, Altitude, Position, ExecutionState, contract, readJson } from '@atlas/protocol';

export const faultIds = [
  'reply-lost',
  'reply-delayed',
  'reply-altered',
  'connections-closed',
  'version-mismatch',
  'malformed-request',
  'core-restart',
  'core-kill',
  'core-drain',
  'core-reset',
  'storage-pressure',
  'task-limit',
  'request-too-large',
  'sync-connection-limit',
  'slow-consumer',
  'replay-expired',
  'picture-capacity',
  'key-revoked',
  'key-rotated',
  'process-obsolete',
  'challenge-expired',
  'contact-expiry',
  'cancel-race',
  'cancel-held',
  'cancel-refused',
  'pause-empty',
  'resume-expired',
  'resume-superseded',
  'queue-changed',
  'reorder-stale',
  'terminal-conflict',
  'asset-deleted',
  'geofeature-edited',
  'report-replayed',
  'sequence-conflict',
  'execution-conflict',
  'late-position',
  'future-time',
  'tags-refused',
  'tags-cleared',
  'tags-history-only',
] as const;
export const FaultId = z.enum(faultIds);
export type FaultId = z.infer<typeof FaultId>;
const alias = Alias.refine(
  (s) => Alias.safeParse(`${s} a1b2`).success,
  'Alias must leave room for run suffix',
);
const at = z.number().finite().min(0).max(3600);
const index = z.number().int().min(0).max(9999);
const actionBase = { at_seconds: at, asset: alias };
const faults = faultIds.map((id) =>
  z.strictObject({
    at_seconds: at,
    action: z.literal('fault'),
    id: z.literal(id),
    asset: alias.optional(),
    write_kind: z.enum(['telemetry', 'tags', 'execution', 'observation']).optional(),
  }),
);
export const TimelineAction = z.union([
  z.strictObject({
    ...actionBase,
    action: z.literal('move_to'),
    position: Position,
    altitude: Altitude.optional(),
  }),
  z.strictObject({
    ...actionBase,
    action: z.literal('move_to'),
    geofeature: alias,
    altitude: Altitude.optional(),
  }),
  z.strictObject({ ...actionBase, action: z.literal('pause') }),
  z.strictObject({ ...actionBase, action: z.literal('resume') }),
  z.strictObject({ ...actionBase, action: z.literal('cancel'), index }),
  z.strictObject({
    ...actionBase,
    action: z.literal('reorder'),
    indexes: z.array(index).max(1000),
  }),
  ...faults,
]);
export type TimelineAction = z.infer<typeof TimelineAction>;
export const Scenario = z
  .strictObject({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    assets: z
      .array(
        z.strictObject({
          alias,
          position: Position,
          cruise_speed: z.number().positive().max(1e7),
          detection_radius: z.number().min(0).max(2e7),
        }),
      )
      .min(1)
      .max(100),
    subjects: z
      .array(
        z.strictObject({
          alias,
          route: z.array(Position).min(1).max(1000),
          speed: z.number().positive().max(1e7),
        }),
      )
      .max(1000),
    geofeatures: z
      .array(z.strictObject({ alias, position: Position }))
      .max(1000)
      .optional(),
    timeline: z.array(TimelineAction).max(10000).optional(),
    deadline_seconds: z.number().positive().max(3600).optional(),
    expect: z
      .strictObject({
        tasks: z.array(z.strictObject({ asset: alias, index, state: ExecutionState })).max(10000),
        tracks: z.number().int().min(0).max(100000),
        removed_assets: z.array(alias).max(100).optional(),
      })
      .optional(),
  })
  .superRefine((s, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    const aliases = [...s.assets, ...s.subjects, ...(s.geofeatures ?? [])].map((a) => a.alias);
    if (new Set(aliases).size !== aliases.length) fail('Duplicate alias');
    const assets = new Set(s.assets.map((a) => a.alias));
    const features = new Set(s.geofeatures?.map((a) => a.alias));
    const moves = new Map<string, number>();
    let previous = 0;
    for (const [i, a] of (s.timeline ?? []).entries()) {
      if (a.at_seconds < previous) fail('Unsorted timeline');
      previous = a.at_seconds;
      if (a.asset !== undefined && !assets.has(a.asset)) fail('Unknown Asset');
      if (a.action === 'move_to') {
        if ('geofeature' in a && !features.has(a.geofeature)) fail('Unknown Geofeature');
        moves.set(a.asset, (moves.get(a.asset) ?? 0) + 1);
      }
      if (a.action === 'cancel' && a.index >= (moves.get(a.asset) ?? 0)) fail('Unknown Task index');
      if (
        a.action === 'reorder' &&
        (new Set(a.indexes).size !== a.indexes.length ||
          a.indexes.some((j) => j >= (moves.get(a.asset) ?? 0)))
      )
        fail('Invalid reorder indexes');
      if (a.action === 'fault' && a.id === 'core-reset' && i !== (s.timeline ?? []).length - 1)
        fail('Reset must be last');
    }
    for (const e of s.expect?.tasks ?? [])
      if (!assets.has(e.asset) || e.index >= (moves.get(e.asset) ?? 0))
        fail('Unknown expected Task');
    for (const a of s.expect?.removed_assets ?? [])
      if (!assets.has(a)) fail('Unknown removed Asset');
    if ([s.timeline, s.deadline_seconds, s.expect].filter((v) => v !== undefined).length % 3)
      fail('Eval requires timeline, deadline and expect together');
  });
export type Scenario = z.infer<typeof Scenario>;
export async function loadScenario(path: string): Promise<{ scenario: Scenario; sha256: string }> {
  const file = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(1048577);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > 1048576) throw new Error('Scenario exceeds 1 MiB');
    const data = bytes.subarray(0, length);
    const scenario = readJson(contract(Scenario), data, {
      maxBytes: 1048576,
      maxDepth: 32,
      maxValues: 1000000,
    });
    return { scenario, sha256: createHash('sha256').update(data).digest('hex') };
  } finally {
    await file.close();
  }
}
