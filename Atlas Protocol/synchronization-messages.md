# Synchronization envelopes

These fields define the initial HTTP/JSON and WSS exchanges. Every field listed
is required unless marked optional. Objects are closed. IDs, counters, limits,
and errors follow [Wire](wire.md) and [Limits](limits.md).
`coverage` is `{base, observations, movement_history}` with three booleans.
Live projections require `base: true`; an addition-only capture can use false.

## Authentication and framing

WSS begins with `{type: "authenticate", request_id, dataset_id, protocol_version,
api_key}` within ten seconds. Core accepts one bounded authentication message,
then replies `authenticated` with matching context, `core_run_id`, and effective
limits. No data precedes authentication. Keys stay out of URLs and diagnostics.
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

## Snapshot allocation and pages

| Message | Request fields | Result `data` |
| --- | --- | --- |
| `ReadSnapshot` | First page has `allocation_context`, `load_id`, `coverage`, `page_size`, `max_message_bytes`, `max_changes`, `max_json_values`. Continuation has only `page_token` | `load_id`, `capture_id`, `coverage`, `baseline_cursor`, `expires_at`, `limits`, `items`, `next_page_token`, `release_token` |
| `ReleaseSnapshot` | `release_token` | `{released: true}`; WSS reply type `snapshot_released` |

`next_page_token` is null only when complete, including an empty capture.
Every page repeats identical capture context, baseline, limits, expiry, and release
token. Each item is a complete versioned resource image, history reading, or
history Entity marker under the declared coverage. Item order is resource kind,
then stable identity. History uses [its identity order](history-queries.md#selection-and-exact-order)
within the captured set, without relying on page arrival.
All pages form one frozen capture, not a series of moving lists.
Allocation/release use [temporary contexts](temporary-reads.md). The capture is
complete before publication. A build that cannot fit returns an error, not partial data.

## Replay and live handoff

| Message | Request fields | Reply |
| --- | --- | --- |
| `ReadChanges` | First page has `coverage`, `from_cursor`, `max_message_bytes`, `max_changes`, `max_json_values`. Continuation has only `page_token` | `coverage`, fixed `replay_boundary`, `messages`, `through_cursor`, `next_page_token` |
| `SubscribeChanges` | `subscription_id`, `coverage`, `from_cursor`, `max_message_bytes`, `max_changes`, `max_json_values` | `subscribed` with `subscription_id`, `coverage_revision`, `coverage`, fixed `handoff_cursor`, and `limits` |
| `UnsubscribeChanges` | `subscription_id` | `unsubscribed` with that ID |

ReadChanges fixes the log boundary on its first page. `messages` contains ordered
`change_batch` or `progress` envelopes without connection IDs. Tokens bind the
original range, source, and coverage. Expired replay is `410 cursor_expired`.
One connection owns one subscription and at most one staged addition. Exact retries
recover its existing handoff; conflicting reuse is refused. Unsubscribe is idempotent
and ends that subscription lifetime. Starting another requires a new WSS connection.

The live stream starts strictly after `from_cursor`, catches up through its fixed
handoff, emits `handoff_complete`, and then follows later commits. The handoff event
names `subscription_id`, `coverage_revision`, and `handoff_cursor`. It is a status
acknowledgment, not applied progress. Snapshot publication requires actual complete
application through that cursor. One owner drives catch-up and live delivery.

## Ordered data and progress

`change_batch` data has `subscription_id`, `coverage_revision`, `previous_cursor`,
`commit_cursor`, and `changes`. HTTP replay omits connection IDs. Each batch is
one complete selected commit, with these change alternatives:

| `kind` | Other fields |
| --- | --- |
| `put` | `resource_kind`, `resource_id`, `version`, complete `image` |
| `delete` | `resource_kind`, `resource_id`, `version` |
| `history_upsert` | Complete `reading` under [movement history](movement-history.md#reading-representation) |
| `history_entity` | `entity_kind`, `entity_id`, `version`, `deleted` boolean for known-ID/empty-history distinction |

Resource kinds are `asset`, `observation`, `track`, `geofeature`, `task`, and `object`.
History Entity kinds are `asset`, `observation`, and `track`. Snapshot `items` use
the same put/history alternatives without commit metadata. A higher correction
replaces the same history identity. No event samples a current image into history.

`progress` has `subscription_id`, `coverage_revision`, `previous_cursor`, and
`through_cursor`, proving an ordered range with no selected effects. A batch's
previous cursor must equal the last completely applied batch/progress cursor in
that projection's chain. [Staged chains](coverage-changes.md#stage-and-align) are separate.
Duplicates with identical context/facts are harmless. A conflicting copy, gap,
wrong coverage revision, or malformed item stops application before cursor advance.

`gap` has `subscription_id`, `coverage_revision`, `reason`, and
`earliest_recoverable_cursor`. It ends data delivery for that projection until
explicit resubscription/rebuild. Closure without a gap has the same last-applied
cursor rule. [Coverage changes](coverage-changes.md) define the remaining controls.

[Synchronization](synchronization.md)
