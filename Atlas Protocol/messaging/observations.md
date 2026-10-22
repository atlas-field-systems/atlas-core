# Observation messages

Observation messages publish and read one source's ongoing detection record.
Creation identifies the stable publisher and accepts applicable reported components.
Core applies the [Observation rules](../observations.md) and active
[fusion policy](../tracks.md). An Asset does not create the shared Track directly.

## Creation, reports, and descriptions

| Proposed message | Expected user and purpose | Input | Observable result |
| --- | --- | --- | --- |
| `CreateObservation` | Asset runtime or publishing integration starts a record for a detected subject | Stable Observation and request IDs, publisher identity and source Asset attribution when applicable, optional publisher-local subject identity, permitted initial data, and original report evidence and source times for supplied reported sections | Created Observation and its Track in one commit under the default policy |
| `ReportObservation` | Asset runtime or publishing integration reports movement, another measurement, or a correction | Observation and publisher identities, complete applicable sections, and original report or correction evidence | Accepted, duplicate, or rejected evidence, with any default Track changes in the same commit |
| `EditObservation` | Operator app or publisher corrects descriptive metadata separately from measurements | Observation ID, permitted descriptive edits, retry identity, and `expected_edit_revision` | Committed description under [Entity rules](../entities.md#data-ownership) |

Reports address the continuing Observation, not a newly allocated record for every
measurement. Preserve publisher identity separately from the gateway or credential.
Use Observation evidence ordering, not Asset process and contact requirements.

## Reads and evidence

| Proposed message | Expected user and purpose | Input | Observable result |
| --- | --- | --- | --- |
| `ListObservations` | Operator app or processing integration browses source detections | Bounded filters, including publisher, recorded source Asset, and associated Track | Matching Observation views |
| `GetObservation` | Operator app or processing integration inspects a source record | Observation ID | Current Observation view and its Track association |
| `GetObservationByAlias` | Integration resolves a configured alias | Observation alias | Matching Observation view |
| `GetObservationMovementHistory` | Analysis tool reviews source measurements over time | Observation ID and bounded history query | Retained movement evidence with source times |
| `GetObservationObjects` | Operator app finds photographs or other evidence files | Observation ID and bounded query | Associated ready Object metadata |

Source Asset filtering uses the recorded [publisher attribution](../observations.md#identity-and-attribution),
never the submitting key or gateway. [Track source queries](tracks.md#sources-and-evidence)
can combine Track and source Asset filters. Observation records are an optional
[synchronization coverage](../synchronization.md); on-demand reads remain available
when that coverage is disabled. Movement reads use [history coverage](../movement-history.md)
independently of Observation-record coverage.

Schemas select applicable [shared components](../components/README.md).
Reported [Type](../components/type.md#observed-subject-type) describes the detected subject.
Initial descriptions and reported facts remain distinguishable. Creation is not
Asset enrollment or proof of contact.

There is no individual deletion message for retained Observations. Exact creation
fields and report envelopes remain unspecified.

[Messaging index](../messaging.md)
