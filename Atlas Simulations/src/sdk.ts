import { randomUUID } from 'node:crypto';
import { Uuid } from '@atlas/protocol';
import type { WaitResult } from '@atlas/sdk';
export const id = () => Uuid.parse(randomUUID());
export function success<T>(
  result: WaitResult<
    { kind: 'success'; body: { data: T } } | { kind: 'error'; body: { error: { code: string } } }
  >,
): T {
  if (result.kind !== 'response')
    throw new Error(`SDK ${result.kind}${'code' in result ? ` ${result.code}` : ''}`);
  if (result.response.kind !== 'success')
    throw new Error(`Core ${result.response.body.error.code}`);
  return result.response.body.data;
}
