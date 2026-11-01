# Track messages

> Retained current design for review. [Planning status](../../../../README.md#planning-status).

Track messages read shared targets and manage their authored descriptions.
The active [fusion policy](tracks.md) creates Tracks, maintains Observation
associations, and determines their reported state. Asset runtimes publish through
[Observation messages](../observations/messages.md).

## Reads and descriptions

| Message | Expected user and purpose | Input | Observable result |
| --- | --- | --- | --- |
| `ListTracks` | Operator app browses or searches shared targets | Bounded filters | Matching Track views |
| `GetTrack` | Operator app or analysis tool inspects a target | Track ID | Current Track view with Observation and evidence provenance |
| `GetTrackByAlias` | Integration resolves a configured alias | Track alias | Matching Track view |
| `EditTrack` | Operator app corrects authored descriptive metadata | Track ID, permitted descriptive edits, retry identity, and `expected_edit_revision` | Committed description under [Entity rules](../structure.md#data-ownership) |

Edits do not overwrite policy-owned state, source evidence, or associations.
There is no individual deletion message for retained Tracks.

## Sources and evidence

| Message | Expected user and purpose | Input | Observable result |
| --- | --- | --- | --- |
| `GetTrackObservations` | Operator app or processing integration inspects a target's sources | Track ID and bounded query, optionally filtered by recorded source Asset or publisher | Contributing Observation views with association provenance |
| `GetTrackMovementHistory` | Analysis tool or operator app reviews target movement | Track ID and [bounded history query](../history/queries.md) | Frozen pages of retained positions with original source evidence and times |
| `GetTrackObjects` | Operator app finds files explicitly associated with a target | Track ID and bounded query | Directly associated ready Object metadata |

Current Track views keep source IDs and provenance without cached Observations.
Expanded source records and [position history](../history/positions.md) use explicit
HTTP queries in both SDK modes. Source Asset filters use recorded publisher attribution.

Source photographs remain associated with their Observations. Follow the source
association and `GetObservationObjects` to inspect that evidence. Fusion does not
silently rewrite Object metadata or duplicate files.

Track schemas select applicable [shared components](../components/README.md).
[Type](../components/type.md#observed-subject-type) describes the target, with provenance
from the policy's inputs. Initial composition and derivation follow [Entities](../structure.md#component-composition)
and the [default policy](tracks.md#default-policy). External fusion publication,
merge/split, and handover are unsupported initially.

[Messaging index](../../shared/messages.md)

## Concrete request fields

Single reads use track_id; alias lookup uses alias. EditTrack requires track_id,
request_id, expected_edit_revision and nonempty `edits` of alias or description,
with null clearing. Its data is the Track image. GetTrackObservations uses
track_id with optional publisher_ids and source_asset_ids on its first page;
it returns a moving page of Observation images whose track_id matches.
GetTrackObjects uses track_id on its first page. Continuations supply only
page_token under [queries](../../shared/queries.md).
