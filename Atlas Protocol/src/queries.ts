import { z } from 'zod';
import { Alias, Opaque, ordered, PageSize, text, Uuid, uniqueArray } from './scalars.js';
import { ContentType } from './objects.js';
import { GeofeatureKind, Health, SubjectKind } from './components.js';
import { ExecutionState } from './tasks.js';
import { Continuation } from './history.js';

const ids = uniqueArray(Uuid).optional();
const base = { ids, aliases: uniqueArray(Alias).optional() };
export const filters = {
  assets: z.strictObject({
    ...base,
    kinds: uniqueArray(
      z.enum(['drone', 'security_camera', 'tracker', 'other']).nullable(),
    ).optional(),
    health: uniqueArray(Health).optional(),
  }),
  observations: z.strictObject({
    ...base,
    kinds: uniqueArray(SubjectKind.nullable()).optional(),
    publisher_ids: ids,
    source_asset_ids: ids,
    track_ids: ids,
  }),
  tracks: z.strictObject({ ...base, kinds: uniqueArray(SubjectKind.nullable()).optional() }),
  geofeatures: z.strictObject({
    ...base,
    kinds: uniqueArray(GeofeatureKind.nullable()).optional(),
  }),
  tasks: z.strictObject({
    ids,
    asset_ids: ids,
    commands: uniqueArray(z.enum(['move_to', 'pause', 'resume'])).optional(),
    states: uniqueArray(z.union([ExecutionState, z.literal('cancellation_requested')])).optional(),
  }),
  objects: z.strictObject({ ids, content_types: uniqueArray(ContentType).optional() }),
  api_keys: z.strictObject({ ids, operator_ids: ids }),
  operators: z.strictObject({ ids }),
  resources: z.strictObject({ kinds: uniqueArray(text(128, true)).optional() }),
  activity: z.strictObject({ categories: uniqueArray(text(128, true)).optional() }),
};
export function listQuery<S extends z.ZodType>(selection: S) {
  return z.union([
    z.strictObject({ page_size: PageSize.optional(), filters: selection.optional() }),
    Continuation,
  ]);
}
export function associatedQuery<S extends z.ZodRawShape>(parent: S) {
  return z.union([z.strictObject({ ...parent, page_size: PageSize.optional() }), Continuation]);
}
export function page<S extends z.ZodType>(item: S, identity: (value: z.output<S>) => string) {
  return z.strictObject({
    items: z
      .array(item)
      .max(1000)
      .refine((values) => ordered(values, identity), 'List identity or order differs'),
    next_page_token: Opaque.nullable(),
  });
}
