import { z } from 'zod';
import { Altitude, NewId, Position, Timestamp, Uuid, unique } from './scalars.js';

const move = z.strictObject({
  command: z.literal('move_to'),
  scheduling: z.literal('queued'),
  inputs: z.strictObject({
    target: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('position'), position: Position }),
      z.strictObject({ kind: z.literal('geofeature'), geofeature_id: Uuid }),
    ]),
    altitude: Altitude.optional(),
  }),
});
const pause = z.strictObject({
  command: z.literal('pause'),
  scheduling: z.literal('immediate'),
  inputs: z.strictObject({}),
});
const resume = z.strictObject({
  command: z.literal('resume'),
  scheduling: z.literal('immediate'),
  inputs: z.strictObject({}),
  expires_at: Timestamp,
});
export const commandCatalog = Object.freeze({ move_to: move, pause, resume });
export const Command = z
  .discriminatedUnion('command', [move, pause, resume])
  .meta({ id: 'Command' });
const creation = { request_id: NewId, task_id: NewId, asset_id: Uuid };
export const CreateTask = z
  .discriminatedUnion('command', [
    move.extend(creation),
    pause.extend(creation),
    resume.extend(creation),
  ])
  .meta({ id: 'CreateTask' });
function support<C extends z.ZodType, S extends z.ZodType>(command: C, scheduling: S) {
  return z.strictObject({ command, scheduling: z.array(scheduling).min(1).max(1) });
}
export const Capabilities = z
  .strictObject({
    commands: z
      .array(
        z.union([
          support(move.shape.command, move.shape.scheduling),
          support(pause.shape.command, pause.shape.scheduling),
          support(resume.shape.command, resume.shape.scheduling),
        ]),
      )
      .max(3)
      .refine((values) => unique(values, (value) => value.command), 'Duplicate command'),
  })
  .meta({ id: 'Capabilities' });
export type Command = z.output<typeof Command>;
export type CreateTask = z.output<typeof CreateTask>;
export type Capabilities = z.output<typeof Capabilities>;
