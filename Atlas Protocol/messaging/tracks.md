# Track messages

**Track messages publish observations about something, under one stable publisher.**
Creation identifies that publisher and accepts Track components. It does not enroll
an Asset or establish Asset contact. Shared message context and the proposal status
of exact names and payloads follow the [messaging index](../messaging.md).

## Creation and descriptions

| Proposed message | Expected user and purpose | Input | Observable result |
| --- | --- | --- | --- |
| `CreateTrack` | Sensor runtime or publishing integration starts a Track for a new detection | Stable Track and request IDs, publisher identity, and permitted initial Track data | Created Track attributed to that publisher |
| `ListTracks` | Operator app browses or searches reported detections | Bounded filters | Matching Track views |
| `GetTrack` | Operator app or analysis tool inspects a known Track | Track ID | Current Track view |
| `GetTrackByAlias` | Integration resolves a configured alias to a Track | Track alias | Matching Track view |
| `EditTrack` | Operator app or publisher corrects descriptive metadata separately from observations | Track ID, permitted descriptive edits, retry identity, and `expected_edit_revision` | Committed Track description under [Entity rules](../entities.md#data-ownership) |
| `DeleteTrack` | Publisher or operator app removes a Track that is no longer useful | Track ID and retry identity | Deletion or an explicit refusal under [reference guards](../entities.md#geometry-and-references) |

Track schemas select their allowed components from the shared definitions,
including applicable [Telemetry](../components/telemetry.md). Initial descriptions
and observations must remain distinguishable; exact creation fields are undecided.
Reported [Type](../components/type.md#track-type) describes the observed subject and
follows the Track's source-observation rules.

## Observations and evidence

| Proposed message | Expected user and purpose | Input | Observable result |
| --- | --- | --- | --- |
| `ReportTrackObservations` | Sensor runtime or publishing integration adds an observation or corrects earlier evidence | Track and publisher identities, complete applicable sections, and original observation/correction evidence | Accepted, duplicate, or rejected observations under [Track rules](../entities.md#tracks) |
| `GetTrackMovementHistory` | Analysis tool or operator app reviews observed motion over time | Track ID and bounded history query | Retained movement evidence |
| `GetTrackObjects` | Operator app finds images or other files associated with a detection | Track ID and bounded query | Associated Object metadata |

Preserve publisher identity separately from the delivering gateway or credential.
Apply Track observation ordering, not Asset process/contact requirements.
The exact observation envelope and its relationship to complete section updates
remain to be specified; this catalog does not redefine the owning Track rules.

[Messaging index](../messaging.md)
