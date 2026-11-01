# Heartbeat

> Retained current design for review. [Planning status](../../../../../README.md#planning-status).

Heartbeat supplies Asset contact proof without resending measurements.
[Contact](../contact.md) owns challenge acceptance and expiry.
The [report envelope](../../reporting/format.md) carries proof separately from sections.

## Evidence fields

| Field | Type | Presence | Meaning |
| --- | --- | --- | --- |
| `challenge_id` | UUID string | Required in `contact_proof` | Core challenge answered by the named Asset process |

Proof uses the report's Dataset, Entity, and Asset process context. Challenge
issuance and process replacement use [Asset exchanges](../messages.md).
A gateway response alone is not proof from its downstream Asset.
Heartbeat has no classification, measurement timestamp, or `source_times`.

## Read fields

| Field | Type | Presence | Meaning |
| --- | --- | --- | --- |
| `last_contact_at` | UTC timestamp string or null | Required, read-only | Core receipt time of the latest accepted fresh proof in this Core run; null before any |

Core uses monotonic elapsed time for expiry. The display timestamp does not select
a different freshness clock. [Communications](communications.md) exposes derived
health. No report can write `last_contact_at` or refresh another section's age by
changing contact evidence. Registration initially exposes null.

## Examples

Proof payload inside an Asset report:

```json
{"challenge_id": "143c5ce7-f80e-4c4e-94af-8af39d995487"}
```

Before fresh contact, the read value is `{"last_contact_at": null}`.
Invalid proof because a health flag is not challenge evidence:

```json
{"healthy": true}
```

[Component index](../../components/README.md)
