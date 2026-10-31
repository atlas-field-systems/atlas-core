import { z } from 'zod';
import { Uuid } from '@atlas/protocol';
export const WriterIdentity = z.strictObject({
  pid: z.number().int().positive(),
  boot: z.string().min(1).max(128),
  start: z.string().regex(/^\d+$/),
  namespace: z.string().regex(/^pid:\[\d+\]$/),
  launch: Uuid.exactOptional(),
});
export type WriterIdentity = z.infer<typeof WriterIdentity>;
