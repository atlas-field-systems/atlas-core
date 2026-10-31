import { exchanges } from '@atlas/protocol';
import type { ErrorObject, ExchangeName, ResourceKind } from '@atlas/protocol';
import { SdkError } from './contracts.js';
import type { ConnectionState, EffectEvidence, LocalCode, OperationOutcome } from './contracts.js';

export type DiagnosticSource = 'http' | 'picture' | 'wss' | 'upload' | 'content' | 'reference';
export type DiagnosticOperation = ExchangeName | 'picture' | 'socket';
export type DiagnosticCode = LocalCode | ErrorObject['code'];
export type DiagnosticBytes = Readonly<{
  supplied?: number;
  received?: number;
  observedTransport?: number | null;
}>;
export type CodeFrame =
  | Readonly<{ kind: 'unavailable' }>
  | Readonly<{ kind: 'location'; module: string; function: string; line: number; column: number }>;
export type DiagnosticReason =
  | 'expired_replay'
  | 'expired_capture'
  | 'dataset_change'
  | 'capacity_change'
  | 'invalid_input'
  | 'authorization'
  | 'transport'
  | 'capacity'
  | 'closed';
export type DiagnosticInput =
  | Readonly<{
      kind: 'request';
      operation: DiagnosticOperation;
      source: DiagnosticSource;
      phase: 'attempt' | 'wait' | 'read' | 'validation' | 'transfer';
      outcome: 'success' | 'error' | 'failed' | 'not_sent' | 'cancelled';
      elapsedMs: number;
      validationMs?: number;
      bytes?: DiagnosticBytes;
      datasetId?: string;
      generation?: number;
      attemptId?: string;
      requestId?: string;
      retryId?: string;
      attemptNumber?: number;
      intentionalRetry?: boolean;
      operationOutcome?: OperationOutcome['kind'];
      evidence?: EffectEvidence['kind'];
      resolution?: boolean;
      report?: boolean;
      stale?: boolean;
      code?: DiagnosticCode;
      cleanupFailure?: LocalCode;
      frames?: readonly CodeFrame[];
    }>
  | Readonly<{
      kind: 'connection';
      state: ConnectionState['kind'] | 'disconnected' | 'reconnecting';
      generation: number;
      datasetId?: string;
      elapsedMs?: number;
      backoffMs?: number;
      socketId?: string;
      code?: DiagnosticCode;
    }>
  | Readonly<{
      kind: 'synchronization';
      phase:
        | 'capture'
        | 'reuse'
        | 'page'
        | 'handoff'
        | 'replay'
        | 'live'
        | 'rebuild'
        | 'capacity'
        | 'gap'
        | 'apply';
      generation: number;
      datasetId?: string;
      resource?: ResourceKind;
      reason?: DiagnosticReason;
      loadId?: string;
      cursor?: string;
      elapsedMs?: number;
      bytes?: DiagnosticBytes;
      receivedCommits?: number;
      appliedCommits?: number;
      pages?: number;
    }>;
export type OperationSummary = Readonly<{
  operation: DiagnosticOperation;
  attempts: number;
  successes: number;
  failures: number;
  notSent: number;
  cancelledWaits: number;
  mutations: number;
  unknownOutcomes: number;
  resolutions: number;
  reads: number;
  staleReads: number;
  suppliedBytes: number;
  receivedBytes: number;
  observedTransportBytes: number | null;
  sources: Readonly<Record<DiagnosticSource, number>>;
  observedTransportSamples: number;
  unavailableTransportSamples: number;
  validationMs: number;
  localWorkMs: number;
  durationBuckets: readonly [number, number, number, number, number];
}>;
type DiagnosticContext = Readonly<{
  timestamp: string;
  release: '0.4.0';
  instanceId: string;
  mode: 'http' | 'full';
  detail: 'summary' | 'debug';
  datasetId?: string;
  generation?: number;
}>;
export type DiagnosticEvent = DiagnosticContext &
  (
    | DiagnosticInput
    | Readonly<{
        kind: 'summary';
        elapsedMs: number;
        operations: readonly OperationSummary[];
        reasons: readonly Readonly<{ reason: DiagnosticReason; count: number }>[];
        receivedCommits: number;
        appliedCommits: number;
        pages: number;
        omitted: number;
      }>
  );
export type DiagnosticObserver = (event: DiagnosticEvent) => void;
export type DiagnosticOptions =
  | Readonly<{ mode: 'disabled' }>
  | Readonly<{ mode: 'summary' | 'debug'; observer: DiagnosticObserver }>;
export type DiagnosticEmitter = (event: DiagnosticInput) => void;

type Counts = { -readonly [K in keyof OperationSummary]: OperationSummary[K] };
const reasons: readonly DiagnosticReason[] = [
  'expired_replay',
  'expired_capture',
  'dataset_change',
  'capacity_change',
  'invalid_input',
  'authorization',
  'transport',
  'capacity',
  'closed',
];
function counts(operation: DiagnosticOperation): Counts {
  return {
    operation,
    attempts: 0,
    successes: 0,
    failures: 0,
    notSent: 0,
    cancelledWaits: 0,
    mutations: 0,
    unknownOutcomes: 0,
    resolutions: 0,
    reads: 0,
    staleReads: 0,
    suppliedBytes: 0,
    receivedBytes: 0,
    observedTransportBytes: null,
    sources: { http: 0, picture: 0, wss: 0, upload: 0, content: 0, reference: 0 },
    observedTransportSamples: 0,
    unavailableTransportSamples: 0,
    validationMs: 0,
    localWorkMs: 0,
    durationBuckets: [0, 0, 0, 0, 0],
  };
}
function duration(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
function add(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + duration(right));
}
function bytes(value: DiagnosticBytes): DiagnosticBytes {
  return Object.freeze({
    ...(value.supplied === undefined ? {} : { supplied: duration(value.supplied) }),
    ...(value.received === undefined ? {} : { received: duration(value.received) }),
    ...(value.observedTransport === undefined
      ? {}
      : {
          observedTransport:
            value.observedTransport === null ? null : duration(value.observedTransport),
        }),
  });
}

export function createDiagnostics(
  options: DiagnosticOptions | undefined,
  mode: 'http' | 'full' = 'http',
): Diagnostics | undefined {
  if (options === undefined || options.mode === 'disabled') return undefined;
  if (
    (options.mode !== 'summary' && options.mode !== 'debug') ||
    typeof options.observer !== 'function'
  )
    throw new SdkError('invalid_options');
  return new Diagnostics(options, mode);
}

export class Diagnostics {
  readonly #mode: 'summary' | 'debug';
  readonly #readMode: 'http' | 'full';
  readonly #instance = crypto.randomUUID();
  #observer: DiagnosticObserver | undefined;
  readonly #queue: DiagnosticEvent[] = [];
  readonly #operations = new Map<DiagnosticOperation, Counts>(
    [
      ...Object.values(exchanges).map((exchange) => counts(exchange.operationId)),
      counts('picture'),
      counts('socket'),
    ].map((entry) => [entry.operation, entry]),
  );
  readonly #reasons = new Map(reasons.map((reason) => [reason, 0]));
  #delivery: ReturnType<typeof setTimeout> | undefined;
  #summary: ReturnType<typeof setTimeout> | undefined;
  #started = performance.now();
  readonly #recent: number[] = [];
  #omitted = 0;
  #active = false;
  #receivedCommits = 0;
  #appliedCommits = 0;
  #pages = 0;
  #datasetId: string | undefined;
  #generation: number | undefined;

  constructor(
    options: Extract<DiagnosticOptions, { observer: DiagnosticObserver }>,
    mode: 'http' | 'full' = 'http',
  ) {
    this.#readMode = mode;
    this.#mode = options.mode;
    this.#observer = options.observer;
  }
  #string(value: string): string {
    if (value.length <= 256) return value;
    this.#omitted = add(this.#omitted, 1);
    return '[omitted]';
  }
  #frames(input: readonly CodeFrame[] | undefined): readonly CodeFrame[] {
    if (!input?.length) return Object.freeze([Object.freeze({ kind: 'unavailable' })]);
    if (input.length > 16) this.#omitted = add(this.#omitted, input.length - 16);
    return Object.freeze(
      input.slice(0, 16).map((frame): CodeFrame => {
        if (frame.kind === 'unavailable') return Object.freeze({ kind: 'unavailable' });
        if (
          frame.module.length > 256 ||
          frame.function.length > 256 ||
          !/^[a-z][a-z0-9-]*\.ts$/.test(frame.module) ||
          !/^[A-Za-z_$][A-Za-z0-9_$.#]*$/.test(frame.function) ||
          !Number.isSafeInteger(frame.line) ||
          frame.line < 1 ||
          !Number.isSafeInteger(frame.column) ||
          frame.column < 1
        ) {
          this.#omitted = add(this.#omitted, 1);
          return Object.freeze({ kind: 'unavailable' });
        }
        return Object.freeze({
          kind: 'location',
          module: frame.module,
          function: frame.function,
          line: frame.line,
          column: frame.column,
        });
      }),
    );
  }
  #context(detail: 'summary' | 'debug'): DiagnosticContext {
    return {
      timestamp: new Date().toISOString(),
      release: '0.4.0' satisfies '0.4.0',
      instanceId: this.#instance,
      mode: this.#readMode,
      detail,
      ...(this.#datasetId === undefined ? {} : { datasetId: this.#datasetId }),
      ...(this.#generation === undefined ? {} : { generation: this.#generation }),
    };
  }
  #enqueue(record: DiagnosticEvent): boolean {
    const now = performance.now();
    while (this.#recent[0] !== undefined && now - this.#recent[0] >= 1000) this.#recent.shift();
    if (this.#queue.length >= 128 || (this.#mode === 'debug' && this.#recent.length >= 100)) {
      this.#omitted = add(this.#omitted, 1);
      return false;
    }
    if (this.#mode === 'debug') this.#recent.push(now);
    this.#queue.push(Object.freeze(record));
    this.#delivery ??= setTimeout(() => this.#deliver(), 0);
    return true;
  }
  #deliver(): void {
    this.#delivery = undefined;
    const count = this.#queue.length;
    for (let i = 0; i < count; i++) {
      const record = this.#queue.shift();
      if (!this.#observer || !record) break;
      try {
        this.#observer(record);
      } catch {
        this.#omitted = add(this.#omitted, 1);
      }
    }
  }
  record(event: DiagnosticInput): void {
    if (!this.#observer) return;
    if (event.datasetId !== undefined) this.#datasetId = this.#string(event.datasetId);
    if (event.generation !== undefined) this.#generation = event.generation;
    this.#active = true;
    this.#summary ??= setTimeout(() => this.#flush(), 30_000);
    if (event.kind === 'request') {
      const counter = this.#operations.get(event.operation);
      if (counter) {
        counter.sources = {
          ...counter.sources,
          [event.source]: add(counter.sources[event.source], 1),
        };
        if (event.bytes?.observedTransport === null)
          counter.unavailableTransportSamples = add(counter.unavailableTransportSamples, 1);
        else if (event.bytes?.observedTransport !== undefined)
          counter.observedTransportSamples = add(counter.observedTransportSamples, 1);
        if (event.phase === 'attempt') {
          counter.attempts = add(counter.attempts, 1);
          if (event.outcome === 'success') counter.successes = add(counter.successes, 1);
          else if (event.outcome === 'not_sent') counter.notSent = add(counter.notSent, 1);
          else counter.failures = add(counter.failures, 1);
          if (event.retryId !== undefined && event.attemptNumber === 1)
            counter.mutations = add(counter.mutations, 1);
          if (event.operationOutcome === 'unknown_outcome' || event.evidence === 'unknown_outcome')
            counter.unknownOutcomes = add(counter.unknownOutcomes, 1);
          if (event.resolution) counter.resolutions = add(counter.resolutions, 1);
        }
        if (event.phase === 'wait' && event.outcome === 'cancelled')
          counter.cancelledWaits = add(counter.cancelledWaits, 1);
        if (event.phase === 'read' || (event.phase === 'attempt' && event.retryId === undefined)) {
          counter.reads = add(counter.reads, 1);
          if (event.stale) counter.staleReads = add(counter.staleReads, 1);
        }
        counter.receivedBytes = add(counter.receivedBytes, event.bytes?.received ?? 0);
        counter.suppliedBytes = add(counter.suppliedBytes, event.bytes?.supplied ?? 0);
        if (event.bytes?.observedTransport !== undefined && event.bytes.observedTransport !== null)
          counter.observedTransportBytes = add(
            counter.observedTransportBytes ?? 0,
            event.bytes.observedTransport,
          );
        counter.validationMs = add(counter.validationMs, event.validationMs ?? 0);
        if (event.phase === 'validation')
          counter.localWorkMs = add(counter.localWorkMs, event.elapsedMs);
        const bucket =
          duration(event.elapsedMs) <= 1
            ? 0
            : event.elapsedMs <= 10
              ? 1
              : event.elapsedMs <= 100
                ? 2
                : event.elapsedMs <= 1000
                  ? 3
                  : 4;
        const buckets = [...counter.durationBuckets] satisfies [
          number,
          number,
          number,
          number,
          number,
        ];
        buckets[bucket] = add(buckets[bucket], 1);
        counter.durationBuckets = buckets;
      }
      const failure = event.outcome !== 'success';
      if (this.#mode !== 'debug' && !failure && !(event.retryId !== undefined && !event.report))
        return;
      const detail = this.#mode === 'debug' ? 'debug' : 'summary';
      this.#enqueue({
        ...this.#context(detail),
        kind: 'request',
        operation: event.operation,
        source: event.source,
        phase: event.phase,
        outcome: event.outcome,
        elapsedMs: duration(event.elapsedMs),
        ...(event.validationMs === undefined ? {} : { validationMs: duration(event.validationMs) }),
        ...(event.bytes === undefined ? {} : { bytes: bytes(event.bytes) }),
        ...(event.attemptId === undefined ? {} : { attemptId: this.#string(event.attemptId) }),
        ...(event.requestId === undefined ? {} : { requestId: this.#string(event.requestId) }),
        ...(event.retryId === undefined ? {} : { retryId: this.#string(event.retryId) }),
        ...(event.attemptNumber === undefined ? {} : { attemptNumber: event.attemptNumber }),
        ...(event.intentionalRetry === undefined
          ? {}
          : { intentionalRetry: event.intentionalRetry }),
        ...(event.operationOutcome === undefined
          ? {}
          : { operationOutcome: event.operationOutcome }),
        ...(event.evidence === undefined ? {} : { evidence: event.evidence }),
        ...(event.resolution === undefined ? {} : { resolution: event.resolution }),
        ...(event.stale === undefined ? {} : { stale: event.stale }),
        ...(event.report === undefined ? {} : { report: event.report }),
        ...(event.code === undefined ? {} : { code: event.code }),
        ...(event.cleanupFailure === undefined ? {} : { cleanupFailure: event.cleanupFailure }),
        ...(detail === 'debug' && failure ? { frames: this.#frames(event.frames) } : {}),
      });
    } else if (event.kind === 'connection') {
      this.#enqueue({
        ...this.#context('summary'),
        kind: 'connection',
        state: event.state,
        generation: event.generation,
        ...(event.elapsedMs === undefined ? {} : { elapsedMs: duration(event.elapsedMs) }),
        ...(event.backoffMs === undefined ? {} : { backoffMs: duration(event.backoffMs) }),
        ...(event.socketId === undefined ? {} : { socketId: this.#string(event.socketId) }),
        ...(event.code === undefined ? {} : { code: event.code }),
      });
    } else {
      const picture = this.#operations.get('picture');
      if (picture) {
        picture.receivedBytes = add(picture.receivedBytes, event.bytes?.received ?? 0);
        picture.suppliedBytes = add(picture.suppliedBytes, event.bytes?.supplied ?? 0);
        picture.localWorkMs = add(picture.localWorkMs, event.elapsedMs ?? 0);
        picture.sources = {
          ...picture.sources,
          wss: add(picture.sources.wss, event.receivedCommits ?? 0),
        };
      }
      this.#receivedCommits = add(this.#receivedCommits, event.receivedCommits ?? 0);
      this.#appliedCommits = add(this.#appliedCommits, event.appliedCommits ?? 0);
      this.#pages = add(this.#pages, event.pages ?? 0);
      if (event.reason)
        this.#reasons.set(event.reason, add(this.#reasons.get(event.reason) ?? 0, 1));
      if (this.#mode !== 'debug' && ['page', 'apply', 'live', 'replay'].includes(event.phase))
        return;
      this.#enqueue({
        ...this.#context(this.#mode),
        kind: 'synchronization',
        phase: event.phase,
        generation: event.generation,
        ...(event.resource === undefined ? {} : { resource: event.resource }),
        ...(event.reason === undefined ? {} : { reason: event.reason }),
        ...(event.loadId === undefined ? {} : { loadId: this.#string(event.loadId) }),
        ...(event.cursor === undefined ? {} : { cursor: this.#string(event.cursor) }),
        ...(event.elapsedMs === undefined ? {} : { elapsedMs: duration(event.elapsedMs) }),
        ...(event.bytes === undefined ? {} : { bytes: bytes(event.bytes) }),
        ...(event.receivedCommits === undefined
          ? {}
          : { receivedCommits: duration(event.receivedCommits) }),
        ...(event.appliedCommits === undefined
          ? {}
          : { appliedCommits: duration(event.appliedCommits) }),
        ...(event.pages === undefined ? {} : { pages: duration(event.pages) }),
      });
    }
  }
  #flush(): void {
    this.#summary = undefined;
    if (!this.#observer || !this.#active) return;
    const now = performance.now();
    const record: DiagnosticEvent = {
      ...this.#context('summary'),
      kind: 'summary',
      elapsedMs: duration(now - this.#started),
      operations: Object.freeze(
        [...this.#operations.values()].map((counter) =>
          Object.freeze({
            ...counter,
            sources: Object.freeze({ ...counter.sources }),
            durationBuckets: Object.freeze([...counter.durationBuckets] satisfies [
              number,
              number,
              number,
              number,
              number,
            ]),
          }),
        ),
      ),
      reasons: Object.freeze(
        [...this.#reasons].map(([reason, count]) => Object.freeze({ reason, count })),
      ),
      receivedCommits: this.#receivedCommits,
      appliedCommits: this.#appliedCommits,
      pages: this.#pages,
      omitted: this.#omitted,
    };
    if (!this.#enqueue(record)) {
      this.#summary = setTimeout(() => this.#flush(), 30_000);
      return;
    }
    for (const [operation] of this.#operations) this.#operations.set(operation, counts(operation));
    for (const [reason] of this.#reasons) this.#reasons.set(reason, 0);
    this.#receivedCommits = 0;
    this.#appliedCommits = 0;
    this.#pages = 0;
    this.#omitted = 0;
    this.#active = false;
    this.#started = now;
  }
  close(): void {
    clearTimeout(this.#delivery);
    clearTimeout(this.#summary);
    this.#delivery = undefined;
    this.#summary = undefined;
    this.#observer = undefined;
    this.#queue.length = 0;
    this.#recent.length = 0;
    this.#operations.clear();
    this.#reasons.clear();
    this.#datasetId = undefined;
    this.#generation = undefined;
  }
}
