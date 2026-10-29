import {
  PROTOCOL_VERSION,
  Secret,
  Uuid,
  contract,
  effectiveBudget,
  exchanges,
  readHttpRequest,
  readJson,
  writeJson,
} from '@atlas/protocol';
import type { Budget, ErrorObject, ExchangeName, HealthData, HttpError } from '@atlas/protocol';
import type { z } from 'zod';
import { SdkError } from './contracts.js';
import type {
  Attempt,
  AttemptResult,
  ConnectionState,
  LocalCode,
  RequestOptions,
  OperationOutcome,
  WaitResult,
} from './contracts.js';
import { exchange, failed, failureCode, freeze, submission } from './http.js';
import type { HttpLease, JsonBinding, JsonReply } from './http.js';
import { createDiagnostics } from './diagnostics.js';
import type {
  DiagnosticInput,
  DiagnosticOptions,
  Diagnostics,
  DiagnosticSource,
} from './diagnostics.js';
import { policies } from './policy.js';
import type { PictureLimits } from './picture-data.js';

export type ClientOptions = Readonly<{
  baseUrl: string;
  credentials: () => string | Promise<string>;
  mode?: 'http' | 'full';
  picture?: PictureLimits;
  diagnostics?: DiagnosticOptions;
  datasetId?: Uuid;
  timeoutMs?: number;
  limits?: Readonly<{
    concurrentAttempts?: number;
    preparedOperations?: number;
    preparedBytes?: number;
    request?: Partial<Budget>;
    response?: Partial<Budget>;
  }>;
}>;
type Accepted = Readonly<{
  credential: string;
  datasetId: string;
  health: HealthData;
}>;
export type ValidatedReply = HttpError | Readonly<{ kind: 'success' | 'content' | 'reference' }>;
export type MutationOwner<T> = Readonly<{
  identity: string;
  attemptNumber: number;
  report: boolean;
  outcome: () => OperationOutcome;
  transmitted: () => void;
  completed: (result: AttemptResult<T>) => void;
}>;
export type NetworkOptions<T> = Readonly<{
  timeoutMs?: number;
  datasetId?: string;
  coreRunId?: string;
  mutation?: MutationOwner<T>;
}>;
export type NetworkLease = HttpLease &
  Readonly<{ datasetId: string; coreRunId: string; current: () => boolean }>;
export type SocketLease = NetworkLease &
  Readonly<{
    release: () => Promise<void>;
  }>;

function limit(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
    throw new SdkError('invalid_options');
  return result;
}

export function attempt<T>(
  id: string,
  settled: Promise<AttemptResult<T>>,
  cancelled?: () => void,
): Attempt<T> {
  return Object.freeze({
    id,
    settled,
    wait(signal?: AbortSignal): Promise<WaitResult<T>> {
      if (!signal) return settled;
      if (signal.aborted) {
        cancelled?.();
        return Promise.resolve({ kind: 'cancelled', attemptId: id });
      }
      return new Promise((resolve) => {
        const cancel = () => {
          cancelled?.();
          resolve({ kind: 'cancelled', attemptId: id });
        };
        signal.addEventListener('abort', cancel, { once: true });
        void settled.then((result) => {
          signal.removeEventListener('abort', cancel);
          resolve(result);
        });
      });
    },
  });
}

export class Session {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxPreparedOperations: number;
  readonly maxPreparedBytes: number;
  readonly #credentials: ClientOptions['credentials'];
  readonly #expectedDataset: string | undefined;
  readonly #requestBudget: Budget;
  readonly #responseBudget: Budget;
  readonly #maximum: number;
  readonly #active = new Map<
    string,
    Readonly<{ controller: AbortController; mutation: boolean }>
  >();
  readonly #jobs = new Set<Promise<unknown>>();
  #accepted: Accepted | undefined;
  readonly #rejectedCredentials = new Set<string>();
  #generation = 0;
  #recovery = 0;
  #datasetEpoch = 0;
  #pendingProviders = 0;
  #state: ConnectionState = {
    kind: 'initializing',
    generation: 0,
    datasetId: null,
    reason: 'not_connected',
  };
  readonly #diagnostics: Diagnostics | undefined;
  readonly #observers = new Set<(state: ConnectionState) => void>();
  #cleanupFailure: LocalCode | undefined;
  #closing: Promise<void> | undefined;

  constructor(options: ClientOptions) {
    const url = new URL(options.baseUrl);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      typeof options.credentials !== 'function' ||
      (options.mode !== undefined && options.mode !== 'http' && options.mode !== 'full')
    )
      throw new SdkError('invalid_options');
    this.baseUrl = url.origin;
    this.#credentials = options.credentials;
    this.#expectedDataset =
      options.datasetId === undefined
        ? undefined
        : readJson(contract(Uuid), writeJson(contract(Uuid), options.datasetId));
    this.timeoutMs = limit(options.timeoutMs, 30_000, 120_000);
    this.#maximum = limit(options.limits?.concurrentAttempts, 16, 64);
    this.maxPreparedOperations = limit(options.limits?.preparedOperations, 1024, 65_536);
    this.maxPreparedBytes = limit(
      options.limits?.preparedBytes,
      16 * 1024 * 1024,
      256 * 1024 * 1024,
    );
    this.#requestBudget = effectiveBudget('http_request', options.limits?.request);
    this.#responseBudget = effectiveBudget('http_response', options.limits?.response);
    this.#diagnostics = createDiagnostics(options.diagnostics, options.mode);
  }

  get state(): ConnectionState {
    return freeze(this.#state);
  }
  get datasetId(): string | null {
    return this.#state.datasetId;
  }
  get datasetEpoch(): number {
    return this.#datasetEpoch;
  }
  get requestBudget(): Budget {
    const limits = this.#accepted?.health.limits;
    return limits === undefined
      ? this.#requestBudget
      : {
          ...this.#requestBudget,
          maxBytes: Math.min(this.#requestBudget.maxBytes, limits.max_request_bytes),
          maxValues: Math.min(this.#requestBudget.maxValues, limits.max_request_json_values),
          maxDepth: Math.min(this.#requestBudget.maxDepth, limits.max_json_depth),
        };
  }
  get responseBudget(): Budget {
    const limits = this.#accepted?.health.limits;
    return limits === undefined
      ? this.#responseBudget
      : {
          ...this.#responseBudget,
          maxBytes: Math.min(this.#responseBudget.maxBytes, limits.max_message_bytes),
          maxValues: Math.min(this.#responseBudget.maxValues, limits.max_json_values),
          maxDepth: Math.min(this.#responseBudget.maxDepth, limits.max_json_depth),
        };
  }

  get diagnosticsEnabled(): boolean {
    return this.#diagnostics !== undefined;
  }
  emit(event: DiagnosticInput): void {
    this.#diagnostics?.record(event);
  }
  #transition(state: ConnectionState, elapsedMs?: number): void {
    this.#state = freeze(state);
    for (const observer of this.#observers) {
      try {
        observer(this.#state);
      } catch {
        // An owner cannot prevent the remaining owners from observing a transition.
      }
    }
    this.#diagnostics?.record({
      kind: 'connection',
      state: state.kind,
      generation: state.generation,
      ...(state.datasetId === null ? {} : { datasetId: state.datasetId }),
      ...(state.kind === 'ready' ? {} : { code: state.reason }),
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
    });
  }

  observe(observer: (state: ConnectionState) => void): () => void {
    if (this.#state.kind === 'closed') throw new SdkError('closed');
    if (this.#observers.size >= this.#maximum) throw new SdkError('capacity');
    this.#observers.add(observer);
    return () => {
      this.#observers.delete(observer);
    };
  }
  observeAuthority(generation: number, code: ErrorObject['code']): void {
    if (generation !== this.#generation || this.#state.kind !== 'ready') return;
    switch (code) {
      case 'unauthorized':
        this.rejectAuthority(generation);
        break;
      case 'protocol_mismatch':
        this.#blocked('protocol_mismatch');
        break;
      case 'dataset_mismatch':
        this.#blocked('dataset_invalidated');
        break;
    }
  }
  #acceptedLease(): Accepted {
    if (this.#state.kind !== 'ready' || !this.#accepted)
      throw new SdkError(this.#state.kind === 'ready' ? 'not_connected' : this.#state.reason);
    return this.#accepted;
  }
  ownSocket(cleanup: () => void | Promise<void>): SocketLease {
    const accepted = this.#acceptedLease();
    const id = crypto.randomUUID();
    const admission = this.#admit(id);
    const generation = this.#generation;
    let released: Promise<void> | undefined;
    const release = (): Promise<void> => {
      if (released) return released;
      admission.signal.removeEventListener('abort', stop);
      released = this.#track(
        Promise.resolve()
          .then(cleanup)
          .catch((error: unknown) => {
            this.#cleanupFailure ??= failureCode(error);
            throw new SdkError(failureCode(error));
          })
          .finally(admission.finish),
      );
      return released;
    };
    const stop = () => {
      void release().catch(() => undefined);
    };
    admission.signal.addEventListener('abort', stop, { once: true });
    return Object.freeze({
      attemptId: id,
      credential: accepted.credential,
      datasetId: accepted.datasetId,
      coreRunId: accepted.health.core_run_id,
      generation,
      baseUrl: this.baseUrl,
      signal: admission.signal,
      current: () =>
        !released &&
        !admission.signal.aborted &&
        this.#state.kind === 'ready' &&
        generation === this.#generation,
      release,
    });
  }
  #stop(reason: LocalCode, preserveMutations = false): void {
    for (const { controller, mutation } of this.#active.values())
      if (!preserveMutations || !mutation) controller.abort(new SdkError(reason));
  }
  #blocked(reason: LocalCode): void {
    this.#recovery++;
    if (reason === 'dataset_invalidated') this.#datasetEpoch++;
    this.#generation++;
    this.#transition({
      kind: 'blocked',
      generation: this.#generation,
      datasetId: this.datasetId,
      reason,
    });
    this.#stop(reason, reason === 'dataset_invalidated');
  }
  #rememberRejected(credential: string): void {
    if (this.#rejectedCredentials.size < 64) this.#rejectedCredentials.add(credential);
  }
  rejectAuthority(generation: number): void {
    if (generation !== this.#generation || this.#state.kind === 'closed') return;
    this.#recovery++;
    if (this.#accepted) this.#rememberRejected(this.#accepted.credential);
    this.#generation++;
    this.#transition({
      kind: 'authorization-required',
      generation: this.#generation,
      datasetId: this.datasetId,
      reason: 'authorization_required',
    });
    this.#stop('authorization_required');
  }

  #admit(id: string, timeout?: number, mutation = false) {
    if (this.#active.size >= this.#maximum) throw new SdkError('capacity');
    const controller = new AbortController();
    this.#active.set(id, { controller, mutation });
    const timer =
      timeout === undefined
        ? undefined
        : setTimeout(() => controller.abort(new SdkError('deadline')), timeout);
    return {
      signal: controller.signal,
      finish: () => {
        clearTimeout(timer);
        this.#active.delete(id);
      },
    };
  }
  #track<T>(promise: Promise<T>): Promise<T> {
    this.#jobs.add(promise);
    void promise.then(
      () => this.#jobs.delete(promise),
      () => this.#jobs.delete(promise),
    );
    return promise;
  }

  #source(operation: ExchangeName): DiagnosticSource {
    switch (policies[operation].kind) {
      case 'upload':
        return 'upload';
      case 'content':
        return 'content';
      case 'reference':
        return 'reference';
      default:
        return 'http';
    }
  }
  #recordAttempt<T extends ValidatedReply>(
    operation: ExchangeName,
    result: AttemptResult<T>,
    mutation?: MutationOwner<T>,
    resolution = false,
    datasetId = this.datasetId,
    generation = this.#generation,
  ): void {
    if (!this.#diagnostics) return;
    const outcome = mutation?.outcome();
    this.#diagnostics.record({
      kind: 'request',
      phase: 'attempt',
      operation,
      source: this.#source(operation),
      ...(datasetId === null ? {} : { datasetId }),
      generation,
      attemptId: result.kind === 'not_sent' ? result.attemptId : result.context.attemptId,
      outcome:
        result.kind === 'response'
          ? result.response.kind === 'error'
            ? 'error'
            : 'success'
          : result.kind,
      elapsedMs: result.kind === 'not_sent' ? 0 : result.context.elapsedMs,
      ...(result.kind === 'not_sent'
        ? {}
        : {
            ...(result.context.validationMs === undefined
              ? {}
              : { validationMs: result.context.validationMs }),
            bytes: {
              received: result.context.receivedBytes,
              observedTransport: result.context.observedTransportBytes ?? null,
              ...(result.context.suppliedBytes === undefined
                ? {}
                : { supplied: result.context.suppliedBytes }),
            },
            ...(result.context.requestId === undefined
              ? {}
              : { requestId: result.context.requestId }),
            ...(result.context.cleanupFailure === undefined
              ? {}
              : { cleanupFailure: result.context.cleanupFailure }),
          }),
      ...(result.kind === 'response'
        ? result.response.kind === 'error'
          ? { code: result.response.body.error.code }
          : {}
        : { code: result.code }),
      ...(mutation === undefined || outcome === undefined
        ? {}
        : {
            retryId: mutation.identity,
            attemptNumber: mutation.attemptNumber,
            intentionalRetry: mutation.attemptNumber > 1,
            report: mutation.report,
            operationOutcome: outcome.kind,
            evidence: outcome.kind === 'dataset_invalidated' ? outcome.evidence.kind : outcome.kind,
            resolution,
          }),
    });
  }
  refuse<T extends ValidatedReply>(
    operation: ExchangeName,
    code: LocalCode,
    id: string = crypto.randomUUID(),
    mutation?: MutationOwner<T>,
  ): Attempt<T> {
    const result = { kind: 'not_sent', code, attemptId: id } satisfies AttemptResult<T>;
    this.#recordAttempt(operation, result, mutation);
    return attempt(id, Promise.resolve(result));
  }
  startNetwork<T extends ValidatedReply>(
    operation: ExchangeName,
    run: (lease: NetworkLease) => Promise<AttemptResult<T>>,
    options: NetworkOptions<T> = {},
  ): Attempt<T> {
    const id = crypto.randomUUID();
    let lease: NetworkLease & { finish: () => void };
    try {
      const accepted = this.#acceptedLease();
      if (options.datasetId !== undefined && options.datasetId !== accepted.datasetId)
        throw new SdkError('dataset_invalidated');
      if (options.coreRunId !== undefined && options.coreRunId !== accepted.health.core_run_id)
        throw new SdkError('superseded');
      const generation = this.#generation;
      lease = {
        ...this.#admit(
          id,
          limit(options.timeoutMs, this.timeoutMs, 120_000),
          options.mutation !== undefined,
        ),
        attemptId: id,
        credential: accepted.credential,
        datasetId: accepted.datasetId,
        coreRunId: accepted.health.core_run_id,
        generation,
        baseUrl: this.baseUrl,
        current: () =>
          this.#state.kind === 'ready' && generation === this.#generation && !lease.signal.aborted,
      };
    } catch (error) {
      return this.refuse(operation, failureCode(error), id, options.mutation);
    }
    const previous = this.#diagnostics ? options.mutation?.outcome() : undefined;
    let cancelledWait = false;
    options.mutation?.transmitted();
    const execute = async (): Promise<AttemptResult<T>> => {
      try {
        let result: AttemptResult<T>;
        const started = performance.now();
        try {
          result = lease.current()
            ? await run(lease)
            : {
                kind: 'not_sent',
                code: lease.signal.aborted ? failureCode(lease.signal.reason) : 'superseded',
                attemptId: id,
              };
        } catch (error) {
          result = failed(error, lease, {
            attemptId: id,
            elapsedMs: performance.now() - started,
            receivedBytes: 0,
          });
        }
        options.mutation?.completed(result);
        if (result.kind === 'response' && result.response.kind === 'error')
          this.observeAuthority(lease.generation, result.response.body.error.code);
        if (
          !options.mutation &&
          result.kind === 'response' &&
          result.response.kind !== 'error' &&
          (lease.generation !== this.#generation || lease.signal.aborted)
        )
          result = {
            kind: 'failed',
            code: lease.signal.aborted ? failureCode(lease.signal.reason) : 'superseded',
            context: result.context,
          };
        const resolved = this.#diagnostics ? options.mutation?.outcome() : undefined;
        this.#recordAttempt(
          operation,
          result,
          options.mutation,
          (cancelledWait ||
            previous?.kind === 'unknown_outcome' ||
            (previous?.kind === 'dataset_invalidated' &&
              previous.evidence.kind === 'unknown_outcome')) &&
            (resolved?.kind === 'accepted' ||
              (resolved?.kind === 'dataset_invalidated' && resolved.evidence.kind === 'accepted')),
          lease.datasetId,
          lease.generation,
        );
        return result;
      } finally {
        lease.finish();
      }
    };
    const started = performance.now();
    return attempt(id, this.#track(Promise.resolve().then(execute)), () => {
      if (cancelledWait) return;
      cancelledWait = true;
      if (!this.#diagnostics) return;
      const outcome = options.mutation?.outcome();
      this.#diagnostics.record({
        kind: 'request',
        phase: 'wait',
        operation,
        source: this.#source(operation),
        attemptId: id,
        generation: lease.generation,
        ...(lease.datasetId === null ? {} : { datasetId: lease.datasetId }),
        elapsedMs: performance.now() - started,
        outcome: 'cancelled',
        ...(options.mutation === undefined || outcome === undefined
          ? {}
          : {
              retryId: options.mutation.identity,
              attemptNumber: options.mutation.attemptNumber,
              operationOutcome: outcome.kind,
              evidence:
                outcome.kind === 'dataset_invalidated' ? outcome.evidence.kind : outcome.kind,
            }),
      });
    });
  }

  start<R extends z.ZodType, S extends z.ZodType<JsonReply>>(
    binding: JsonBinding<R, S>,
    input: Readonly<{ facts: z.output<R>; bytes: Uint8Array }>,
    options: NetworkOptions<z.output<S>> & Readonly<{ selection?: z.output<R> }> = {},
  ): Attempt<z.output<S>> {
    try {
      const accepted = this.#acceptedLease();
      readHttpRequest(
        binding,
        {
          method: binding.method,
          path: binding.path,
          headers: new Headers({
            Authorization: `Bearer ${accepted.credential}`,
            'Atlas-Dataset-ID': accepted.datasetId,
            'Atlas-Protocol-Version': PROTOCOL_VERSION,
            'Content-Type': 'application/json',
          }),
          ...(binding.method === 'POST' ? { body: input.bytes } : {}),
        },
        this.requestBudget,
      );
    } catch (error) {
      const id = crypto.randomUUID();
      return this.refuse(binding.operationId, failureCode(error), id, options.mutation);
    }
    return this.startNetwork(
      binding.operationId,
      (lease) => exchange(binding, input, lease, this.responseBudget, options.selection),
      options,
    );
  }

  read<R extends z.ZodType, S extends z.ZodType<JsonReply>>(binding: JsonBinding<R, S>) {
    return (input: z.output<R>, options: RequestOptions = {}): Promise<WaitResult<z.output<S>>> => {
      const id = crypto.randomUUID();
      if (options.signal?.aborted)
        return this.refuse<z.output<S>>(binding.operationId, 'cancelled', id).settled;
      try {
        const facts = submission(binding, input, this.requestBudget);
        return this.start(
          binding,
          facts,
          options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
        ).wait(options.signal);
      } catch (error) {
        return this.refuse<z.output<S>>(binding.operationId, failureCode(error), id).settled;
      }
    };
  }

  discover(
    recover = false,
  ): Promise<WaitResult<z.output<typeof exchanges.GetHealth.response.schema>>> {
    return this.#track(
      this.#discover(recover).then((result) => {
        if (result.kind !== 'cancelled') this.#recordAttempt('GetHealth', result);
        return result;
      }),
    );
  }
  #currentDiscovery(recovery: number): boolean {
    return this.#state.kind !== 'closed' && recovery === this.#recovery;
  }
  async #discover(
    recover: boolean,
  ): Promise<WaitResult<z.output<typeof exchanges.GetHealth.response.schema>>> {
    const started = performance.now();
    const id = crypto.randomUUID();
    const denied = (code: LocalCode) =>
      ({ kind: 'not_sent', code, attemptId: id }) satisfies AttemptResult<never>;
    if (this.#state.kind === 'closed') return denied('closed');
    if (
      !recover &&
      (this.#state.kind === 'authorization-required' ||
        (this.#accepted !== undefined && this.#rejectedCredentials.has(this.#accepted.credential)))
    )
      return denied('authorization_required');
    if (this.#active.size >= this.#maximum || this.#pendingProviders >= this.#maximum)
      return denied('capacity');
    const recovery = ++this.#recovery;
    const generation = this.#generation;
    const admission = this.#admit(id, this.timeoutMs);
    try {
      let credential: string;
      try {
        let candidate: string;
        if (!recover && this.#accepted) candidate = this.#accepted.credential;
        else {
          candidate = await new Promise<string>((resolve, reject) => {
            const cancel = () => reject(admission.signal.reason);
            admission.signal.addEventListener('abort', cancel, { once: true });
            this.#pendingProviders++;
            const finish = () => {
              this.#pendingProviders--;
              admission.signal.removeEventListener('abort', cancel);
            };
            Promise.resolve()
              .then(this.#credentials)
              .then(
                (value) => {
                  finish();
                  resolve(value);
                },
                (error) => {
                  finish();
                  reject(error);
                },
              );
          });
        }
        credential = readJson(contract(Secret), writeJson(contract(Secret), candidate));
      } catch (error) {
        return denied(failureCode(error));
      }
      if (!this.#currentDiscovery(recovery)) return denied('superseded');
      if (
        recover &&
        (this.#rejectedCredentials.has(credential) || credential === this.#accepted?.credential)
      )
        return denied('unchanged_credential');
      if (this.#rejectedCredentials.size >= 64) return denied('capacity');
      const result = await exchange(
        exchanges.GetHealth,
        submission(exchanges.GetHealth, {}, this.#requestBudget),
        {
          attemptId: id,
          credential,
          datasetId: null,
          generation: this.#generation,
          baseUrl: this.baseUrl,
          signal: admission.signal,
        },
        this.#responseBudget,
      );
      if (
        result.kind === 'response' &&
        result.response.kind === 'error' &&
        result.response.body.error.code === 'unauthorized'
      )
        this.#rememberRejected(credential);
      if (!this.#currentDiscovery(recovery)) {
        return result.kind === 'not_sent'
          ? result
          : ({
              kind: 'failed',
              code: 'superseded',
              context: result.context,
            } satisfies AttemptResult<never>);
      }
      if (result.kind === 'response' && result.response.kind === 'success') {
        const { dataset_id: datasetId, data: health } = result.response.body;
        if (this.#expectedDataset !== undefined && datasetId !== this.#expectedDataset) {
          if (!recover) this.#blocked('dataset_invalidated');
          return {
            kind: 'failed',
            code: 'dataset_invalidated',
            context: result.context,
          } satisfies AttemptResult<never>;
        }
        const changed =
          this.#state.kind !== 'ready' ||
          this.#accepted?.credential !== credential ||
          this.#accepted.datasetId !== datasetId ||
          this.#accepted.health.core_run_id !== health.core_run_id;
        if (changed) {
          // An original-Dataset write may still deliver its committed reply.
          this.#stop(
            'superseded',
            this.#accepted !== undefined && this.#accepted.datasetId !== datasetId,
          );
          this.#generation++;
        }
        if (this.#accepted && this.#accepted.datasetId !== datasetId) this.#datasetEpoch++;
        this.#accepted = { credential, datasetId, health };
        this.#transition(
          { kind: 'ready', generation: this.#generation, datasetId, health },
          performance.now() - started,
        );
      } else if (
        result.kind === 'response' &&
        result.response.kind === 'error' &&
        result.response.body.error.code === 'unauthorized'
      ) {
        if (this.#accepted === undefined || credential === this.#accepted.credential)
          this.rejectAuthority(generation);
      } else if (this.#state.kind !== 'ready' && this.#state.kind !== 'authorization-required') {
        this.#blocked(result.kind === 'response' ? 'not_connected' : result.code);
      } else if (result.kind === 'response' && result.response.kind === 'error') {
        this.observeAuthority(generation, result.response.body.error.code);
      } else if (
        result.kind === 'failed' &&
        !recover &&
        this.#state.kind !== 'authorization-required' &&
        !['network', 'deadline', 'cancelled'].includes(result.code)
      ) {
        this.#blocked(result.code);
      }
      return result;
    } finally {
      admission.finish();
    }
  }

  refreshHealth(): Promise<WaitResult<z.output<typeof exchanges.GetHealth.response.schema>>> {
    if (this.#state.kind !== 'ready') {
      return Promise.resolve({
        kind: 'not_sent',
        code: this.#state.reason,
        attemptId: crypto.randomUUID(),
      });
    }
    return this.discover();
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = Promise.resolve().then(async () => {
      await Promise.allSettled(this.#jobs);
      this.#accepted = undefined;
      this.#rejectedCredentials.clear();
      if (this.#cleanupFailure) throw new SdkError(this.#cleanupFailure);
    });
    this.#diagnostics?.close();
    this.#recovery++;
    this.#generation++;
    this.#transition({
      kind: 'closed',
      generation: this.#generation,
      datasetId: this.datasetId,
      reason: 'closed',
    });
    this.#stop('closed');
    this.#observers.clear();
    return this.#closing;
  }
}
