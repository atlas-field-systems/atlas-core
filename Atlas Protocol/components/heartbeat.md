# Heartbeat

Heartbeat carries contact evidence and exposes the contact Core has accepted.
It can establish fresh contact without resending unchanged position or camera
calibration. [Reports](../reports.md#time-and-contact) owns proof acceptance and
expiry. The input and output layouts below are proposals.

## Proposed evidence fields

| Field | Type | Presence | Meaning |
| --- | --- | --- | --- |
| `challenge_id` | UUID string | Required when supplying contact proof | Core challenge answered by the reported Asset/process |

The containing update supplies the [shared source context](../reports.md#shared-context).
A challenge reference is evidence only when validated with the original source
facts and the existing challenge rules. A gateway's own response is not Asset proof.
Heartbeat evidence can accompany `UpdateAsset` without changing a measured section.
The evidence envelope and challenge exchange remain proposed, not a complete handshake.

## Proposed read fields

| Field | Type | Presence | Meaning |
| --- | --- | --- | --- |
| `last_contact_at` | UTC timestamp string or null | Required, read-only | Core receipt time of the latest accepted fresh-contact evidence in the current Core run; null before any |

Core uses monotonic elapsed time for expiry. This UTC display timestamp is not
permission to calculate a different freshness clock. [Communications](communications.md)
owns the derived health view. Heartbeat is not an independently writable sensor
section and does not refresh other sections' observation times.

## Examples

Proposed proof fragment, requiring its enclosing source context:

```json
{"challenge_id": "143c5ce7-f80e-4c4e-94af-8af39d995487"}
```

Before fresh contact, the proposed read fragment is `{"last_contact_at": null}`.
Invalid proof fragment because a submitted health flag is not contact evidence:

```json
{"healthy": true}
```

## Decisions to settle

Confirm evidence fields, challenge and result messages, and exactly how the read
timestamp relates to retained receipt facts.

[Component index](README.md)
