# Communications

Communications separates reported link capacity from Core-derived contact health.
[Reports](../reports.md#time-and-contact) owns contact freshness and thresholds.
[OpenAPI](../openapi.json) owns the exact input and read compositions.

## Reported value

| Field | Type | Presence | Meaning |
| --- | --- | --- | --- |
| `bandwidth_bps` | Number or null | Required | Nominal bits per second, greater than zero; null when unknown |
| `observed_at` | Timestamp or null | Required | Original capacity evidence time |

The source or a trusted gateway may declare capacity through `UpdateAsset`.
It uses the [reported result variants](README.md#reported-results). Its time is
separate from the age of Core's contact proof. Errors replace the complete result.

```json
{"bandwidth_bps": 1200, "observed_at": "2026-10-17T12:00:00Z"}
```

## Read composition

`Asset.communications` contains `reported`, a retained capacity result, and required
`health`, one of `healthy`, `degraded`, or `offline`. `Heartbeat` exposes accepted
contact. The writable schema omits health and receipts; `{"health":"healthy"}`
is an invalid submitted Communications value.

A high-capacity link can be offline. Gateway IP connectivity alone supplies neither
downstream Asset contact nor known capacity. Capacity is not measured throughput.

[Component index](README.md)
