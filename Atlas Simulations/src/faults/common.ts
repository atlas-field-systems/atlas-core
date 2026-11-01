import type { Prepared } from '@atlas/sdk';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { AssetRuntime } from '../asset.js';
import type { Core } from '../core.js';
import type { Operator } from '../operator.js';
import type { Proxy } from '../proxy.js';
import type { FaultId, TimelineAction } from '../scenario.js';
export const FaultReceipt = z.strictObject({
  id: z.string(),
  activation: z.strictObject({
    kind: z.enum(['http', 'proxy', 'container', 'runtime']),
    identity: z.string().min(1),
    at: z.string(),
    path: z.string(),
  }),
  observations: z.array(z.json()).min(1).max(2048),
});
export type FaultReceipt = z.infer<typeof FaultReceipt>;
export type FaultInput = {
  action: Extract<TimelineAction, { action: 'fault' }>;
  core: Core;
  operator: Operator;
  assets: readonly AssetRuntime[];
  proxy: Proxy;
  signal?: AbortSignal;
};
export function json(value: unknown): z.infer<ReturnType<typeof z.json>> {
  return z.json().parse(value);
}
export function asset(input: FaultInput): AssetRuntime {
  const runtime = input.action.asset
    ? input.assets.find((a) => a.alias === input.action.asset)
    : input.assets[0];
  if (!runtime) throw new Error('Fault Asset missing');
  return runtime;
}
export function receipt(
  id: FaultId,
  kind: FaultReceipt['activation']['kind'],
  identity: string,
  path: string,
  observations: unknown[],
): FaultReceipt {
  return FaultReceipt.parse({
    id,
    activation: { kind, identity, path, at: new Date().toISOString() },
    observations: observations.map(json),
  });
}
export async function raw(input: FaultInput, path: string, facts: unknown) {
  const response = await fetch(new URL(path, input.proxy.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${input.core.credential.secret}`,
      'Atlas-Protocol-Version': '0.4.0',
      'Atlas-Dataset-Id': input.operator.input.datasetId,
    },
    body: typeof facts === 'string' ? facts : JSON.stringify(facts),
    signal: AbortSignal.timeout(5000),
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing raw response body');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (part.value.byteLength > 4194304 - bytes) throw new Error('Raw response capacity');
      bytes += part.value.byteLength;
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const text = Buffer.concat(chunks, bytes).toString('utf8');
  return { status: response.status, body: JSON.parse(text) };
}
export async function observed<R, T>(
  operation: Prepared<R, T>,
  runtime: AssetRuntime,
  timeoutMs = 3000,
) {
  const identity = `${operation.submission.operation}/${operation.submission.identity}`;
  if (
    ['UpdateAsset', 'ReportTaskExecution', 'ReportObservation', 'CreateObservation'].includes(
      operation.submission.operation,
    )
  ) {
    runtime.writes.truth.append({
      kind: 'submitted',
      source: 'fault',
      identity,
      operation: operation.submission.operation,
      facts: json(operation.submission.facts),
    });
    const result = await operation.send({ timeoutMs });
    runtime.writes.truth.append({ kind: 'attempt', identity, result: json(result.attempt) });
    runtime.writes.truth.append({ kind: 'outcome', identity, outcome: json(result.outcome) });
    return result;
  }
  return operation.send({ timeoutMs });
}

export async function committedCursor(runtime: AssetRuntime) {
  const operation = runtime.preparePosition();
  try {
    const result = await observed(operation, runtime);
    if (result.attempt.kind !== 'response' || result.attempt.response.kind !== 'success')
      throw new Error('Cursor write did not commit');
    return result.attempt.response.body.commit_cursor;
  } finally {
    operation.close();
  }
}

export async function wait(input: FaultInput, milliseconds: number): Promise<void> {
  await delay(milliseconds, undefined, { signal: input.signal });
}
export async function activation(barrier: Promise<void>, input: FaultInput): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const aborted = () => rejectWait?.(new Error('Fault activation interrupted'));
  let rejectWait: ((error: Error) => void) | undefined;
  try {
    input.signal?.throwIfAborted();
    await Promise.race([
      barrier,
      new Promise<never>((_, reject) => {
        rejectWait = reject;
        timer = setTimeout(() => reject(new Error('Fault activation deadline')), 5000);
        input.signal?.addEventListener('abort', aborted, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener('abort', aborted);
  }
}
