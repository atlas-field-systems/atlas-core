# Communications

> Retained current design for review. [Planning status](../../../../../README.md#planning-status).

Communications separates Core-derived contact health from reported nominal capacity.
Core derives health under [Reports](../../reporting/reports.md#time-and-contact).
A high-capacity link can still be offline.

## Read composition

The Asset's `communications` object requires read-only `health` and `capacity`.
`health` is exactly `healthy`, `degraded`, or `offline`. `capacity` is a
[section result](../../reporting/evidence.md) for the payload below, with evidence.
An update supplies `sections.communications` as that capacity result. It never
supplies `health` or a nested read-view `capacity` wrapper.

## Capacity fields

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `bandwidth_bps` | Number or null | Required | Finite nominal bits per second, greater than zero; null when unknown |

The only `source_times` key is `bandwidth_bps`. It dates capacity evidence, not
Core's contact proof. The declaring source can be an attributable gateway using
the Asset's validated report context. This describes the named Asset's link, not
the gateway's upstream connection. Unattributable capacity stays null.
Nominal capacity is not measured throughput or a current delivery guarantee.

Initially health is `offline`. Capacity is a source-free initial value with
`bandwidth_bps: null` under [Entity initial-state rules](../../structure.md#initial-states).
Contact details are in [Heartbeat](heartbeat.md).

## Examples

Valid reported capacity payload:

```json
{"bandwidth_bps": 1200}
```

Valid update fragment, with enclosing report fields omitted from this example:

```json
{
	"sections": {
		"communications": {
			"state": "value",
			"classification": "state_until_changed",
			"observed_at": null,
			"value": {"bandwidth_bps": 1200}
		}
	}
}
```

Invalid update because derived health is not a capacity field:

```json
{"health": "healthy"}
```

[Component index](../../components/README.md)
