// AtlasError reports a read failure or a refused local precondition. Mutation
// results never throw for Core rejections or unknown outcomes; they return a
// MutationOutcome so callers keep the distinction between them.
export class AtlasError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "AtlasError";
  }
}

// A validated Core rejection. It carries no request values.
export interface Rejection {
  readonly code: string;
  readonly message: string;
  readonly status: number;
  readonly details?: Readonly<Record<string, unknown>>;
}

// The caller-visible result of one submission attempt.
//
// - accepted: Core committed (or replayed) the request; value is Core's result.
// - rejected: Core explicitly refused this request without effect.
// - unknown_outcome: the request may have reached Core; retry the same
//   descriptor to recover its result. No effect is claimed or denied.
// - dataset_invalidated: Reset is known; the descriptor is obsolete and is
//   never relabelled as a new submission.
// - not_submitted: a local check stopped the request before transmission.
export type MutationOutcome<T> =
  | { readonly outcome: "accepted"; readonly value: T; readonly commitCursor: string; readonly status: number }
  | { readonly outcome: "rejected"; readonly rejection: Rejection }
  | { readonly outcome: "unknown_outcome"; readonly reason: string }
  | { readonly outcome: "dataset_invalidated"; readonly currentDatasetId?: string }
  | { readonly outcome: "not_submitted"; readonly reason: string };

// accepted narrows an outcome to its value or throws a descriptive error.
export function accepted<T>(outcome: MutationOutcome<T>): T {
  if (outcome.outcome === "accepted") return outcome.value;
  const reason =
    outcome.outcome === "rejected"
      ? `${outcome.rejection.code}: ${outcome.rejection.message}`
      : outcome.outcome === "unknown_outcome" || outcome.outcome === "not_submitted"
        ? outcome.reason
        : "Dataset changed";
  throw new AtlasError(outcome.outcome, `Mutation was not accepted (${reason})`);
}
