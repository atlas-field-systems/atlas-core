import { contract, readJson, writeJson, commandCatalog } from '@atlas/protocol';
import type { Budget } from '@atlas/protocol';
import type { z } from 'zod';
import { freeze } from './http.js';

/** Construct a detached, bounded value using its installed Protocol schema. */
export function component<S extends z.ZodType>(
  schema: S,
  value: z.output<S>,
  budget?: Partial<Budget>,
): z.output<S> {
  const definition = contract(schema);
  return freeze(readJson(definition, writeJson(definition, value, budget), budget));
}

export { commandCatalog };
