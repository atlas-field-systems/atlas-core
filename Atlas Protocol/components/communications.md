# Communications

Communications presents contact health separately from link capacity.
Core derives contact health under [Reports](../reports.md#time-and-contact).
The field names and numeric capacity representation below are proposals.

## Proposed read fields

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `health` | String | Required, read-only | Existing Core-derived `healthy`, `degraded`, or `offline` result |
| `bandwidth_bps` | Number or null | Required | Declared nominal Asset link capacity in bits per second, greater than zero; null when unknown |

Reported capacity uses the [shared reported-section fields](README.md#shared-proposed-section-fields).
Their timestamp describes capacity evidence, not the age of Core's contact proof.
The source or a gateway may declare capacity through `UpdateAsset`. The writable
schema omits `health`. Replacing reported information never sets derived health.

A high-capacity link can be offline. Gateway IP connectivity alone supplies neither
downstream Asset contact nor a known capacity. Nominal capacity is not a promise
of current throughput. Contact details are referenced through [Heartbeat](heartbeat.md).

## Examples

Valid read view under the proposed field layout:

```json
{
	"health": "offline",
	"bandwidth_bps": 1200,
	"observed_at": "2026-10-17T12:00:00Z"
}
```

Invalid update fragment because health is Core-owned:

```json
{"health": "healthy"}
```

## Decisions to settle

Confirm whether capacity should be numeric or a defined class. Exact capacity
attribution and partial-error layout still need definitions.

[Component index](README.md)
