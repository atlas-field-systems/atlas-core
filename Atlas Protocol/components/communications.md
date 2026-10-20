# Communications

Communications presents contact health separately from link capacity.
Core derives contact health under [Reports](../reports.md#time-and-contact).
Capacity is a numeric nominal rate, not a capability class.

## Read fields

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `health` | String | Required, read-only | Existing Core-derived `healthy`, `degraded`, or `offline` result |
| `bandwidth_bps` | Number or null | Required | Declared nominal Asset link capacity in bits per second, greater than zero; null when unknown |

Reported capacity uses a [section result](README.md#shared-section-results).
Its timestamp describes capacity evidence, not the age of Core's contact proof.
Retain the declaring source and the Asset link that the capacity describes.
The source or an attributable gateway may declare capacity through `UpdateAsset`. The writable
schema omits `health`. Replacing reported information never sets derived health.
Read views expose `health` beside the reported result, outside its alternatives.

A high-capacity link can be offline. Gateway IP connectivity alone supplies neither
downstream Asset contact nor a known capacity. Nominal capacity is not a promise
of current throughput. Contact details are referenced through [Heartbeat](heartbeat.md).

## Examples

Read fragment showing derived health and the reported capacity value:

```json
{
	"health": "offline",
	"bandwidth_bps": 1200
}
```

Invalid update fragment because health is Core-owned:

```json
{"health": "healthy"}
```

## Capacity attribution

`bandwidth_bps` describes the named Asset link, not the gateway's own upstream IP
connection. Unknown or unattributable capacity stays null. This declaration does not
establish end-to-end throughput. Section failures follow [Reports](../reports.md#shared-context).

[Component index](README.md)
