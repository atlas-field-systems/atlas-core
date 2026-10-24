import { z } from 'zod';
import { Counter, decimalCounter, NewId, text, Timestamp, Uuid, unique } from './scalars.js';

export const ContentType = z
  .string()
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$(?![\s\S])/)
  .max(255)
  .meta({ id: 'ContentType' });
export const Sha256 = z
  .string()
  .regex(/^[0-9a-f]{64}$(?![\s\S])/)
  .meta({ id: 'Sha256', minLength: 64, maxLength: 64 });
export const ObjectLength = decimalCounter('2000000000').meta({ id: 'ObjectLength' });
export const Association = z
  .strictObject({ kind: z.enum(['asset', 'observation', 'track', 'geofeature', 'task']), id: Uuid })
  .meta({ id: 'Association' });
export const Associations = z
  .array(Association)
  .max(128)
  .refine(
    (values) => unique(values, (value) => `${value.kind}:${value.id}`),
    'Duplicate association',
  );
export const ObjectMetadata = z
  .strictObject({
    name: text(128, true).optional(),
    description: text(4096).optional(),
    associations: Associations,
  })
  .meta({ id: 'ObjectMetadata' });
const storage = { byte_length: ObjectLength, sha256: Sha256, content_type: ContentType };
export const UploadDescriptor = z
  .strictObject({ request_id: NewId, object_id: NewId, ...storage, metadata: ObjectMetadata })
  .meta({ id: 'UploadDescriptor' });
const ObjectImageDefinition = z
  .strictObject({
    dataset_id: Uuid,
    object_id: Uuid,
    version: Counter,
    edit_revision: Counter,
    created_at: Timestamp,
    ...storage,
    metadata: ObjectMetadata,
  })
  .meta({ id: 'ObjectImage' });
export const ObjectEdits = z
  .strictObject({
    name: text(128, true).nullable().optional(),
    description: text(4096).nullable().optional(),
    associations: Associations.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Empty edit')
  .meta({ id: 'ObjectEdits' });
export const ContentDescriptor = z
  .strictObject({ object_id: Uuid, ...storage, disposition: z.enum(['inline', 'attachment']) })
  .meta({ id: 'ContentDescriptor' });
export type ObjectImage = z.output<typeof ObjectImageDefinition>;
export const ObjectImage: z.ZodType<ObjectImage> = ObjectImageDefinition;
export type UploadDescriptor = z.output<typeof UploadDescriptor>;
export type ContentType = z.output<typeof ContentType>;
export type Sha256 = z.output<typeof Sha256>;
export type ObjectLength = z.output<typeof ObjectLength>;
export type Association = z.output<typeof Association>;
export type Associations = z.output<typeof Associations>;
export type ObjectMetadata = z.output<typeof ObjectMetadata>;
export type ObjectEdits = z.output<typeof ObjectEdits>;
export type ContentDescriptor = z.output<typeof ContentDescriptor>;
