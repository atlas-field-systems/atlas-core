import { z } from 'zod';
import {
  AssignedTasks,
  BeginAssetContact,
  HistoryFirst,
  contract,
  exchanges,
  readJson,
  writeJson,
} from '@atlas/protocol';
import type { HistoryPage, RequestOf, ResponseOf } from '@atlas/protocol';
import type { Operations } from './prepared.js';
import { policies } from './policy.js';
import { attempt as callerAttempt } from './connection.js';
import type { Session } from './connection.js';
import { SdkError } from './contracts.js';
import type {
  Prepared,
  Attempt,
  AttemptResult,
  LocalCode,
  RequestOptions,
  WaitResult,
} from './contracts.js';
import { failureCode, freeze, submission } from './http.js';
import { component } from './components.js';

const { allocation_context: _historyContext, ...historyFields } = HistoryFirst.shape;
const historySelection = z.strictObject(historyFields);
const { allocation_context: _currentContext, ...currentFields } =
  BeginAssetContact.options[0].shape;
const { allocation_context: _replaceContext, ...replaceFields } =
  BeginAssetContact.options[1].shape;
const contactSelection = z.discriminatedUnion('mode', [
  z.strictObject(currentFields),
  z.strictObject(replaceFields),
]);
export type HistorySelection = Omit<HistoryFirst, 'allocation_context'>;
type WithoutAllocation<T> = T extends unknown ? Omit<T, 'allocation_context'> : never;
export type ContactSelection = WithoutAllocation<RequestOf<'BeginAssetContact'>>;
export type HistoryContext = Omit<HistoryPage, 'readings' | 'next_page_token'>;
export type AllocationEvidence = Readonly<{
  datasetId: string;
  coreRunId: string;
  allocationContext: string;
  earliestExpiry: number;
  latestExpiry: number;
}>;
export type ReleaseEvidence =
  | 'unallocated'
  | 'unacknowledged'
  | 'acknowledged'
  | 'expired'
  | 'owner-ended';
export type RemoteAbandonment = Readonly<{ kind: 'abandoned'; evidence: ReleaseEvidence }>;
export type HistoryCloseResult = WaitResult<ResponseOf<'ReleaseHistoryView'>> | RemoteAbandonment;
export type RemoteCloseResult = readonly Readonly<{
  identity: string;
  result: HistoryCloseResult | { kind: 'local' };
}>[];
export type RemoteLimits = Readonly<{ handles?: number; retainedBytes?: number }>;

type HistoryReply = ResponseOf<'GetAssetMovementHistory'>;
type HistoryBinding =
  | typeof exchanges.GetAssetMovementHistory
  | typeof exchanges.GetObservationMovementHistory
  | typeof exchanges.GetTrackMovementHistory;
export type HistoryView = Readonly<{
  selection: HistorySelection;
  allocation: AllocationEvidence | undefined;
  context: HistoryContext | undefined;
  releaseEvidence: ReleaseEvidence;
  status: 'unallocated' | 'active' | 'expired' | 'acknowledged' | 'owner-ended' | 'abandoned';
  next: (options?: RequestOptions) => Promise<WaitResult<HistoryReply> | { kind: 'end' }>;
  release: (options?: RequestOptions) => Promise<WaitResult<ResponseOf<'ReleaseHistoryView'>>>;
  close: (options?: Omit<RequestOptions, 'signal'>) => Promise<HistoryCloseResult>;
}>;

function bounded(value: number | undefined, fallback: number, maximum: number) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
    throw new SdkError('invalid_options');
  return result;
}
function historyContext(page: HistoryPage): HistoryContext {
  const { readings: _readings, next_page_token: _next, ...context } = page;
  return freeze(context);
}
function sameHistory(a: HistoryContext, b: HistoryContext): boolean {
  return (
    a.query_id === b.query_id &&
    a.view_id === b.view_id &&
    a.source === b.source &&
    a.baseline_cursor === b.baseline_cursor &&
    a.expires_at === b.expires_at &&
    a.release_token === b.release_token
  );
}

export type AssignedInstructions = Readonly<{
  selection: Exclude<RequestOf<'GetAssignedTasks'>, { page_token: string }>;
  context: Omit<AssignedTasks, 'tasks' | 'next_page_token'> | undefined;
  next: (
    options?: RequestOptions,
  ) => Promise<WaitResult<ResponseOf<'GetAssignedTasks'>> | { kind: 'end' }>;
  close: () => void;
}>;
export type ContactRequest = Readonly<{
  selection: ContactSelection;
  allocation: AllocationEvidence | undefined;
  releaseEvidence: ReleaseEvidence;
  read: (options?: RequestOptions) => Promise<WaitResult<ResponseOf<'BeginAssetContact'>>>;
  checkIn: (
    input: RequestOf<'UpdateAsset'>,
  ) => Prepared<RequestOf<'UpdateAsset'>, ResponseOf<'UpdateAsset'>>;
  replace: (
    input: RequestOf<'ReplaceAssetProcess'>,
  ) => Prepared<RequestOf<'ReplaceAssetProcess'>, ResponseOf<'ReplaceAssetProcess'>>;
  close: () => Promise<RemoteAbandonment>;
}>;
export type RemoteReads = Readonly<{
  history: Readonly<
    Record<'asset' | 'observation' | 'track', (selection: HistorySelection) => HistoryView>
  >;
  assigned: (input: AssignedInstructions['selection']) => AssignedInstructions;
  contact: (selection: ContactSelection) => ContactRequest;
  close: (drained?: Promise<void>) => Promise<RemoteCloseResult>;
}>;

/** One owner per client. Close this owner before closing its shared Session. */
export function createRemoteReads(
  session: Session,
  operations: Operations,
  limits: RemoteLimits = {},
): RemoteReads {
  const maximum = bounded(limits.handles, 16, 1024);
  const maximumBytes = bounded(limits.retainedBytes, 1024 * 1024, 16 * 1024 * 1024);
  type Reservation = {
    bytes: number;
    pageBytes: number;
    ended: () => boolean;
    close: () => Promise<HistoryCloseResult | { kind: 'local' }>;
  };
  const reservations = new Map<string, Reservation>();
  let retainedBytes = 0;
  let closing: Promise<RemoteCloseResult> | undefined;
  let stopped = false;
  const forget = (key: string, reservation: Reservation) => {
    if (reservations.get(key) !== reservation) return;
    reservations.delete(key);
    retainedBytes -= reservation.bytes;
  };
  const reserve = <S extends z.ZodType>(
    schema: S,
    input: z.output<S>,
    identify: (facts: z.output<S>) => string,
  ) => {
    if (stopped || session.state.kind === 'closed') throw new SdkError('closed');
    for (const [id, reservation] of reservations) if (reservation.ended()) forget(id, reservation);
    if (reservations.size >= maximum) throw new SdkError('capacity');
    const budget = {
      ...session.requestBudget,
      maxBytes: Math.min(
        session.requestBudget.maxBytes,
        Math.floor((maximumBytes - retainedBytes - 2048) / 8),
      ),
    };
    if (budget.maxBytes < 1) throw new SdkError('capacity');
    const bytes = writeJson(contract(schema), input, budget);
    const facts = freeze(readJson(contract(schema), bytes, budget));
    const key = identify(facts);
    if (reservations.has(key)) throw new SdkError('identity_conflict');
    const cost = bytes.byteLength * 8 + 2048;
    if (session.state.kind !== 'ready') throw new SdkError(session.state.reason);
    retainedBytes += cost;
    const reservation: Reservation = {
      bytes: cost,
      pageBytes: 0,
      ended: () => false,
      close: async () => ({ kind: 'local' }),
    };
    return { key, facts, reservation };
  };
  const retain = (reservation: Reservation, bytes: number, page = false) => {
    const extra = bytes - (page ? reservation.pageBytes : 0);
    if (extra > maximumBytes - retainedBytes) throw new SdkError('capacity');
    reservation.bytes += extra;
    retainedBytes += extra;
    if (page) reservation.pageBytes = bytes;
  };
  function allocationOwner(reservation: Reservation) {
    const initial = session.state;
    if (initial.kind !== 'ready') throw new SdkError(initial.reason);
    const originalDatasetId = initial.datasetId,
      originalRunId = initial.health.core_run_id;
    let allocation: AllocationEvidence | undefined;
    let epoch = session.datasetEpoch;
    let evidence: ReleaseEvidence = 'unallocated';
    const ended = () => {
      if (evidence === 'acknowledged' || evidence === 'owner-ended') return true;
      if (
        session.datasetEpoch !== epoch ||
        session.datasetId !== originalDatasetId ||
        (session.state.kind === 'ready' && session.state.health.core_run_id !== originalRunId)
      )
        evidence = 'owner-ended';
      else if (allocation && performance.now() >= allocation.latestExpiry) evidence = 'expired';
      return evidence === 'expired' || evidence === 'owner-ended';
    };
    const invalid = (): LocalCode | undefined => {
      const state = session.state;
      if (state.kind !== 'ready') return state.reason;
      if (session.datasetEpoch !== epoch || state.datasetId !== originalDatasetId)
        return 'dataset_invalidated';
      if (state.health.core_run_id !== originalRunId) return 'superseded';
      if (allocation && performance.now() >= allocation.earliestExpiry) return 'superseded';
      return undefined;
    };
    return {
      get allocation() {
        return allocation;
      },
      get evidence() {
        ended();
        return evidence;
      },
      ended,
      invalid,
      acknowledge() {
        evidence = 'acknowledged';
      },
      endOwner() {
        if (evidence !== 'acknowledged') evidence = 'owner-ended';
      },
      started<T>(attempt: Attempt<T>): Attempt<T> {
        const previous = evidence;
        if (previous === 'unallocated') evidence = 'unacknowledged';
        void attempt.settled.then((result) => {
          if (
            result.kind === 'not_sent' &&
            previous === 'unallocated' &&
            evidence === 'unacknowledged'
          )
            evidence = 'unallocated';
        });
        return attempt;
      },
      async allocate(): Promise<WaitResult<ResponseOf<'GetHealth'>> | undefined> {
        if (allocation) return undefined;
        const sentAt = performance.now();
        const result = await session.refreshHealth();
        const receivedAt = performance.now();
        if (result.kind !== 'response' || result.response.kind !== 'success') return result;
        const state = session.state;
        if (
          state.kind !== 'ready' ||
          state.datasetId !== result.response.body.dataset_id ||
          state.health.core_run_id !== result.response.body.data.core_run_id
        )
          return session.refuse<ResponseOf<'GetHealth'>>(
            'GetHealth',
            state.kind === 'ready' ? 'superseded' : state.reason,
          ).settled;
        const fenced = invalid();
        if (fenced) return session.refuse<ResponseOf<'GetHealth'>>('GetHealth', fenced).settled;
        retain(reservation, result.response.body.data.allocation_context.length * 16 + 512);
        epoch = session.datasetEpoch;
        allocation = freeze({
          datasetId: result.response.body.dataset_id,
          coreRunId: result.response.body.data.core_run_id,
          allocationContext: result.response.body.data.allocation_context,
          earliestExpiry: sentAt + 60_000,
          latestExpiry: receivedAt + 60_000,
        });
        return undefined;
      },
    };
  }
  function history(binding: HistoryBinding) {
    return (input: HistorySelection): HistoryView => {
      // Validation precedes reading caller identity, including accessor refusal.
      const { key, facts, reservation } = reserve(historySelection, input, (facts) =>
        JSON.stringify([binding.operationId, facts.query_id]),
      );
      const owner = allocationOwner(reservation);
      let original: ReturnType<typeof submission<typeof binding.request.schema>> | undefined;
      let context: HistoryContext | undefined;
      let token: string | undefined;
      let finished = false;
      let abandoned = false;
      let active: Promise<unknown> | undefined;
      let releaseAttempt: Attempt<ResponseOf<'ReleaseHistoryView'>> | undefined;
      const refusal = (code: LocalCode) =>
        session.refuse<HistoryReply>(binding.operationId, code).settled;
      const release = async (
        options: RequestOptions = {},
        duringClose = false,
      ): Promise<AttemptResult<ResponseOf<'ReleaseHistoryView'>>> => {
        if (stopped && !duringClose)
          return session.refuse<ResponseOf<'ReleaseHistoryView'>>('ReleaseHistoryView', 'closed')
            .settled;
        if (options.signal?.aborted)
          return session.refuse<ResponseOf<'ReleaseHistoryView'>>('ReleaseHistoryView', 'cancelled')
            .settled;
        if (active) await active;
        const allocation = owner.allocation;
        const invalid = owner.invalid();
        if (invalid)
          return session.refuse<ResponseOf<'ReleaseHistoryView'>>('ReleaseHistoryView', invalid)
            .settled;
        if (!context || !allocation)
          return session.refuse<ResponseOf<'ReleaseHistoryView'>>(
            'ReleaseHistoryView',
            'superseded',
          ).settled;
        if (!releaseAttempt) {
          const running = session.start(
            exchanges.ReleaseHistoryView,
            submission(
              exchanges.ReleaseHistoryView,
              { release_token: context.release_token },
              session.requestBudget,
            ),
            {
              datasetId: allocation.datasetId,
              coreRunId: allocation.coreRunId,
              ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            },
          );
          releaseAttempt = running;
          void running.settled.then((result) => {
            if (result.kind === 'response') {
              if (result.response.kind === 'success') owner.acknowledge();
              else if (result.response.body.error.code === 'allocation_expired') owner.endOwner();
            }
            releaseAttempt = undefined;
          });
        }
        return releaseAttempt.settled;
      };
      const view: HistoryView = Object.freeze({
        selection: facts,
        get allocation() {
          return owner.allocation;
        },
        get context() {
          return context;
        },
        get releaseEvidence() {
          return owner.evidence;
        },
        get status(): HistoryView['status'] {
          const evidence = owner.evidence;
          if (evidence === 'acknowledged' || evidence === 'owner-ended') return evidence;
          if (owner.allocation && performance.now() >= owner.allocation.earliestExpiry)
            return 'expired';
          if (abandoned) return 'abandoned';
          return evidence === 'unallocated' ? 'unallocated' : 'active';
        },
        async next(
          options: RequestOptions = {},
        ): Promise<WaitResult<HistoryReply> | { kind: 'end' }> {
          if (abandoned || stopped) return refusal('closed');
          if (options.signal?.aborted) return refusal('cancelled');
          const invalid = owner.invalid();
          if (invalid) return refusal(invalid);
          if (active || releaseAttempt) return refusal('capacity');
          if (owner.ended()) return refusal('superseded');
          if (finished) return { kind: 'end' };
          // Keep admission until the network attempt settles, independent of the caller wait.
          let resolveActive: () => void = () => undefined;
          active = new Promise<void>((resolve) => {
            resolveActive = resolve;
          });
          const execute = async (): Promise<AttemptResult<HistoryReply>> => {
            try {
              const health = await owner.allocate();
              if (health !== undefined) {
                if (health.kind === 'response') {
                  if (health.response.kind === 'error')
                    return { ...health, response: health.response };
                  return refusal('superseded');
                }
                return health.kind === 'cancelled' ? refusal('cancelled') : health;
              }
              const allocation = owner.allocation;
              const afterHealth = owner.invalid();
              if (abandoned || stopped || afterHealth || !allocation)
                return refusal(abandoned || stopped ? 'closed' : (afterHealth ?? 'superseded'));
              original ??= submission(
                binding,
                { ...facts, allocation_context: allocation.allocationContext },
                session.requestBudget,
              );
              const request =
                token === undefined
                  ? original
                  : submission(binding, { page_token: token }, session.requestBudget);
              const running = owner.started(
                session.start(binding, request, {
                  datasetId: allocation.datasetId,
                  coreRunId: allocation.coreRunId,
                  selection: original.facts,
                  ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
                }),
              );
              const checked = running.settled.then((result) => {
                if (
                  result.kind === 'response' &&
                  result.response.kind === 'error' &&
                  result.response.body.error.code === 'allocation_expired'
                )
                  owner.endOwner();
                if (result.kind !== 'response' || result.response.kind !== 'success') return result;
                const pageContext = historyContext(result.response.body.data);
                if (context && !sameHistory(context, pageContext))
                  return {
                    kind: 'failed',
                    code: 'invalid_http',
                    context: result.context,
                  } satisfies WaitResult<HistoryReply>;
                try {
                  retain(
                    reservation,
                    (Object.values(pageContext).reduce((size, field) => size + field.length, 0) +
                      (result.response.body.data.next_page_token?.length ?? 0)) *
                      8 +
                      512,
                    true,
                  );
                } catch (error) {
                  return {
                    kind: 'failed',
                    code: failureCode(error),
                    context: result.context,
                  } satisfies WaitResult<HistoryReply>;
                }
                context ??= pageContext;
                const code = owner.invalid();
                if (code || abandoned || stopped)
                  return {
                    kind: 'failed',
                    code: code ?? 'closed',
                    context: result.context,
                  } satisfies WaitResult<HistoryReply>;
                return result;
              });
              return await checked;
            } catch (error) {
              return refusal(failureCode(error));
            } finally {
              active = undefined;
              resolveActive();
            }
          };
          const result = await callerAttempt(crypto.randomUUID(), execute()).wait(options.signal);
          if (result.kind === 'response' && result.response.kind === 'success') {
            const code = owner.invalid();
            if (abandoned || stopped || code)
              return { kind: 'failed', code: code ?? 'closed', context: result.context };
            token = result.response.body.data.next_page_token ?? undefined;
            finished = result.response.body.data.next_page_token === null;
          }
          return result;
        },
        release: (options: RequestOptions = {}) => {
          if (options.signal?.aborted)
            return session.refuse<ResponseOf<'ReleaseHistoryView'>>(
              'ReleaseHistoryView',
              'cancelled',
            ).settled;
          const settled = release(options).catch(
            (error) =>
              session.refuse<ResponseOf<'ReleaseHistoryView'>>(
                'ReleaseHistoryView',
                failureCode(error),
              ).settled,
          );
          return callerAttempt(crypto.randomUUID(), settled).wait(options.signal);
        },
        async close(
          options: Omit<RequestOptions, 'signal'> = {},
        ): ReturnType<HistoryView['close']> {
          abandoned = true;
          if (active) await active;
          if (context && owner.invalid() === undefined) return release(options, true);
          if (owner.evidence === 'unallocated') forget(key, reservation);
          return { kind: 'abandoned', evidence: owner.evidence };
        },
      });
      reservation.ended = () => owner.ended();
      reservation.close = () => view.close({ timeoutMs: Math.min(session.timeoutMs, 5000) });
      reservations.set(key, reservation);
      return view;
    };
  }

  function assigned(
    input: Exclude<RequestOf<'GetAssignedTasks'>, { page_token: string }>,
  ): AssignedInstructions {
    const binding = exchanges.GetAssignedTasks;
    const { key, facts, reservation } = reserve(binding.request.schema, input, (facts) =>
      JSON.stringify([
        'GetAssignedTasks',
        'page_token' in facts ? facts.page_token : facts.read_id,
      ]),
    );
    const original = submission(binding, facts, session.requestBudget);
    if ('page_token' in original.facts) {
      retainedBytes -= reservation.bytes;
      throw new SdkError('invalid_value');
    }
    const state = session.state;
    if (state.kind !== 'ready') throw new SdkError(state.reason);
    const datasetId = state.datasetId,
      coreRunId = state.health.core_run_id,
      epoch = session.datasetEpoch;
    let context: Omit<AssignedTasks, 'tasks' | 'next_page_token'> | undefined;
    let token: string | undefined;
    let ended = false,
      closed = false,
      busy = false;
    let pending: Promise<unknown> | undefined;
    const handle = Object.freeze({
      selection: original.facts,
      get context() {
        return context;
      },
      async next(
        options: RequestOptions = {},
      ): Promise<WaitResult<ResponseOf<'GetAssignedTasks'>> | { kind: 'end' }> {
        const refuse = (code: LocalCode) =>
          session.refuse<ResponseOf<'GetAssignedTasks'>>('GetAssignedTasks', code).settled;
        if (closed || stopped) return refuse('closed');
        if (session.datasetEpoch !== epoch) return refuse('dataset_invalidated');
        if (session.state.kind !== 'ready') return refuse(session.state.reason);
        if (session.state.health.core_run_id !== coreRunId) return refuse('superseded');
        if (busy || options.signal?.aborted) return refuse(busy ? 'capacity' : 'cancelled');
        if (ended) return { kind: 'end' };
        busy = true;
        try {
          const request =
            token === undefined
              ? original
              : submission(binding, { page_token: token }, session.requestBudget);
          const running = session.start(binding, request, {
            datasetId,
            coreRunId,
            selection: original.facts,
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          });
          pending = running.settled;
          void running.settled.then(() => {
            busy = false;
            pending = undefined;
          });
          const result = await running.wait(options.signal);
          if (result.kind !== 'response' || result.response.kind !== 'success') return result;
          const after = (() => session.state)();
          if (
            closed ||
            stopped ||
            session.datasetEpoch !== epoch ||
            after.kind !== 'ready' ||
            after.health.core_run_id !== coreRunId
          )
            return {
              kind: 'failed',
              code:
                closed || stopped
                  ? 'closed'
                  : session.datasetEpoch !== epoch
                    ? 'dataset_invalidated'
                    : 'superseded',
              context: result.context,
            };
          const { tasks: _tasks, next_page_token, ...nextContext } = result.response.body.data;
          if (
            nextContext.core_run_id !== coreRunId ||
            (context && JSON.stringify(context) !== JSON.stringify(nextContext))
          )
            return { kind: 'failed', code: 'invalid_http', context: result.context };
          if (!context) {
            const {
              tasks: _tasksSchema,
              next_page_token: _tokenSchema,
              ...contextFields
            } = AssignedTasks.shape;
            const budget = {
              ...session.responseBudget,
              maxBytes: Math.min(
                session.responseBudget.maxBytes,
                Math.floor((maximumBytes - retainedBytes) / 8),
              ),
            };
            if (budget.maxBytes < 1) throw new SdkError('capacity');
            const bytes = writeJson(contract(z.strictObject(contextFields)), nextContext, budget);
            retain(reservation, bytes.byteLength * 8 + (next_page_token?.length ?? 0) * 8, true);
            context = freeze(nextContext);
          } else
            retain(
              reservation,
              reservation.pageBytes - (token?.length ?? 0) * 8 + (next_page_token?.length ?? 0) * 8,
              true,
            );
          token = next_page_token ?? undefined;
          ended = next_page_token === null;
          return result;
        } catch (error) {
          busy = false;
          return refuse(failureCode(error));
        }
      },
      close() {
        closed = true;
        token = undefined;
      },
    });
    reservation.ended = () =>
      closed ||
      session.datasetEpoch !== epoch ||
      (session.state.kind === 'ready' && session.state.health.core_run_id !== coreRunId);
    reservation.close = async () => {
      handle.close();
      if (pending) await pending;
      return { kind: 'local' };
    };
    reservations.set(key, reservation);
    return handle;
  }

  function contact(input: ContactSelection): ContactRequest {
    const { key, facts, reservation } = reserve(contactSelection, input, (facts) =>
      JSON.stringify(['BeginAssetContact', facts.asset_id]),
    );
    const owner = allocationOwner(reservation);
    let challenge:
      | Extract<ResponseOf<'BeginAssetContact'>, { kind: 'success' }>['body']['data']
      | undefined;
    let latestChallengeExpiry = Infinity;
    const checkIn = operations.bindTransport(
      exchanges.UpdateAsset,
      policies.UpdateAsset,
      (submission, options) => {
        const running = session.start(exchanges.UpdateAsset, submission, options);
        void running.settled.then((result) => {
          if (result.kind === 'response' && result.response.kind === 'success') owner.acknowledge();
        });
        return running;
      },
    );
    const replace = operations.bindTransport(
      exchanges.ReplaceAssetProcess,
      policies.ReplaceAssetProcess,
      (submission, options) => {
        const running = session.start(exchanges.ReplaceAssetProcess, submission, options);
        void running.settled.then((result) => {
          if (result.kind === 'response' && result.response.kind === 'success') owner.acknowledge();
        });
        return running;
      },
    );
    let original:
      | ReturnType<typeof submission<typeof exchanges.BeginAssetContact.request.schema>>
      | undefined;
    let pending: Promise<unknown> | undefined;
    let closed = false;
    const handle = Object.freeze({
      selection: facts,
      get allocation() {
        return owner.allocation;
      },
      get releaseEvidence() {
        return owner.evidence;
      },
      checkIn(input: RequestOf<'UpdateAsset'>) {
        if (closed || stopped) throw new SdkError('closed');
        if (session.datasetId !== owner.allocation?.datasetId)
          throw new SdkError('dataset_invalidated');
        const validated = component(
          exchanges.UpdateAsset.request.schema,
          input,
          session.requestBudget,
        );
        if (
          facts.mode !== 'current' ||
          !challenge ||
          validated.asset_id !== facts.asset_id ||
          validated.report?.origin.process_generation !== facts.process_generation ||
          validated.report.dataset_id !== owner.allocation?.datasetId ||
          validated.report.mode !== 'current' ||
          validated.report.contact_proof?.challenge_id !== challenge.challenge_id
        )
          throw new SdkError('invalid_value');
        return checkIn(validated);
      },
      replace(input: RequestOf<'ReplaceAssetProcess'>) {
        if (closed || stopped) throw new SdkError('closed');
        if (session.datasetId !== owner.allocation?.datasetId)
          throw new SdkError('dataset_invalidated');
        const validated = component(
          exchanges.ReplaceAssetProcess.request.schema,
          input,
          session.requestBudget,
        );
        if (
          facts.mode !== 'replace' ||
          !challenge ||
          validated.asset_id !== facts.asset_id ||
          validated.process_generation !== facts.process_generation ||
          validated.expected_process_generation !== facts.expected_process_generation ||
          validated.challenge_id !== challenge.challenge_id ||
          validated.first_report.dataset_id !== owner.allocation?.datasetId
        )
          throw new SdkError('invalid_value');
        return replace(validated);
      },
      async read(
        options: RequestOptions = {},
      ): Promise<WaitResult<ResponseOf<'BeginAssetContact'>>> {
        const refuse = (code: LocalCode) =>
          session.refuse<ResponseOf<'BeginAssetContact'>>('BeginAssetContact', code).settled;
        if (closed || stopped) return refuse('closed');
        if (pending || options.signal?.aborted) return refuse(pending ? 'capacity' : 'cancelled');
        const invalid = owner.invalid();
        if (invalid) return refuse(invalid);
        let done: () => void = () => undefined;
        pending = new Promise<void>((resolve) => {
          done = resolve;
        });
        const execute = async (): Promise<AttemptResult<ResponseOf<'BeginAssetContact'>>> => {
          try {
            const health = await owner.allocate();
            if (health !== undefined) {
              if (health.kind === 'response') {
                if (health.response.kind === 'error')
                  return { ...health, response: health.response };
                return refuse('superseded');
              }
              return health.kind === 'cancelled' ? refuse('cancelled') : health;
            }
            const allocation = owner.allocation;
            const code = owner.invalid();
            if (closed || stopped || code || !allocation)
              return refuse(closed || stopped ? 'closed' : (code ?? 'superseded'));
            original ??= submission(
              exchanges.BeginAssetContact,
              { ...facts, allocation_context: allocation.allocationContext },
              session.requestBudget,
            );
            const attempt = owner.started(
              session.start(exchanges.BeginAssetContact, original, {
                datasetId: allocation.datasetId,
                coreRunId: allocation.coreRunId,
                ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
              }),
            );
            const checked = attempt.settled.then((result) => {
              if (
                result.kind === 'response' &&
                result.response.kind === 'error' &&
                result.response.body.error.code === 'allocation_expired'
              )
                owner.endOwner();
              if (result.kind === 'response' && result.response.kind === 'success') {
                const data = result.response.body.data;
                if (
                  data.core_run_id !== allocation.coreRunId ||
                  (challenge && JSON.stringify(challenge) !== JSON.stringify(data))
                )
                  return {
                    kind: 'failed',
                    code: 'invalid_http',
                    context: result.context,
                  } satisfies WaitResult<ResponseOf<'BeginAssetContact'>>;
                if (!challenge) {
                  challenge = data;
                  latestChallengeExpiry = performance.now() + 10_000;
                }
              }
              return result;
            });
            return await checked;
          } catch (error) {
            return refuse(failureCode(error));
          } finally {
            pending = undefined;
            done();
          }
        };
        const result = await callerAttempt(crypto.randomUUID(), execute()).wait(options.signal);
        if (result.kind === 'response' && result.response.kind === 'success') {
          const code = owner.invalid();
          if (closed || stopped || code)
            return { kind: 'failed', code: code ?? 'closed', context: result.context };
        }
        return result;
      },
      async close(): Promise<RemoteAbandonment> {
        closed = true;
        if (pending) await pending;
        if (owner.evidence === 'unallocated') forget(key, reservation);
        return { kind: 'abandoned', evidence: owner.evidence };
      },
    });
    reservation.ended = () =>
      owner.ended() || (closed && performance.now() >= latestChallengeExpiry);
    reservation.close = handle.close;
    reservations.set(key, reservation);
    return handle;
  }
  const unobserve = session.observe((state) => {
    if (state.kind === 'closed') {
      stopped = true;
      reservations.clear();
      retainedBytes = 0;
      unobserve();
    }
  });
  return Object.freeze({
    history: Object.freeze({
      asset: history(exchanges.GetAssetMovementHistory),
      observation: history(exchanges.GetObservationMovementHistory),
      track: history(exchanges.GetTrackMovementHistory),
    }),
    assigned,
    contact,
    close(drained: Promise<void> = Promise.resolve()): Promise<RemoteCloseResult> {
      if (closing) return closing;
      stopped = true;
      closing = drained.then(async () => {
        const results: Array<RemoteCloseResult[number]> = [];
        const failures: unknown[] = [];
        for (const [identity, reservation] of reservations) {
          try {
            results.push({ identity, result: await reservation.close() });
          } catch (error) {
            failures.push(error);
          }
        }
        unobserve();
        reservations.clear();
        retainedBytes = 0;
        if (failures.length) throw new AggregateError(failures, 'Remote cleanup failed');
        return freeze(results);
      });
      return closing;
    },
  });
}
