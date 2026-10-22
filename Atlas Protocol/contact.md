# Asset contact exchange

A challenge proves recent attributable Asset contact, not physical Task success.
Both direct-IP clients and gateways use current API-key authority. No separate
Asset signing secret is required. A gateway preserves the Asset's original proof.

## Begin contact

`BeginAssetContact` requires `request_id`, `allocation_context`, `asset_id`,
`process_generation`, and `mode`, either `current` or `replace`.
The context follows [temporary allocation rules](temporary-reads.md).
Current mode must name the registered generation and omit
`expected_process_generation`. Replacement requires that field and a generation
UUID never previously used for that Asset in the Dataset. Unknown/deleted Assets
cannot begin contact.

The result contains `challenge_id`, `asset_id`, `process_generation`, `mode`,
`core_run_id`, `issued_at`, `expires_at`, and the expected generation for replacement.
The random UUID challenge binds those facts, Dataset, and the allocation context.
Its monotonic lifetime is ten seconds or the remaining context lifetime, whichever
is shorter. An exact allocation retry returns the same challenge and original expiry.

Core permits one outstanding challenge per Asset and 1,024 across the installation.
A different allocation while the Asset's challenge is live returns `429 contact_busy`.
Challenge consumption and retained allocation receipts follow the same bounded
context lifetime. Expired contexts cannot allocate again after receipt cleanup.

## Current check-in

The Asset creates new current evidence after receiving the challenge. It supplies
`report.contact_proof.challenge_id` in the [Asset report format](report-format.md),
normally through `UpdateAsset`. The Asset's original generated time is at or after
challenge issue and before expiry. Core also requires receipt before monotonic
expiry, matching Dataset, Core run, Asset, and current process.

The first valid check-in consumes the challenge and commits contact with any
valid accompanying report effects. An exact report replay recovers its result
without refreshing contact. A different report cannot consume the challenge twice.
Core's validation trusts attributable source facts; the gateway's own heartbeat
does not establish downstream contact. Measurement times remain independent.

## Replace a process

`ReplaceAssetProcess` requires stable `request_id`, `asset_id`,
`expected_process_generation`, `process_generation`, `challenge_id`, and
`first_report`. The report uses the shared envelope and matching `contact_proof`.
All original request/report facts form its retry identity.

Core atomically compares the expected generation, validates an unexpired replacement
challenge and first current check-in, switches generation, and commits the report
and contact. Only one replacement wins. Resolve exact successful retries before
the generation precondition so a lost reply can recover success without switching again.
Any invalid first report leaves the old generation and all other state unchanged.

Subsequent new reports from the obsolete process are refused, including new
historical submissions. Already accepted exact evidence replays remain harmless
under the [report replay rules](report-evidence.md). A process switch does not reset
queue order or terminal Tasks, prove suspension, or authorize repeating uncertain work.
New-process confirmation must distinguish old-process queue/control adoption.

## Refusals and lifetime

| Refusal | Meaning |
| --- | --- |
| `401 unauthorized` | Missing, invalid, or revoked API key |
| `404 asset_not_found` | Asset is unknown or deleted |
| `409 generation_mismatch` | Current or expected process no longer matches |
| `409 challenge_context_mismatch` | Proof names different bound facts |
| `409 challenge_consumed` | Different evidence already used the proof |
| `410 challenge_expired` | Challenge or its Core-run context ended |
| `429 contact_busy` | Another live challenge already belongs to this Asset |
| `429 resource_limit` | Allocation/receipt capacity cannot be reserved |

Restart invalidates challenges and resets proven contact to offline, while retaining
the registered process and accepted evidence. Reset also invalidates the Dataset.
The [contact health timers](reports.md#time-and-contact) remain separate from
challenge lifetime. These selected defaults have no runtime qualification result.

[Asset messages](messaging/assets.md)
