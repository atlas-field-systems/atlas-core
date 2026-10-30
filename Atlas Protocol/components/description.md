# Description

Description supplies an Entity's authored display name and plain-text details.
It is optional. When supplied, the complete value has the following fields.

## Fields

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `name` | String | Required, non-null | Nonblank display name, at most 128 Unicode scalar values |
| `description` | String | Optional, non-null | Plain-text details, at most 4,096 Unicode scalar values |
| `manufacturer` | String | Optional, non-null, Assets only | Nonblank hardware manufacturer, at most 128 Unicode scalar values |
| `model` | String | Optional, non-null, Assets only | Nonblank hardware model, at most 128 Unicode scalar values |

Nonblank means containing a character outside Unicode White_Space. Values retain
their accepted spelling. Names need not be unique. IDs and aliases follow
[Entity rules](../entities.md). [Type](type.md) remains separate from model names.
Omitted optional fields are absent, not null. An absent Description has no generated
name. Applications can display the Entity ID instead.

Asset descriptions use `UpdateAsset`. Other Entity types use their descriptive
edit messages. Changes carry `expected_edit_revision` under
[Entity ownership](../entities.md#data-ownership) and [Wire edit rules](../wire.md#parsing-and-edits).
For example, replacing `{"name": "Gate", "description": "North entrance"}` with
`{"name": "East gate"}` removes the omitted details. A supplied Description always
requires `name`. Description carries neither report timestamps nor errors.

## Examples

Valid Asset description:

```json
{
	"name": "North gate camera",
	"description": "Mounted above the vehicle entrance"
}
```

Invalid because the display name is blank:

```json
{"name": ""}
```

[Component index](README.md)
