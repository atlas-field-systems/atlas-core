# Tags

Tags are presets that an Asset reports about itself. The wire section name is `tags`.
Only Assets report Tags. Core retains the assertion and does not verify it.

## Fields

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `presets` | Array of strings | Required, non-null | Unique names from the preset table, at most 1 item |

An empty array asserts that the Asset has no tags. Unknown presets, duplicates, a
null value, a bare array, and extra fields are refused. Atlas has no custom or
authored tags, and list and history queries do not filter by Tags.

## Presets

| Preset | Meaning |
| --- | --- |
| `simulated` | The Asset reports that it is a simulation, not a physical system |

## Absence, failure, and replacement

| Read result | Meaning |
| --- | --- |
| `tags` absent | The Asset has not reported Tags |
| `presets: []` | The Asset reports that no tag applies |
| `presets: ["simulated"]` | The Asset reports that it is simulated |
| `state: "error"` | The source failed to report Tags, and the result has no value |
| `state: "withdrawn"` | The assertion ended, and the section retains its evidence |

`RegisterAsset` accepts no Tags, so there is no source-free initial value. A read
result always has report evidence, which is never null and names this Asset.

A report that omits `tags` preserves the prior result. This includes the first
report from a [replacement process](../contact.md#replace-a-process), so Tags from
the old process stay current. To clear them, the new process reports
`presets: []` or a withdrawal.

Tags use `UpdateAsset` reports and the first report of `ReplaceAssetProcess`.
The [report evidence contract](../report-evidence.md) owns ordering, retries,
process generations, and `history_only` admission. Reporting Tags does not advance
`edit_revision`. Tags have no constituents and add no movement history.

The source declares state until changed or dated measurement. The only allowed
`source_times` key is `presets`. A read value adds `time_status.presets`.

## Examples

Valid complete result. The evidence envelope is omitted:

```json
{
	"state": "value",
	"classification": "state_until_changed",
	"observed_at": "2026-10-21T12:00:00Z",
	"value": {"presets": ["simulated"]}
}
```

Valid assertion of no tags:

```json
{"presets": []}
```

Invalid because a preset repeats:

```json
{"presets": ["simulated", "simulated"]}
```

Invalid because `demo` is not a preset:

```json
{"presets": ["demo"]}
```

[Component index](README.md)
