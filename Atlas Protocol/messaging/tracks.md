# Track messages

Track messages read shared targets and manage their authored descriptions.
The active [fusion policy](../tracks.md) creates Tracks, maintains Observation
associations, and determines their reported state. Asset runtimes publish through
[Observation messages](observations.md).

## Reads and descriptions

| Proposed message | Expected user and purpose | Input | Observable result |
| --- | --- | --- | --- |
| `ListTracks` | Operator app browses or searches shared targets | Bounded filters | Matching Track views |
| `GetTrack` | Operator app or analysis tool inspects a target | Track ID | Current Track view with Observation and evidence provenance |
| `GetTrackByAlias` | Integration resolves a configured alias | Track alias | Matching Track view |
| `EditTrack` | Operator app corrects authored descriptive metadata | Track ID, permitted descriptive edits, retry identity, and `expected_edit_revision` | Committed description under [Entity rules](../entities.md#data-ownership) |

Edits do not overwrite policy-owned state, source evidence, or associations.
There is no individual deletion message for retained Tracks.

## Sources and evidence

| Proposed message | Expected user and purpose | Input | Observable result |
| --- | --- | --- | --- |
| `GetTrackObservations` | Operator app or processing integration inspects a target's sources | Track ID and bounded query, optionally filtered by recorded source Asset or publisher | Contributing Observation views with association provenance |
| `GetTrackMovementHistory` | Analysis tool or operator app reviews target movement | Track ID and [bounded history query](../history-queries.md) | Frozen pages of retained movement with original source evidence and times |
| `GetTrackObjects` | Operator app finds files explicitly associated with a target | Track ID and bounded query | Directly associated ready Object metadata |

Current Track views keep source IDs and provenance when Observation caching is off.
Expanded source records use the optional [Observation coverage](../synchronization.md)
or an explicit on-demand query. [Movement history](../movement-history.md) has its
own independent coverage. Source Asset filters use recorded publisher attribution.

Source photographs remain associated with their Observations. Follow the source
association and `GetObservationObjects` to inspect that evidence. Fusion does not
silently rewrite Object metadata or duplicate files.

Track schemas select applicable [shared components](../components/README.md).
[Type](../components/type.md#observed-subject-type) describes the target, with provenance
from the policy's inputs. The exact derived-state schema remains a proposal.
External fusion publication and handover messages require a later contract.

[Messaging index](../messaging.md)
