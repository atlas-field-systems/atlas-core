# Temporary read contexts

Snapshot captures and frozen history views have one finite owner and expiry.
Allocation retries cannot create another view after a reply is lost.
Contact challenges use the same allocation lifetime, not a new authority model.

## Context before allocation

Authenticated `GetHealth` returns `core_run_id`, `allocation_context`, and
`allocation_expires_at` in `data`. The opaque context binds Dataset, Core run,
allocating key identity for accounting, and a fixed deadline 60 seconds after issue.
Issuing this token allocates no capture or view. Its UTC expiry is display metadata;
Core enforces its own monotonic deadline. Contexts do not survive Restart or Reset.
Key attribution grants no scope. Any currently valid key can retry, continue, or
release the same opaque context; the original allocation keeps its quota charge.

The first allocation supplies that context, a stable `load_id`, `query_id`, or
challenge `request_id`, and all original facts. Core reserves a receipt before
building anything. Exact retries within that context recover the same allocation
and original expiry. Changed facts return `409 allocation_conflict`.
Snapshot/history expiry is the context deadline, without extension on page reads.

Core retains successful, failed, and released receipts until the context expires.
Once expired, the token cannot allocate again even if its receipt has been pruned.
An invalid or old-run context returns `410 allocation_expired`. A lost result can
be retried or left to that known deadline. Starting a replacement before release
acknowledgment or expiry is not automatic recovery.

## Continuation and release

Continuation tokens bind source owner, Dataset, view, exact selection, and position.
Release tokens bind the same owner and view without a position. They are opaque,
not authorization. HTTP operations still require a currently valid key. Tokens
cannot move between HTTP and local SDK views or between Core runs.

Release returns `{released: true}` once that exact allocation is released, already
released, or expired under a still-recognized owner. It never allocates or releases
another view. Wrong Dataset, malformed token, and failed authentication remain
explicit refusals. If owner context is gone, return `410 allocation_expired`;
the old allocation is already unusable. Recheck authority after waits.

Local SDK views use an instance/picture-generation context and the same 60-second
maximum lifetime, with local monotonic enforcement. Local release needs no network.
Complete downloaded data stays locally readable after key rejection as stale and
authorization-required. Local queries, subscriptions, and valid frozen history
views can continue over that complete copy without refreshing it. They emit no
invented network progress. Known Reset, rebuild, required coverage loss, or close
still invalidates the affected view. No network work resumes until changed
credentials are accepted. [SDK](../Atlas%20SDK/picture.md) owns the client workflow.

## Finite bounds and ownership

Before allocation, Core advertises effective finite counts for captures, history
views, per-key allocations, allocation receipts, matching references, and storage.
Deployment defaults and aggregate accounting belong to Core. The shared context
lifetime above remains fixed; deployment budgets cannot extend an existing context.
Reserve counts and bytes before allocation. Excess returns `429 resource_limit`
without partial publication. Expiring a view never deletes retained source data.

SDK owns local-view counts, references, and memory accounting within its existing
picture and journal budgets. These guards are selected implementation requirements,
not measured capacity or a promise of larger retained-history support.

[Synchronization](synchronization.md) · [History queries](history-queries.md)
