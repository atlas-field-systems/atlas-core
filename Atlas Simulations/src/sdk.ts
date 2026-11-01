import { NewId } from '@atlas/protocol';
import type { WaitResult } from '@atlas/sdk';
import { SdkError } from '@atlas/sdk';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
export class ExchangeFailure extends Error {
  constructor(readonly code: string) {
    super(`SDK/Core refusal ${code}`);
  }
}
export function isAuthorizationFailure(error: unknown): error is ExchangeFailure | SdkError {
  return (
    (error instanceof ExchangeFailure || error instanceof SdkError) &&
    ['unauthorized', 'authorization_required'].includes(error.code)
  );
}
export function refusalCode(result: unknown): string | undefined {
  const parsed = z
    .union([
      z.object({ kind: z.enum(['not_sent', 'failed']), code: z.string() }),
      z.object({
        kind: z.literal('response'),
        response: z.object({
          kind: z.literal('error'),
          body: z.object({ error: z.object({ code: z.string() }) }),
        }),
      }),
    ])
    .safeParse(result);
  if (!parsed.success) return undefined;
  return parsed.data.kind === 'response' ? parsed.data.response.body.error.code : parsed.data.code;
}
export const id = () => NewId.parse(randomUUID());
export function success<T>(
  result: WaitResult<
    { kind: 'success'; body: { data: T } } | { kind: 'error'; body: { error: { code: string } } }
  >,
): T {
  if (result.kind !== 'response') {
    if ('code' in result) throw new ExchangeFailure(result.code);
    throw new Error(`SDK ${result.kind}`);
  }
  if (result.response.kind !== 'success')
    throw new ExchangeFailure(result.response.body.error.code);
  return result.response.body.data;
}
