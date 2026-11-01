import { z } from 'zod';
import { Timestamp, Uuid, Opaque, exchanges } from '@atlas/protocol';
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';

const Frames = z
  .array(
    z.object({
      file: z.string().regex(/^[a-z-]+\.js$/),
      function: z.string().regex(/^[\w.$<> ]{1,80}$/),
      line: z.number().int().positive(),
    }),
  )
  .max(8);
export const Event = z.strictObject({
  at: Timestamp,
  severity: z.enum(['INFO', 'WARN', 'ERROR', 'DEBUG']),
  event: z.string().regex(/^[a-z_]{1,64}$/),
  component: z.enum(['http', 'database', 'objects', 'synchronization', 'lifecycle', 'runtime']),
  release: z.literal('0.5.0'),
  dataset: Uuid.optional(),
  run: Uuid.optional(),
  request_id: Uuid.optional(),
  attempt_id: Uuid.optional(),
  route: z.enum(Object.values(exchanges).map((e) => e.path)).optional(),
  code: z
    .string()
    .regex(/^[a-z_]{1,64}$/)
    .optional(),
  bytes: z.number().nonnegative().optional(),
  count: z.number().int().nonnegative().optional(),
  duration_ms: z.number().nonnegative().optional(),
  cursor: Opaque.refine((value) => value.length <= 128).optional(),
  outcome: z
    .enum(['first', 'replay', 'read', 'accepted', 'duplicate', 'rejected', 'written', 'failed'])
    .optional(),
  transaction_ms: z.number().nonnegative().optional(),
  writer_wait_ms: z.number().nonnegative().optional(),
  frames: Frames.optional(),
  evidence: z.literal('unavailable').optional(),
});
export type Diagnostic = Omit<z.infer<typeof Event>, 'at' | 'release'>;
export function faultFrames(error: unknown): Pick<Diagnostic, 'frames' | 'evidence'> {
  if (!(error instanceof Error) || typeof error.stack !== 'string')
    return { evidence: 'unavailable' };
  const root = fileURLToPath(new URL('.', import.meta.url));
  const frames: z.infer<typeof Frames> = [];
  for (const line of error.stack.split('\n').slice(1, 17)) {
    const match = /^\s*at ([\w.$<> ]+) \((?:file:\/\/)?([^()]+):(\d+):\d+\)$/.exec(line);
    const path = match?.[2],
      name = match?.[1],
      number = match?.[3];
    if (!path || !name || !number) continue;
    let decoded: string;
    try {
      decoded = fileURLToPath(`file://${path}`);
    } catch {
      continue;
    }
    if (!decoded.startsWith(root)) continue;
    const frame = Frames.element.safeParse({
      file: basename(decoded),
      function: name,
      line: Number(number),
    });
    if (frame.success) frames.push(frame.data);
    if (frames.length >= 8) break;
  }
  return frames.length === 0 ? { evidence: 'unavailable' } : { frames };
}
export function retainedEvent(value: unknown): string | undefined {
  const parsed = Event.safeParse(value);
  return parsed.success ? JSON.stringify(parsed.data) + '\n' : undefined;
}
