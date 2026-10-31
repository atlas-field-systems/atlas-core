import { setTimeout as delay } from 'node:timers/promises';
import type { Prepared } from '@atlas/sdk';
import { Truth } from './truth.js';
import { z } from 'zod';
export class Writes {
  private readonly active = new Set<Promise<void>>();
  private readonly owners = new Set<string>();
  constructor(readonly truth: Truth) {}
  send<R, T>(operation: Prepared<R, T>, sampling = false): Promise<void> {
    if (this.active.size >= 64) {
      operation.close();
      throw new Error('Prepared write backlog exhausted');
    }
    const identity = `${operation.submission.operation}/${operation.submission.identity}`;
    const facts = z.json().parse(operation.submission.facts);
    this.truth.append({
      kind: 'submitted',
      identity,
      operation: operation.submission.operation,
      facts,
    });
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
            sampling &&
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
            if (error.error.code === 'storage_limit') return;
          }
          if (result.outcome.kind !== 'unknown_outcome')
            throw new Error(`Write ${identity} ${result.outcome.kind}`);
          if (
            attempt.kind === 'not_sent' &&
            ['dataset_invalidated', 'authorization_required', 'closed'].includes(attempt.code)
          )
            throw new Error(`Write ${identity} ${attempt.code}`);
          await delay(backoff);
          backoff = Math.min(2000, backoff * 2);
        }
        throw new Error(`Write retry budget exhausted ${identity}`);
      } finally {
        operation.close();
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
  async drain(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all([...this.active]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Unresolved writers ${[...this.owners].join(',')}`)),
            30000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
