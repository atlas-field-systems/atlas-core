import { z } from 'zod';
import { Alias, Opaque, ordered, PageSize, text, Uuid, uniqueArray } from './scalars.js';
import { ContentType } from './objects.js';
import { GeofeatureKind, Health, SubjectKind } from './components.js';
import { ExecutionState } from './tasks.js';
import { Continuation } from './history.js';

const ids = uniqueArray(Uuid).exactOptional();
const base = { ids, aliases: uniqueArray(Alias).exactOptional() };
export const filters = {
  assets: z.strictObject({
    ...base,
    kinds: uniqueArray(
      z.enum(['drone', 'security_camera', 'tracker', 'other']).nullable(),
    ).exactOptional(),
    health: uniqueArray(Health).exactOptional(),
  }),
  observations: z.strictObject({
    ...base,
    kinds: uniqueArray(SubjectKind.nullable()).exactOptional(),
    publisher_ids: ids,
    source_asset_ids: ids,
    track_ids: ids,
  }),
  tracks: z.strictObject({ ...base, kinds: uniqueArray(SubjectKind.nullable()).exactOptional() }),
  geofeatures: z.strictObject({
    ...base,
    kinds: uniqueArray(GeofeatureKind.nullable()).exactOptional(),
  }),
  tasks: z.strictObject({
    ids,
    asset_ids: ids,
    commands: uniqueArray(z.enum(['move_to', 'pause', 'resume'])).exactOptional(),
    states: uniqueArray(
      z.union([ExecutionState, z.literal('cancellation_requested')]),
    ).exactOptional(),
  }),
  objects: z.strictObject({ ids, content_types: uniqueArray(ContentType).exactOptional() }),
  api_keys: z.strictObject({ ids, operator_ids: ids }),
  operators: z.strictObject({ ids }),
  resources: z.strictObject({ kinds: uniqueArray(text(128, true)).exactOptional() }),
  activity: z.strictObject({ categories: uniqueArray(text(128, true)).exactOptional() }),
};
export function listQuery<S extends z.ZodType>(selection: S) {
  return z.union([
    z.strictObject({ page_size: PageSize.exactOptional(), filters: selection.exactOptional() }),
    Continuation,
  ]);
}
export function associatedQuery<S extends z.ZodRawShape>(parent: S) {
  return z.union([
    z.strictObject({ ...parent, page_size: PageSize.exactOptional() }),
    Continuation,
  ]);
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
