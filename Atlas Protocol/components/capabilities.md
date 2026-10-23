# Capabilities

Capabilities declares which Catalog Commands an Asset supports.
It is required authored data. A commandless tracker uses `{"commands": []}`.
Execution and scheduling semantics belong to [Tasks](../tasks.md).

## Fields

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `commands` | Array of Command support values | Required, non-null | Unique entries by `command`; empty means no Commands |

Each support value has these fields.

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `command` | String | Required, non-null | Exact identifier in the local Command Catalog |
| `scheduling` | Array of strings | Required, non-null | Nonempty unique subset of that Command's Catalog scheduling choices |

The initial identifiers are `move_to`, `pause`, and `resume`. Their supported
scheduling choices come from the [Catalog contract](../command-catalog.md), which is the
single authority for those choices. The manifest cannot invent a Command or a
scheduling mode. Its length cannot exceed the number of Catalog Commands.
Plugins cannot add Asset Commands or arbitrary capability parameters.

Capabilities changes use `UpdateAsset` and `expected_edit_revision`.
Removing support does not rewrite existing Tasks. Current faults belong in
[Status](status.md). Support does not promise success on the next invocation.
Capabilities has no report timestamp, result alternative, or `source_times`.

## Examples

Valid manifest for the initial Catalog:

```json
{
	"commands": [
		{"command": "move_to", "scheduling": ["queued"]},
		{"command": "pause", "scheduling": ["immediate"]},
		{"command": "resume", "scheduling": ["immediate"]}
	]
}
```

Invalid because the scheduling set is empty:

```json
{"commands": [{"command": "move_to", "scheduling": []}]}
```

[Component index](README.md)
