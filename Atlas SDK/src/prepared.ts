import type { ErrorObject, ExchangeName } from '@atlas/protocol';
import type { z } from 'zod';
import type { MutationOwner, NetworkOptions, Session } from './connection.js';
import { SdkError } from './contracts.js';
import type { EffectEvidence, OperationOutcome, Prepared } from './contracts.js';
import { freeze, submission } from './http.js';
import type { JsonBinding, JsonReply } from './http.js';
import type { MutationPolicy } from './policy.js';

type Cell = {
  epoch: number;
  canonical: string;
  bytes: number;
  handles: number;
  pending: number;
  attempts: number;
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

  #retire(key: string, cell: Cell): void {
    if (cell.handles !== 0 || cell.pending !== 0 || this.#cells.get(key) !== cell) return;
    this.#cells.delete(key);
    this.#bytes -= cell.bytes;
  }

  bind<R extends z.ZodType, S extends z.ZodType<JsonReply>>(
    binding: JsonBinding<R, S> & { operationId: ExchangeName },
    policy: MutationPolicy<z.output<R>>,
  ) {
    return this.bindTransport(binding, policy, (validated, options) =>
      this.session.start(binding, validated, options),
    );
  }

  bindTransport<R extends z.ZodType, S extends z.ZodType<JsonReply>>(
    binding: Omit<JsonBinding<R, S>, 'transport'> & {
      transport: 'json' | 'upload';
      operationId: ExchangeName;
    },
    policy: MutationPolicy<z.output<R>>,
    transmit: (
      input: Readonly<{ facts: z.output<R>; bytes: Uint8Array }>,
      options: NetworkOptions<z.output<S>>,
    ) => ReturnType<Prepared<z.output<R>, z.output<S>>['start']>,
  ) {
    return (input: z.output<R>): Prepared<z.output<R>, z.output<S>> => {
      const session = this.session;
      const datasetId = session.datasetId;
      if (session.state.kind === 'closed') throw new SdkError('closed');
      if (datasetId === null) throw new SdkError('not_connected');
      const remaining = session.maxPreparedBytes - this.#bytes;
      const validated = submission(binding, input, session.requestBudget);
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
          bytes: cost,
          handles: 0,
          pending: 0,
          attempts: 0,
          uncertain: false,
          refusal: undefined,
          accepted: undefined,
        };
        this.#cells.set(key, cell);
        this.#bytes += cost;
      }
      const shared = cell;
      shared.handles++;
      let closed = false;
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
      const nextOwner = (): MutationOwner<z.output<S>> => {
        shared.attempts = Math.min(Number.MAX_SAFE_INTEGER, shared.attempts + 1);
        return {
          identity,
          attemptNumber: shared.attempts,
          report: policy.report?.(validated.facts) ?? false,
          outcome,
          transmitted: () => {
            shared.pending++;
          },
          completed: (result) => {
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
            } else if (result.kind !== 'not_sent') {
              shared.uncertain = true;
            }
            this.#retire(key, shared);
          },
        };
      };
      const start: Prepared<z.output<R>, z.output<S>>['start'] = (options = {}) => {
        const mutation = nextOwner();
        if (closed)
          return session.refuse(binding.operationId, 'closed', crypto.randomUUID(), mutation);
        if (outcome().kind === 'dataset_invalidated')
          return session.refuse(
            binding.operationId,
            'dataset_invalidated',
            crypto.randomUUID(),
            mutation,
          );
        return transmit(validated, {
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          datasetId,
          mutation,
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
        close: () => {
          if (closed) return;
          closed = true;
          shared.handles--;
          this.#retire(key, shared);
        },
        start,
        async send(options = {}) {
          if (closed || options.signal?.aborted) {
            const id = crypto.randomUUID();
            return {
              attempt: await session.refuse<z.output<S>>(
                binding.operationId,
                closed ? 'closed' : 'cancelled',
                id,
                nextOwner(),
              ).settled,
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
