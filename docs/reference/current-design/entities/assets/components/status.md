# Status

> Retained current design for review. [Planning status](../../../../../README.md#planning-status).

Status is the Asset's assessment of its overall condition.
A camera can report a fault while Core still has healthy contact with it.
[Communications](communications.md) owns contact health. Task outcomes are separate.

## Fields

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `condition` | String | Required, non-null | Exactly `unknown`, `healthy`, `degraded`, or `faulted` |
| `explanation` | String | Optional, non-null | Nonblank source explanation, at most 512 Unicode scalar values |

`unknown` means no assessment is available. A reported hardware fault is a value
with `condition: "faulted"`. An error result means the source failed to obtain or
report Status. Core never converts a faulted assessment into a section error.
Explanation can accompany any condition and does not create a separate fault log.

Status uses `UpdateAsset` and the [report evidence contract](../../reporting/evidence.md).
The source declares state until changed or dated measurement. The only allowed
`source_times` key is `condition`, covering the assessment and its explanation.
Fresh contact does not advance that time. Healthy Status does not promise that
physical work can start or has completed.

## Examples

Valid assessment with a concise source explanation:

```json
{
	"condition": "degraded",
	"explanation": "Navigation receiver unavailable"
}
```

Invalid because a Task state is not a condition:

```json
{"condition": "in_progress"}
```

[Component index](../../components/README.md)
