# Description

**Description supplies the human-readable name and details shown for an Entity.**
It is authored data. Asset descriptions use `UpdateAsset`; Track and Geofeature
descriptions use their respective edit messages and descriptive revision checks.
The fields and bounds below are proposals.

## Proposed fields

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `name` | String | Required, non-null | Nonblank display name, at most 128 characters |
| `description` | String | Optional, non-null | Plain-text details, at most 4,096 characters; omit when absent |
| `manufacturer` | String | Optional, non-null; Assets only | Nonblank hardware manufacturer, at most 128 characters |
| `model` | String | Optional, non-null; Assets only | Nonblank hardware model, at most 128 characters |

Names need not be unique. Stable IDs and unique aliases follow [Entity rules](../entities.md).
[Type](type.md) describes what the Entity is; a model name does not establish Type.
Description does not contain observation timestamps or a standing error field.
Asset updates replace the complete supplied section under [update rules](../reports.md#shared-context).

## Examples

Valid Asset description under the proposal:

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

## Decisions to settle

Confirm field names and text limits. Manufacturer and model are proposed Asset
fields, not a hardware inventory service. Removing optional description fields
from an Asset replacement removes their previous values.

[Component index](README.md)
