# Temporary read contexts

> Retained current design for review. [Planning status](../../../README.md#planning-status).

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
Capacity refusal before receipt reservation creates no allocation or receipt;
the same facts may retry admission within the original live context.
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
cannot move between Core runs or switch to a local SDK owner.

Release returns `{released: true}` once that exact allocation is released, already
released, or expired under a still-recognized owner. It never allocates or releases
another view. Wrong Dataset, malformed token, and failed authentication remain
explicit refusals. If owner context is gone, return `410 allocation_expired`;
the old allocation is already unusable. Recheck authority after waits.

Complete downloaded picture data stays locally readable after key rejection as
stale and authorization-required. Local picture queries and subscriptions emit no
invented network progress. History continuation and release remain HTTP operations
and pause on known rejection. No network work resumes until changed credentials
are accepted. [SDK](synchronization/client-picture.md) owns that client workflow.

## Finite bounds and ownership

Before allocation, Core advertises effective finite counts for captures, history
views, per-key allocations, allocation receipts, matching references, and storage.
Deployment defaults and aggregate accounting belong to Core. The shared context
lifetime above remains fixed; deployment budgets cannot extend an existing context.
Reserve counts and bytes before allocation. Excess returns `429 resource_limit`
without partial publication. Expiring a view never deletes retained source data.

## Advertised limits

`GetHealth.data.temporary_limits` is a required closed object with all fields below.
Fields ending in `_bytes` use the [nonnegative counter string domain](message-limits.md#exact-numeric-domains).
All other fields use the [ordinary integer/count domain](message-limits.md#exact-numeric-domains).
This preserves 2 GiB exactly without widening message-limit integers.
Zero refuses new allocations of that kind. These are effective capacities, not free slots.

| Field | Scope |
| --- | --- |
| `max_snapshot_captures` | Active captures in this Core run |
| `max_snapshot_captures_per_key` | Active captures charged to one allocating key |
| `max_snapshot_bytes` | Bytes per complete capture |
| `max_total_snapshot_bytes` | Bytes across captures |
| `max_history_views` | Active HTTP views in this Core run |
| `max_history_views_per_key` | Active HTTP views charged to one allocating key |
| `max_history_references_per_view` | Matching references per HTTP view |
| `max_total_history_references` | References across HTTP views |
| `max_history_bytes` | Bytes across frozen HTTP history data and indexes |
| `max_contact_challenges` | Outstanding challenges in this Core run |
| `max_allocation_receipts` | All snapshot, HTTP history, and contact receipts in this Core run |

Byte fields count complete stored data and indexes. Receipt counts include all
retained outcomes, including consumed contact proofs, until their contexts expire.
The separate message `limits` object does not acquire these fields. Deployment
owns the values; current authority still applies regardless of quota attribution.

SDK owns picture and journal memory accounting. Core owns all history-view
allocations. These guards are selected requirements, not measured capacity.

[Synchronization](synchronization/contract.md) · [History queries](../entities/history/queries.md)
