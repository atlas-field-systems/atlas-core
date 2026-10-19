# Heartbeat

Heartbeat carries contact evidence and exposes the contact Core has accepted.
It can establish fresh contact without resending unchanged position or camera
calibration. [Reports](../reports.md#time-and-contact) owns proof acceptance and
expiry. [OpenAPI](../openapi.json) owns the separate input and read schemas.

## Evidence fields

| Field | Type | Presence | Meaning |
| --- | --- | --- | --- |
| `challenge_id` | UUID string | Required when supplying contact proof | Core challenge answered by the reported Asset/process |

The containing update supplies the [shared source context](../reports.md#shared-context).
A challenge reference is evidence only when validated with the original source
facts and the existing challenge rules. A gateway's own response is not Asset proof.
Heartbeat evidence can accompany `UpdateAsset` without changing a measured section.
`RequestContactChallenge` and `ReplaceAssetProcess` carry the challenge exchange
defined by [process generations](../reports.md#process-generations).

## Read fields

| Field | Type | Presence | Meaning |
| --- | --- | --- | --- |
| `last_contact_at` | UTC timestamp string or null | Required, read-only | Core receipt time of the latest accepted fresh-contact evidence in the current Core run; null before any |

Core uses monotonic elapsed time for expiry. This UTC display timestamp is not
permission to calculate a different freshness clock. [Communications](communications.md)
owns the derived health view. Heartbeat is not an independently writable sensor
section and does not refresh other sections' observation times.

## Examples

Proof fragment, requiring its enclosing source context:

```json
{"challenge_id": "143c5ce7-f80e-4c4e-94af-8af39d995487"}
```

Before fresh contact, a read fragment is `{"last_contact_at": null}`.
Invalid proof fragment because a submitted health flag is not contact evidence:

```json
{"healthy": true}
```

## Scope

The read view also names `core_run_id`. Retained receipts identify original
source and submitting key separately. Protocol validates these shapes; Core owns
challenge expiry and acceptance.

[Component index](README.md)
