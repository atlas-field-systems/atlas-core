import type { BoundaryCode, ErrorObject, ExchangeName, HealthData } from '@atlas/protocol';

export type LocalCode =
  | BoundaryCode
  | 'invalid_options'
  | 'not_connected'
  | 'authorization_required'
  | 'unchanged_credential'
  | 'protocol_mismatch'
  | 'dataset_invalidated'
  | 'closed'
  | 'capacity'
  | 'identity_conflict'
  | 'network'
  | 'deadline'
  | 'cancelled'
  | 'superseded';

const localCodes = {
  invalid_json: true,
  invalid_utf8: true,
  invalid_value: true,
  payload_too_large: true,
  resource_limit: true,
  invalid_geometry: true,
  unsupported_geometry: true,
  geometry_limit_exceeded: true,
  invalid_http: true,
  invalid_budget: true,
  invalid_options: true,
  not_connected: true,
  authorization_required: true,
  unchanged_credential: true,
  protocol_mismatch: true,
  dataset_invalidated: true,
  closed: true,
  capacity: true,
  identity_conflict: true,
  network: true,
  deadline: true,
  cancelled: true,
  superseded: true,
} satisfies Record<LocalCode, true>;
export function isLocalCode(value: unknown): value is LocalCode {
  return typeof value === 'string' && Object.hasOwn(localCodes, value);
}

export type Failure = Readonly<{ kind: 'failure'; code: LocalCode }>;
export class SdkError extends Error {
  constructor(readonly code: LocalCode) {
    super(code);
    this.name = 'SdkError';
  }
}

export type AttemptContext = Readonly<{
  attemptId: string;
  requestId?: string;
  elapsedMs: number;
  receivedBytes: number;
  suppliedBytes?: number;
  observedTransportBytes?: number | null;
  validationMs?: number;
  cleanupFailure?: LocalCode;
}>;
export type AttemptResult<T> =
  | Readonly<{ kind: 'response'; response: T; context: AttemptContext }>
  | Readonly<{ kind: 'failed'; code: LocalCode; context: AttemptContext }>
  | Readonly<{ kind: 'not_sent'; code: LocalCode; attemptId: string }>;
export type WaitResult<T> = AttemptResult<T> | Readonly<{ kind: 'cancelled'; attemptId: string }>;
export type Attempt<T> = Readonly<{
  id: string;
  settled: Promise<AttemptResult<T>>;
  wait: (signal?: AbortSignal) => Promise<WaitResult<T>>;
}>;
export type RequestOptions = Readonly<{
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

export type EffectEvidence =
  | Readonly<{ kind: 'not_submitted' }>
  | Readonly<{ kind: 'unknown_outcome' }>
  | Readonly<{ kind: 'rejected'; code: ErrorObject['code'] }>
  | Readonly<{ kind: 'accepted'; attemptId: string; requestId?: string }>;
export type OperationOutcome =
  | EffectEvidence
  | Readonly<{
      kind: 'dataset_invalidated';
      originalDatasetId: string;
      evidence: EffectEvidence;
    }>;
export type Submission<R> = Readonly<{
  datasetId: string;
  operation: ExchangeName;
  identity: string;
  facts: R;
}>;
export type Prepared<R, T> = Readonly<{
  submission: Submission<R>;
  outcome: OperationOutcome;
  start: (options?: Omit<RequestOptions, 'signal'>) => Attempt<T>;
  send: (options?: RequestOptions) => Promise<
    Readonly<{
      attempt: WaitResult<T>;
      outcome: OperationOutcome;
    }>
  >;
}>;

export type ConnectionState =
  | Readonly<{
      kind: 'ready';
      generation: number;
      datasetId: string;
      health: HealthData;
    }>
  | Readonly<{
      kind: 'initializing' | 'authorization-required' | 'blocked' | 'closed';
      generation: number;
      datasetId: string | null;
      reason: LocalCode;
    }>;

export type PictureStatus = Readonly<{
  kind:
    | 'initializing'
    | 'synchronized'
    | 'recovering'
    | 'disconnected'
    | 'resource-limited'
    | 'authorization-required'
    | 'stopped';
  datasetId: string | null;
  generation: number;
  cursor: string | null;
  synchronizedAt: string | null;
}>;
export type PictureRead<T> =
  | Readonly<{
      kind: 'available';
      value: T;
      stale: boolean;
      status: PictureStatus;
    }>
  | Readonly<{ kind: 'unavailable'; status: PictureStatus }>;
