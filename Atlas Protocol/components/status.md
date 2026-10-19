# Status

Status is the Asset's reported assessment of its overall condition.
A camera can report a fault while Core still has healthy contact with it.
[Communications](communications.md) describes contact. Task execution has its own
state. [OpenAPI](../openapi.json) owns its condition vocabulary and layout.

## Fields

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `condition` | String | Required, non-null | One of `unknown`, `healthy`, `degraded`, or `faulted` |

Include the [shared reported-section fields](README.md#reported-results).
`unknown` is the lack of an assessment. A `faulted` condition is an assessed value.
If the source cannot supply this section, it reports a section error instead of
a partial assessment. Value and error results are disjoint.

Status uses `UpdateAsset` and the [source evidence and ordering rules](../reports.md#shared-context).
It may be state until changed or a dated assessment, as declared by the source.
Fresh contact does not advance its observation time. A healthy condition alone
does not promise that a Task can start or that physical work has completed.

## Examples

Valid healthy assessment as a component value:

```json
{
	"condition": "healthy",
	"observed_at": "2026-10-17T12:00:00Z"
}
```

Invalid because a Task execution state is not a condition value:

```json
{"condition": "in_progress", "observed_at": "2026-10-17T12:00:00Z"}
```

## Scope

Per-section errors remain attached to their affected results. Status does not
require a duplicate fault entry for every field.

[Component index](README.md)
