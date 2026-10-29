import type { z } from 'zod';
import { SdkError } from './contracts.js';
import type { RequestOptions, WaitResult } from './contracts.js';
import type { Session } from './connection.js';
import { failureCode, submission } from './http.js';
import type { JsonBinding, JsonReply } from './http.js';

type PageReply =
  | Extract<JsonReply, { kind: 'error' }>
  | {
      kind: 'success';
      status: number;
      body: { dataset_id: string; data: { next_page_token: string | null } };
    };
export type ListCursor<T> = Readonly<{
  next: (options?: RequestOptions) => Promise<WaitResult<T> | { kind: 'end' }>;
  close: () => void;
}>;

export function list<R extends z.ZodType, S extends z.ZodType<PageReply>>(
  session: Session,
  binding: JsonBinding<R, S>,
) {
  return (input: Exclude<z.output<R>, { page_token: string }>): ListCursor<z.output<S>> => {
    const original = submission(binding, input, session.requestBudget);
    if (
      typeof original.facts === 'object' &&
      original.facts !== null &&
      'page_token' in original.facts
    )
      throw new SdkError('invalid_value');
    const datasetId = session.datasetId;
    const epoch = session.datasetEpoch;
    if (datasetId === null) throw new SdkError('not_connected');
    let token: string | undefined;
    let ended = false;
    let closed = false;
    let busy = false;
    return Object.freeze({
      async next(options: RequestOptions = {}) {
        const id = crypto.randomUUID();
        if (closed || epoch !== session.datasetEpoch || datasetId !== session.datasetId) {
          return {
            kind: 'not_sent',
            code: closed ? 'closed' : 'dataset_invalidated',
            attemptId: id,
          };
        }
        if (ended) return { kind: 'end' };
        if (busy || options.signal?.aborted)
          return {
            kind: 'not_sent',
            code: busy ? 'capacity' : 'cancelled',
            attemptId: id,
          };
        busy = true;
        try {
          const request =
            token === undefined
              ? original
              : submission(
                  binding,
                  binding.request.schema.parse({ page_token: token }),
                  session.requestBudget,
                );
          const running = session.start(binding, request, {
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            datasetId,
            selection: original.facts,
          });
          // A cancelled caller does not advance the cursor behind its back.
          const result = await running.wait(options.signal);
          if (result.kind === 'response' && result.response.kind === 'success') {
            if (closed || epoch !== session.datasetEpoch || datasetId !== session.datasetId) {
              return {
                kind: 'failed',
                code: closed ? 'closed' : 'dataset_invalidated',
                context: result.context,
              };
            }
            const next = result.response.body.data.next_page_token;
            ended = next === null;
            token = next ?? undefined;
          }
          return result;
        } catch (error) {
          return { kind: 'not_sent', code: failureCode(error), attemptId: id };
        } finally {
          busy = false;
        }
      },
      close() {
        closed = true;
        token = undefined;
      },
    } satisfies ListCursor<z.output<S>>);
  };
}
