import type { ErrorObject, ExchangeName } from '@atlas/protocol';
import type { z } from 'zod';
import { attempt } from './connection.js';
import type { Session } from './connection.js';
import { SdkError } from './contracts.js';
import type { AttemptResult, EffectEvidence, OperationOutcome, Prepared } from './contracts.js';
import { freeze, submission } from './http.js';
import type { JsonBinding, JsonReply } from './http.js';
import type { MutationPolicy } from './policy.js';

type Cell = {
  epoch: number;
  canonical: string;
  pending: number;
  uncertain: boolean;
  refusal: ErrorObject['code'] | undefined;
  accepted: Extract<EffectEvidence, { kind: 'accepted' }> | undefined;
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
function evidence(cell: Cell): EffectEvidence {
  if (cell.accepted) return cell.accepted;
  if (cell.uncertain || cell.pending > 0) return { kind: 'unknown_outcome' };
  if (cell.refusal) return { kind: 'rejected', code: cell.refusal };
  return { kind: 'not_submitted' };
}

export class Operations {
  readonly #cells = new Map<string, Cell>();
  #bytes = 0;
  constructor(readonly session: Session) {}

  bind<R extends z.ZodType, S extends z.ZodType<JsonReply>>(
    binding: JsonBinding<R, S> & { operationId: ExchangeName },
    policy: MutationPolicy<z.output<R>>,
  ) {
    return (input: z.output<R>): Prepared<z.output<R>, z.output<S>> => {
      const session = this.session;
      const datasetId = session.datasetId;
      if (session.state.kind === 'closed') throw new SdkError('closed');
      if (datasetId === null) throw new SdkError('not_connected');
      const remaining = session.maxPreparedBytes - this.#bytes;
      const budget = {
        ...session.requestBudget,
        maxBytes: Math.min(session.requestBudget.maxBytes, Math.floor(remaining / 8)),
      };
      if (budget.maxBytes < 1) throw new SdkError('capacity');
      const validated = submission(binding, input, budget);
      const identity = policy.identity(validated.facts);
      const key = JSON.stringify([datasetId, binding.operationId, identity]);
      let cell = this.#cells.get(key);
      const facts = canonical(validated.facts);
      if (cell && cell.canonical !== facts) throw new SdkError('identity_conflict');
      if (!cell) {
        const cost = validated.bytes.byteLength * 8 + key.length * 2 + 512;
        if (this.#cells.size >= session.maxPreparedOperations || cost > remaining)
          throw new SdkError('capacity');
        cell = {
          epoch: session.datasetEpoch,
          canonical: facts,
          pending: 0,
          uncertain: false,
          refusal: undefined,
          accepted: undefined,
        };
        this.#cells.set(key, cell);
        this.#bytes += cost;
      }
      const shared = cell;
      const epoch = shared.epoch;
      const outcome = (): OperationOutcome => {
        const knowledge = freeze(evidence(shared));
        return session.datasetId !== datasetId || session.datasetEpoch !== epoch
          ? {
              kind: 'dataset_invalidated',
              originalDatasetId: datasetId,
              evidence: knowledge,
            }
          : knowledge;
      };
      const start: Prepared<z.output<R>, z.output<S>>['start'] = (options = {}) => {
        if (outcome().kind === 'dataset_invalidated') {
          const id = crypto.randomUUID();
          return attempt(
            id,
            Promise.resolve({
              kind: 'not_sent',
              code: 'dataset_invalidated',
              attemptId: id,
            }),
          );
        }
        return session.start(binding, validated, {
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          datasetId,
          mutation: {
            transmitted: () => {
              shared.pending++;
            },
            completed: (result: AttemptResult<z.output<S>>) => {
              shared.pending--;
              if (result.kind === 'response' && result.response.kind === 'success') {
                shared.accepted ??= freeze({
                  kind: 'accepted',
                  attemptId: result.context.attemptId,
                  ...(result.context.requestId === undefined
                    ? {}
                    : { requestId: result.context.requestId }),
                });
              } else if (
                result.kind === 'response' &&
                result.response.kind === 'error' &&
                policy.noEffect(result.response.body.error)
              ) {
                shared.refusal = result.response.body.error.code;
              } else {
                shared.uncertain = true;
              }
            },
          },
        });
      };
      return Object.freeze({
        submission: freeze({
          datasetId,
          operation: binding.operationId,
          identity,
          facts: validated.facts,
        }),
        get outcome() {
          return freeze(outcome());
        },
        start,
        async send(options = {}) {
          if (options.signal?.aborted) {
            const id = crypto.randomUUID();
            return {
              attempt: { kind: 'not_sent', code: 'cancelled', attemptId: id },
              outcome: outcome(),
            };
          }
          const result = await start(options).wait(options.signal);
          return { attempt: result, outcome: outcome() };
        },
      } satisfies Prepared<z.output<R>, z.output<S>>);
    };
  }

  close(): void {
    this.#cells.clear();
    this.#bytes = 0;
  }
}
