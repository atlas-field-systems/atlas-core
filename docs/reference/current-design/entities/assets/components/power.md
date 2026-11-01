# Power

> Retained current design for review. [Planning status](../../../../../README.md#planning-status).

Power groups supply state and remaining energy reserves in one section.
A glider can report its avionics battery without having propulsion. A camera can
report an external supply. One complete replacement includes every declared reserve.

## Fields

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `external_power` | Boolean or null | Required | External supply is present; null when unknown |
| `reserves` | Array of typed reserves | Required, non-null | At most 16 entries; unique IDs; empty when none are declared |

Each reserve has these common fields:

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `id` | UUID string | Required, non-null | Stable identity of this reported reserve, not an Entity ID |
| `kind` | String | Required, non-null | Closed set of `battery` or `fuel` |
| `remaining_percent` | Number or null | Required | Remaining reserve, 0 through 100 inclusive, allowing fractions; null when unknown |

Battery reserves also require `voltage_volts` and `current_amperes`, each
a finite number or null when unknown. Voltage is nonnegative. Current is signed.
Positive means discharge, negative means charging. Fuel reserves omit both fields.
The variants use named schemas, not a dictionary of arbitrary measurements.

The enclosing result carries [shared section metadata](../../components/README.md#shared-section-results).
An update replaces the complete supplied Power section, including its reserve
list. Static nameplate details are not part of this live snapshot.
Reserve percentage does not itself promise remaining flight time or range.

## Examples

Valid battery value:

```json
{
	"external_power": false,
	"reserves": [{
		"id": "6d9599b2-50b0-41cf-9967-22b502f3a0dc",
		"kind": "battery",
		"remaining_percent": 82,
		"voltage_volts": 24.3,
		"current_amperes": 2.1
	}]
}
```

Invalid reserve value because the percentage exceeds its bound:

```json
{
	"id": "6d9599b2-50b0-41cf-9967-22b502f3a0dc",
	"kind": "fuel",
	"remaining_percent": 101
}
```

## Identity and source times

Keep a reserve ID stable for the same physical reserve. Replacement hardware receives
a new ID. This identity is separate from the Asset's process generation.
Quantity times default to the enclosing result's `observed_at`. In `source_times`,
`external_power` overrides supply time. A `reserves` object keys overrides by current
reserve ID. Each entry permits `remaining_percent`, plus `voltage_volts` and
`current_amperes` for batteries only. Each leaf is a UTC timestamp or null.
Fuel entries forbid battery keys. Undeclared reserve IDs and other keys are refused.
Explicit null means unknown time. Whole-section replacement never refreshes
an older constituent reading.
Actual section failures follow [report evidence](../../reporting/evidence.md), without
reconstructing healthy reserves. The 16-reserve cap is the initial engineering limit,
not a measured capacity claim.

[Component index](../../components/README.md)
