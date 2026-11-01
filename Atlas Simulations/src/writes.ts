import type { Prepared } from '@atlas/sdk';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { Truth } from './truth.js';
import { ExchangeFailure, refusalCode } from './sdk.js';
export class Writes {
  private readonly active = new Set<Promise<void>>();
  private readonly owners = new Set<string>();
  constructor(readonly truth: Truth) {}
  send<R, T>(
    operation: Prepared<R, T>,
    policy: 'write' | 'sample' | 'contact' = 'write',
  ): Promise<void> {
    if (this.active.size >= 64) {
      operation.close();
      throw new Error('Prepared write backlog exhausted');
    }
    let release: () => void;
    try {
      release = this.truth.reserveWriter();
    } catch (error) {
      operation.close();
      throw error;
    }
    const identity = `${operation.submission.operation}/${operation.submission.identity}`;
    try {
      this.truth.append({
        kind: 'submitted',
        source: 'runtime',
        identity,
        operation: operation.submission.operation,
        facts: z.json().parse(operation.submission.facts),
      });
    } catch (error) {
      release();
      operation.close();
      throw error;
    }
    this.owners.add(identity);
    const work = (async () => {
      let backoff = 100;
      try {
        for (let retry = 0; retry < 20; retry++) {
          const result = await operation.send({ timeoutMs: 3000 });
          this.truth.append({ kind: 'attempt', identity, result: z.json().parse(result.attempt) });
          this.truth.append({ kind: 'outcome', identity, outcome: z.json().parse(result.outcome) });
          if (result.outcome.kind === 'accepted') return;
          const attempt = result.attempt;
          if (
            policy === 'contact' &&
            z
              .object({
                kind: z.literal('response'),
                response: z.object({
                  kind: z.literal('error'),
                  body: z.object({
                    error: z.object({
                      code: z.enum(['challenge_expired', 'challenge_run_mismatch']),
                    }),
                  }),
                }),
              })
              .safeParse(attempt).success
          )
            throw new Error('contact_expired');
          if (
            policy === 'sample' &&
            attempt.kind === 'response' &&
            typeof attempt.response === 'object' &&
            attempt.response !== null &&
            'kind' in attempt.response &&
            attempt.response.kind === 'error' &&
            'body' in attempt.response
          ) {
            const error = z
              .object({ error: z.object({ code: z.string() }) })
              .parse(attempt.response.body);
            if (['storage_limit', 'resource_limit'].includes(error.error.code)) return;
          }
          if (result.outcome.kind !== 'unknown_outcome') {
            const code = refusalCode(attempt);
            if (code !== undefined) throw new ExchangeFailure(code);
            throw new Error(`Write ${identity} ${result.outcome.kind}`);
          }
          if (
            attempt.kind === 'not_sent' &&
            ['dataset_invalidated', 'authorization_required', 'closed'].includes(attempt.code)
          )
            throw new ExchangeFailure(attempt.code);
          await delay(backoff);
          backoff = Math.min(2000, backoff * 2);
        }
        throw new Error(`Write retry budget exhausted ${identity}`);
      } finally {
        operation.close();
        release();
        this.owners.delete(identity);
      }
    })();
    this.active.add(work);
    void work.then(
      () => this.active.delete(work),
      () => this.active.delete(work),
    );
    return work;
  }
  async drain(deadline = performance.now() + 30000): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.active]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Unresolved writers ${[...this.owners].join(',')}`)),
            Math.max(0, deadline - performance.now()),
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
