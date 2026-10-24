import { z } from 'zod';
import { NewId, Opaque, Secret, Uuid } from './scalars.js';

export const headers = Object.freeze({
  dataset: { name: 'Atlas-Dataset-ID', schema: Uuid },
  protocol: { name: 'Atlas-Protocol-Version', schema: Opaque },
  authorization: { name: 'Authorization', schema: z.templateLiteral(['Bearer ', Secret]) },
  attempt: { name: 'Atlas-Attempt-ID', schema: NewId },
  request: { name: 'Atlas-Request-ID', schema: NewId },
});
