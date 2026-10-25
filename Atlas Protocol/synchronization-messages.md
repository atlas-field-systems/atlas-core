# Synchronization envelopes

Initial HTTP/JSON and WSS fields are required unless marked optional.
Objects are closed. IDs, counters, limits, and errors follow [Wire](wire.md) and
[Limits](limits.md). All data uses the fixed [picture contract](synchronization.md).

## Authentication and framing

WSS begins with `{type: "authenticate", request_id, dataset_id, protocol_version,
api_key}` within ten seconds. Core accepts one bounded authentication message,
then replies `authenticated` with matching context, `core_run_id`, and effective
limits. Its `data` is exactly `{core_run_id, limits}`. No data precedes authentication. Keys stay out of URLs and diagnostics.
Failed authentication returns `unauthorized` when possible and closes the socket.

After authentication, non-error frames are `{type, dataset_id, protocol_version,
request_id?, data}`. Controls require top-level `request_id`; replies echo it.
Stream events omit that field and identify their subscription in `data`.
Errors use `{type: "error",
dataset_id, protocol_version, request_id?, error}` with Wire's error object.
Their top-level ID echoes a control's valid parsed request ID when answering it;
otherwise omit it. `error.request_id` is separate Core-assigned correlation.
The whole frame counts against the negotiated byte/value bound.

HTTP controls carry their named `data` fields in the ordinary request body and
return the Wire success/error envelope. WSS control type names are the snake_case
forms of the named messages. Other replies use the request type plus `_result`.
Snapshot/replay result frames are data, not 16 KiB controls.
ReadSnapshot, ReadChanges, and ReleaseSnapshot have HTTP and WSS bindings.
SubscribeChanges and UnsubscribeChanges are WSS-only controls on `/changes`.

## Snapshot allocation and pages

| Message | Request fields | Result `data` |
| --- | --- | --- |
| `ReadSnapshot` | First page has `allocation_context`, `load_id`, `page_size`, `max_message_bytes`, `max_changes`, `max_json_values`. Continuation has only `page_token` | `load_id`, `capture_id`, `baseline_cursor`, `expires_at`, `limits`, `items`, `next_page_token`, `release_token` |
| `ReleaseSnapshot` | `release_token` | `{released: true}`; WSS reply type `snapshot_released` |

`next_page_token` is null only when complete, including an empty capture.
Every page repeats identical capture context, baseline, limits, expiry, and release
token. Each item is a complete versioned resource image. Item order is resource
kind, then stable identity, both bytewise. Pages form one frozen capture, not moving lists.
Allocation/release use [temporary contexts](temporary-reads.md). The capture is
complete before publication. A build that cannot fit returns an error, not partial data.

## Replay and live handoff

| Message | Request fields | Reply |
| --- | --- | --- |
| `ReadChanges` | First page has `from_cursor`, `max_message_bytes`, `max_changes`, `max_json_values`. Continuation has only `page_token` | Fixed `replay_boundary`, `messages`, `through_cursor`, `next_page_token` |
| `SubscribeChanges` | `subscription_id`, `from_cursor`, `max_message_bytes`, `max_changes`, `max_json_values` | `subscribed` with `subscription_id`, fixed `handoff_cursor`, and `limits` |
| `UnsubscribeChanges` | `subscription_id` | `unsubscribed` with that ID |

ReadChanges fixes the log boundary on its first page. `messages` contains ordered
`change_batch` or `progress` envelopes without connection IDs. Tokens bind the
original range and source. Replay uses `{type, data}`; HTTP owns Dataset/version context.
Expired replay is `410 cursor_expired`. The first message starts at `from_cursor`.
An empty first page stays there; null `next_page_token` finishes at `replay_boundary`.
One connection owns one subscription. Exact retries recover its existing handoff;
conflicting reuse is refused. Unsubscribe is idempotent and ends that subscription
lifetime. Starting another requires a new WSS connection.

The live stream starts strictly after `from_cursor`, catches up through its fixed
handoff, emits `handoff_complete`, and then follows later commits. The handoff event
names `subscription_id` and `handoff_cursor`. It is a status acknowledgment, not
applied progress. Snapshot publication requires complete application through that
cursor. One owner drives catch-up and live delivery.

## Ordered data and progress

`change_batch` data has `subscription_id`, `previous_cursor`, `commit_cursor`, and
`changes`. HTTP replay omits connection IDs. Each batch is one complete picture
commit, with these change alternatives:

| `kind` | Other fields |
| --- | --- |
| `put` | `resource_kind`, `resource_id`, `version`, complete `image` |
| `delete` | `resource_kind`, `resource_id`, `version` |

Put permits `asset`, `track`, `geofeature`, `task`, and `object`. Delete permits
only `asset`, `geofeature`, and `object`. Tasks and Tracks remain until Reset.
Snapshot `items` use the same put alternative without commit metadata.
Observations and history readings never appear as synchronized items.
Put identity, version, and Dataset match its image. Pages/batches forbid duplicate resources.

`progress` has `subscription_id`, `previous_cursor`, and `through_cursor`, proving
an ordered range with no picture effects. A batch's previous cursor must equal the
last completely applied batch/progress cursor and differ from its commit cursor.
Each advance within a replay page reaches a cursor not already visited in that
page. Progress may repeat the current cursor without picture effects.
Duplicates received again with identical context and facts are harmless.
A conflicting copy, cursor cycle, gap, or malformed item stops application before
cursor advance.

`gap` has `subscription_id`, `reason`, and `earliest_recoverable_cursor`.
Reason is `cursor_expired`, `resource_limit`, or `limits_changed`. It ends
data delivery until explicit resubscription/rebuild. Closure without a gap has
the same last-applied cursor rule.

[Synchronization](synchronization.md)
