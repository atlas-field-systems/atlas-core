# Numeric ranges and message bounds

> Retained current design for review. [Planning status](../../../README.md#planning-status).

These are initial contract limits, not measured capacity. Deployment settings can
lower admission limits or tune temporary-resource budgets. They cannot silently
truncate retained data or change field ranges within one Protocol version.
Authenticated health and synchronization negotiation expose effective message limits.

## Exact numeric domains

| Domain | Representation and inclusive range unless stated otherwise |
| --- | --- |
| Nonnegative counter, revision, sequence origin | Canonical decimal string `"0"` through `"18446744073709551615"` |
| Positive source/submission sequence | Same string representation, minimum `"1"` |
| Object content byte length | Nonnegative counter string, subject to its smaller file limit |
| Ordinary integer/count/duration | JSON mathematical integer, zero through 2,147,483,647 unless a smaller bound or positive minimum is declared |
| Page size | JSON integer, 1 through 1,000, default 100 |
| Typed floating point | Finite binary64, absolute source value at most `2^1024 - 2^971` |

Canonical counter spelling is `0` or a nonzero digit followed by digits. No plus
sign, leading zero, decimal point, exponent, whitespace, or negative zero is allowed.
Core versions, edit/geometry/queue/control revisions start at zero; first allocated
sequences are one. Never wrap a counter. Refuse an effect requiring overflow with
`409 counter_exhausted` before commit. Opaque commit cursors are not these counters.

Typed floating values round to nearest binary64, ties to even, after exact range
checks. Recheck component bounds and cross-field rules after conversion. Reject
invalid rounded results without clamping or wrapping. Reject a nonzero typed value
that would underflow to zero. Numeric tokens are at most 128 UTF-8 bytes, with any
exponent in -10,000 through 10,000. No parser may first round a fraction into an
integer or an out-of-range value into a valid endpoint.
Quantity-specific ranges, including coordinates, remain in their component definitions.

Timestamps use Gregorian years `0001` through `9999`, UTC `Z`, seconds `00` through
`59`, and an optional one-to-nine-digit fraction. Compare exact nanoseconds and
retain accepted spelling. No leap-second `60`, offset form, or finer fraction is valid.
UUIDs use canonical lowercase hyphenated text. New UUID IDs use UUIDv4. Strings are
Unicode scalar values, with length limits counted in scalars unless stated as bytes.

## Whole-message bounds

| Boundary | Initial limit |
| --- | --- |
| HTTP JSON request | 1 MiB, 65,536 JSON values |
| HTTP JSON response or complete synchronization message | 4 MiB, 262,144 JSON values, 1,000 changes |
| WSS control or pre-authentication message | 16 KiB, 4,096 JSON values |
| Any JSON document | Maximum nesting depth 32, root depth one |
| One Object's content | 2,000,000,000 bytes, outside JSON counts |
| Pending synchronization connection | 4 MiB, whole messages only |

One value is a scalar, array, or object. Object member names are not separate values.
Every array element and object member value counts recursively. A long string is
one value but still consumes bytes. Count complete envelopes, not only domain data.
Check bounds before copies, decode allocation, validation, encoding, or enqueue.
Reserve bounded work for geometry checks and complete resource/commit images.
Input compression is unsupported initially; it cannot bypass an encoded byte limit.

Every accepted individual synchronized item must fit a page and a future whole
commit at the effective limits, including mandatory terminal/control effects.
The picture never evicts items to make an unfit commit look complete.
Limits that clients negotiate below future permitted batches are refused up front.

Health `limits` has integer fields `max_request_bytes`, `max_request_json_values`,
`max_message_bytes`, `max_json_values`, `max_changes`, `max_control_bytes`,
`max_control_json_values`, `max_json_depth`, and `max_object_bytes`, with the
corresponding defaults above. Snapshot/subscription `limits` contains the negotiated
`max_message_bytes`, `max_json_values`, and `max_changes`. These message-limit fields are budget integers,
not Object content-length strings. Missing or unknown limit fields are invalid.
The separate health [`temporary_limits`](temporary-reads.md#advertised-limits)
object advertises allocation budgets and their numeric representations.

## Refusal and recovery

Oversized JSON returns `413 payload_too_large`. Exhausted count, work, or temporary
allocation budgets return `429 resource_limit`. Exhausted durable storage returns
`507 storage_limit`. Refusals have the [Wire error envelope](http/wire.md#common-representation).
Continuation after lost temporary ownership returns `410 allocation_expired`.
Expired replay returns `410 cursor_expired` with the earliest recoverable cursor.
An old Dataset returns `409 dataset_mismatch` with the current Dataset identity.

Control replies remain usable under data capacity pressure. On WSS, a safe typed
error precedes closure when possible. Otherwise close and resume from the last
complete applied cursor. Neither path authorizes skipping a commit.
Local SDK capacity failure uses the same meaning, without pretending an HTTP call occurred.

Temporary counts and deadlines follow [read contexts](temporary-reads.md).
The [SDK picture owner](synchronization/client-picture.md#capacity-and-retry) defines
client budgets and complete accounting. A picture can be resource-limited under
them. HTTP history has separate finite view bounds, without automatic retention cuts.
Core's workload qualification owns deployment measurements.

[Wire](http/wire.md)
