# Power

Power groups supply state and remaining energy reserves in one section.
A glider can report its avionics battery without having propulsion. A camera can
report an external supply. The fields, limits, and reserve layout below are proposals.

## Proposed fields

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `external_power` | Boolean or null | Required | External supply is present; null when unknown |
| `reserves` | Array of typed reserves | Required, non-null | At most 16 entries, with unique IDs; empty when no reserves are declared |

Each reserve has these common fields:

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `id` | UUID string | Required, non-null | Stable identity of this reported reserve, not an Entity ID |
| `kind` | String | Required, non-null | Proposed closed set: `battery` or `fuel` |
| `remaining_percent` | Number or null | Required | Remaining reserve, 0 through 100 inclusive; null when unknown |

Battery reserves also require `voltage_volts` and `current_amperes`, each
a finite number or null when unknown. Voltage is nonnegative. Current is signed.
Positive means discharge, negative means charging. Fuel reserves omit both fields.
The variants use named schemas, not a dictionary of arbitrary measurements.

Include the [shared section fields](README.md#shared-proposed-section-fields).
An update replaces the complete supplied Power section, including its reserve
list. Static nameplate details are not part of this proposed live snapshot.
Reserve percentage does not itself promise remaining flight time or range.

## Examples

Valid proposed battery snapshot:

```json
{
	"external_power": false,
	"reserves": [{
		"id": "6d9599b2-50b0-41cf-9967-22b502f3a0dc",
		"kind": "battery",
		"remaining_percent": 82,
		"voltage_volts": 24.3,
		"current_amperes": 2.1
	}],
	"observed_at": "2026-10-17T12:00:00Z"
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

## Decisions to settle

Confirm reserve variants, the instance limit, percentage representation, and
replacement identity across hardware changes. Partial reserve failures and
mixed-time readings still need representation without refreshing older evidence.

[Component index](README.md)
