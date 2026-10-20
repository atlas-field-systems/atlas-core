# Status

Status is the Asset's reported assessment of its overall condition.
A camera can report a fault while Core still has healthy contact with it.
[Communications](communications.md) describes contact. Task execution has its own
state. The condition vocabulary and field layout below are proposals.

## Proposed fields

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `condition` | String | Required, non-null | One of `unknown`, `healthy`, `degraded`, or `faulted` |

The enclosing result carries [shared section metadata](README.md#shared-section-results).
`unknown` is the initial lack of an assessment, not an error. Actual reported
failures use the [shared error alternative](README.md#shared-section-results).
Condition values belong in the value alternative, separately from reporting failures.

Status uses `UpdateAsset` and the [source evidence and ordering rules](../reports.md#shared-context).
It may be state until changed or a dated assessment, as declared by the source.
Fresh contact does not advance its observation time. A healthy condition alone
does not promise that a Task can start or that physical work has completed.

## Examples

Valid healthy assessment under the proposal:

```json
{
	"condition": "healthy"
}
```

Invalid because a Task execution state is not a condition value:

```json
{"condition": "in_progress"}
```

## Decisions to settle

Confirm the condition vocabulary and how an Asset explains a degraded or faulted
assessment. Per-section errors remain attached to their affected results. Status
does not require a duplicate fault entry for every field.

[Component index](README.md)
