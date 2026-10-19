# Capabilities

Capabilities declares which Protocol Commands an Asset supports.
An operator application uses this to offer suitable controls. A tracker can
advertise no Commands. Support and execution follow [Task rules](../tasks.md).
[OpenAPI](../openapi.json) owns the manifest layout.

## Fields

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `commands` | Array of Command support values | Required, non-null | One entry per supported Protocol Command; `[]` means none |

Each Command support value has these fields:

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `command` | Protocol Command identifier | Required, non-null | Identifier from the local Command Catalog; unique within this manifest |
| `scheduling` | Array of scheduling identifiers | Required, non-null | Nonempty unique subset of `queued` and `immediate`, restricted by that Command |

Reuse the Catalog's identifiers and allowed scheduling choices in the schemas.
The Catalog wire names are exactly `move_to`, `pause`, and `resume`. Plugins
cannot add Asset Commands.

Capabilities is descriptive data, updated through `UpdateAsset` with the
descriptive revision precondition. It does not require periodic reporting.
Removing support does not rewrite existing Tasks. Current faults belong in
[Status](status.md). Support is not proof that a Command can succeed now.

## Examples

Valid manifest:

```json
{
	"commands": [
		{"command": "move_to", "scheduling": ["queued"]},
		{"command": "pause", "scheduling": ["immediate"]},
		{"command": "resume", "scheduling": ["immediate"]}
	]
}
```

A commandless tracker uses `{"commands": []}`.
Invalid because a supported Command has no supported scheduling choice:

```json
{"commands": [{"command": "move_to", "scheduling": []}]}
```

## Scope

Per-Command input constraints belong to their named Command schemas, not an
arbitrary capability dictionary.

[Component index](README.md)
