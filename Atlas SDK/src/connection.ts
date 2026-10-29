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
import type { Budget, HealthData } from '@atlas/protocol';
import type { z } from 'zod';
import { SdkError } from './contracts.js';
import type {
  Attempt,
  AttemptResult,
  ConnectionState,
  DiagnosticEmitter,
  LocalCode,
  RequestOptions,
  WaitResult,
} from './contracts.js';
import { exchange, failureCode, freeze, submission } from './http.js';
import type { HttpLease, JsonBinding, JsonReply } from './http.js';

export type ClientOptions = Readonly<{
  baseUrl: string;
  credentials: () => string | Promise<string>;
  mode?: 'http';
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
type Lease = HttpLease & { finish: () => void };

function limit(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
    throw new SdkError('invalid_options');
  return result;
}

export function attempt<T>(id: string, settled: Promise<AttemptResult<T>>): Attempt<T> {
  return Object.freeze({
    id,
    settled,
    wait(signal?: AbortSignal): Promise<WaitResult<T>> {
      if (!signal) return settled;
      if (signal.aborted) return Promise.resolve({ kind: 'cancelled', attemptId: id });
      return new Promise((resolve) => {
        const cancel = () => {
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
  readonly #active = new Map<string, AbortController>();
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
  #emitter: DiagnosticEmitter | undefined;

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
      (options.mode !== undefined && options.mode !== 'http')
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

  setEmitter(emitter: DiagnosticEmitter | undefined): void {
    this.#emitter = emitter;
  }
  #transition(state: ConnectionState): void {
    this.#state = freeze(state);
    try {
      this.#emitter?.({
        kind: 'connection',
        state: state.kind,
        generation: state.generation,
      });
    } catch {
      // Diagnostic delivery cannot change authority or request outcomes.
    }
  }
  #stop(reason: LocalCode): void {
    for (const controller of this.#active.values()) controller.abort(new SdkError(reason));
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
    this.#stop(reason);
  }
  rejectAuthority(generation: number): void {
    if (generation !== this.#generation || this.#state.kind === 'closed') return;
    this.#recovery++;
    if (this.#accepted) this.#rejectedCredentials.add(this.#accepted.credential);
    this.#generation++;
    this.#transition({
      kind: 'authorization-required',
      generation: this.#generation,
      datasetId: this.datasetId,
      reason: 'authorization_required',
    });
    this.#stop('authorization_required');
  }

  #admit(id: string, timeout: number) {
    if (this.#active.size >= this.#maximum) throw new SdkError('capacity');
    const controller = new AbortController();
    this.#active.set(id, controller);
    const timer = setTimeout(() => controller.abort(new SdkError('deadline')), timeout);
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

  start<R extends z.ZodType, S extends z.ZodType<JsonReply>>(
    binding: JsonBinding<R, S>,
    input: Readonly<{ facts: z.output<R>; bytes: Uint8Array }>,
    options: Readonly<{
      timeoutMs?: number;
      datasetId?: string;
      selection?: z.output<R>;
      mutation?: Readonly<{
        transmitted: () => void;
        completed: (result: AttemptResult<z.output<S>>) => void;
      }>;
    }> = {},
  ): Attempt<z.output<S>> {
    const id = crypto.randomUUID();
    let lease: Lease;
    try {
      if (this.#state.kind !== 'ready' || !this.#accepted) {
        throw new SdkError(this.#state.kind === 'ready' ? 'not_connected' : this.#state.reason);
      }
      if (options.datasetId !== undefined && options.datasetId !== this.datasetId)
        throw new SdkError('dataset_invalidated');
      readHttpRequest(
        binding,
        {
          method: binding.method,
          path: binding.path,
          headers: new Headers({
            Authorization: `Bearer ${this.#accepted.credential}`,
            'Atlas-Dataset-ID': this.#accepted.datasetId,
            'Atlas-Protocol-Version': PROTOCOL_VERSION,
            'Content-Type': 'application/json',
          }),
          ...(binding.method === 'POST' ? { body: input.bytes } : {}),
        },
        this.requestBudget,
      );
      lease = {
        ...this.#admit(id, limit(options.timeoutMs, this.timeoutMs, 120_000)),
        attemptId: id,
        credential: this.#accepted.credential,
        datasetId: this.#accepted.datasetId,
        generation: this.#generation,
        baseUrl: this.baseUrl,
      };
    } catch (error) {
      return attempt(
        id,
        Promise.resolve({
          kind: 'not_sent',
          code: failureCode(error),
          attemptId: id,
        }),
      );
    }
    options.mutation?.transmitted();
    const run = async (): Promise<AttemptResult<z.output<S>>> => {
      try {
        const result = await exchange(
          binding,
          input,
          lease,
          this.responseBudget,
          options.selection,
        );
        options.mutation?.completed(result);
        if (
          result.kind === 'response' &&
          result.response.kind === 'error' &&
          lease.generation === this.#generation
        ) {
          switch (result.response.body.error.code) {
            case 'unauthorized':
              this.rejectAuthority(lease.generation);
              break;
            case 'protocol_mismatch':
              this.#blocked('protocol_mismatch');
              break;
            case 'dataset_mismatch':
              this.#blocked('dataset_invalidated');
              break;
          }
        }
        if (
          !options.mutation &&
          result.kind === 'response' &&
          result.response.kind === 'success' &&
          lease.generation !== this.#generation
        ) {
          return {
            kind: 'failed',
            code: 'superseded',
            context: result.context,
          };
        }
        return result;
      } finally {
        lease.finish();
      }
    };
    return attempt(id, this.#track(run()));
  }

  read<R extends z.ZodType, S extends z.ZodType<JsonReply>>(binding: JsonBinding<R, S>) {
    return (input: z.output<R>, options: RequestOptions = {}): Promise<WaitResult<z.output<S>>> => {
      const id = crypto.randomUUID();
      if (options.signal?.aborted)
        return Promise.resolve({
          kind: 'not_sent',
          code: 'cancelled',
          attemptId: id,
        });
      try {
        const facts = submission(binding, input, this.requestBudget);
        return this.start(
          binding,
          facts,
          options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
        ).wait(options.signal);
      } catch (error) {
        return Promise.resolve({
          kind: 'not_sent',
          code: failureCode(error),
          attemptId: id,
        });
      }
    };
  }

  discover(
    recover = false,
  ): Promise<WaitResult<z.output<typeof exchanges.GetHealth.response.schema>>> {
    return this.#track(this.#discover(recover));
  }
  #currentDiscovery(recovery: number): boolean {
    return this.#state.kind !== 'closed' && recovery === this.#recovery;
  }
  async #discover(
    recover: boolean,
  ): Promise<WaitResult<z.output<typeof exchanges.GetHealth.response.schema>>> {
    const id = crypto.randomUUID();
    const denied = (code: LocalCode) =>
      ({ kind: 'not_sent', code, attemptId: id }) satisfies AttemptResult<never>;
    if (this.#state.kind === 'closed') return denied('closed');
    if (!recover && this.#state.kind === 'authorization-required')
      return denied('authorization_required');
    if (this.#active.size >= this.#maximum || this.#pendingProviders >= this.#maximum)
      return denied('capacity');
    const recovery = ++this.#recovery;
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
          this.#blocked('dataset_invalidated');
          return {
            kind: 'failed',
            code: 'dataset_invalidated',
            context: result.context,
          } satisfies AttemptResult<never>;
        }
        this.#stop('superseded');
        this.#generation++;
        if (this.#accepted && this.#accepted.datasetId !== datasetId) this.#datasetEpoch++;
        this.#accepted = { credential, datasetId, health };
        this.#transition({ kind: 'ready', generation: this.#generation, datasetId, health });
      } else if (
        result.kind === 'response' &&
        result.response.kind === 'error' &&
        result.response.body.error.code === 'unauthorized'
      ) {
        this.#rejectedCredentials.add(credential);
        this.#generation++;
        this.#transition({
          kind: 'authorization-required',
          generation: this.#generation,
          datasetId: this.datasetId,
          reason: 'authorization_required',
        });
        this.#stop('authorization_required');
      } else if (this.#state.kind !== 'authorization-required') {
        this.#blocked(result.kind === 'response' ? 'protocol_mismatch' : result.code);
      }
      return result;
    } finally {
      admission.finish();
    }
  }

  async close(): Promise<void> {
    this.#recovery++;
    this.#generation++;
    this.#transition({
      kind: 'closed',
      generation: this.#generation,
      datasetId: this.datasetId,
      reason: 'closed',
    });
    this.#stop('closed');
    await Promise.allSettled(this.#jobs);
    this.#emitter = undefined;
    this.#accepted = undefined;
    this.#rejectedCredentials.clear();
  }
}
