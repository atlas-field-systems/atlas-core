# History query messages

Asset, Observation, and Track position reads return complete frozen HTTP pages
under [history query rules](../history-queries.md). Core is their sole view owner
in both SDK modes.

## First page

`GetAssetMovementHistory`, `GetObservationMovementHistory`, and
`GetTrackMovementHistory` select their named Entity kind. Each requires `entity_id`,
stable `query_id`, and `allocation_context`. Optional fields are:

| Field | Meaning |
| --- | --- |
| `time_groups` | Unique array of `known`, `unknown`, `uncertain`; omission selects all |
| `source_time_from` | Inclusive known-time lower bound, non-null UTC timestamp |
| `source_time_before` | Exclusive known-time upper bound, non-null UTC timestamp |
| `page_size` | Integer 1 through 1,000, default 100 |

If both time bounds are supplied, the lower must precede the upper. Empty selection
arrays match nothing. Bounds do not discard selected unknown/uncertain readings.
All original supplied fields, including omission, form the allocation facts.
Unsupported filters return `422 unsupported_filter`; unknown IDs return
`404 entity_not_found`. Deleted but known Assets remain queryable.
There is no quantity selector or historical speed/altitude query.

## Page and continuation

Every page's `data` has `query_id`, `view_id`, `source`, `baseline_cursor`,
`expires_at`, `release_token`, `readings`, and `next_page_token`.
`source` is exactly `core`. The baseline cursor belongs to Core's durable log.
Each reading uses the full [reading representation](../movement-history.md#reading-representation).
The last page has null continuation, including a known-empty result. Other pages
have an opaque continuation token. Page length alone does not imply completion.

Continuation supplies only `page_token` and retains the original frozen selection,
reading facts, source, baseline, and expiry. An invalidated/expired view returns
`410 allocation_expired`; callers explicitly restart if desired. A token cannot
switch to local data or silently create another view.

## Release

`ReleaseHistoryView` requires only `release_token` in its original Core-run context.
It returns `{released: true}` under the exact [release rules](../temporary-reads.md#continuation-and-release).
Release requires current authorization and Dataset. A revoked key cannot continue
or release HTTP work. Already downloaded application copies do not grant network authority.

No query is truncated to fit. View allocation, reference counts, storage accounting,
and fixed 60-second maximum expiry follow [temporary bounds](../temporary-reads.md#finite-bounds-and-ownership).

[Messaging index](../messaging.md)
