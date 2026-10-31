# Failure points

**This page is the authoritative list of failures that evals inject.** Each ID is a
`fault` action in a [scenario](scenarios.md#timeline-actions). `npm run eval -- --all`
fails if an ID has no scenario, or if a scenario's fault never fired. A rule that
never triggered proves nothing.

The injector uses only the HTTPS proxy, public HTTPS, local commands, settings, and
Docker. When a new failure appears in the field or in review, add its row here first.

## IP and responses

The proxy sits between every client and Core.

| ID | Injection | Required result |
| --- | --- | --- |
| `reply-lost` | Drop the reply after Core commits, for each write kind | `unknown_outcome`, then a retry with one durable effect |
| `reply-delayed` | Hold a reply past the attempt deadline | The late reply updates the same operation with no second effect |
| `reply-altered` | Corrupt a response body | SDK refuses it and exposes no invalid value |
| `connections-closed` | Close every open connection | Full recovers, Assets continue, and no write replays automatically |
| `version-mismatch` | Rewrite the Protocol version in discovery | SDK refuses it before ordinary work |
| `malformed-request` | Send invalid JSON directly to Core | Core refuses it and state does not change |

## Core process

| ID | Injection | Required result |
| --- | --- | --- |
| `core-restart` | `restart` under load | Tracks, Tasks, and history remain. Contact returns after check-in |
| `core-kill` | Kill the container during writes | Accepted writes remain after `start`, and nothing unaccepted appears |
| `core-drain` | `stop` during writes | Readiness turns false, and every reply is a commit or a known refusal |
| `core-reset` | `reset` then `start` during a run | Old clients stop with `dataset_invalidated`, and old IDs stay gone |

## Capacity

Lower Core [settings](../Atlas%20Core/limits.md) or SDK limits so that a short run
reaches each limit.

| ID | Injection | Required result |
| --- | --- | --- |
| `storage-pressure` | Lower the storage limit | Ordinary writes refuse with `storage_limit`, while reads and terminal reports work |
| `task-limit` | Exceed 1,000 outstanding Tasks on one Asset | The extra Task is refused, and terminal reports still succeed |
| `request-too-large` | Send a request above 1 MiB | `413 payload_too_large`, and state does not change |
| `sync-connection-limit` | Open a thirty-third sync connection | Core refuses it, and existing connections continue |
| `slow-consumer` | Stall one operator's socket past 4 MiB | Core sends an explicit gap or closes that socket, and that client resumes with no missed change |
| `replay-expired` | Hold a client past retained replay | The old token is refused, and the picture rebuilds with no missed change |
| `picture-capacity` | Lower the SDK picture limit | The picture reports its limit and never evicts data |

## Credentials and Datasets

| ID | Injection | Required result |
| --- | --- | --- |
| `key-revoked` | Revoke a key during traffic | Traffic stops, and earlier evidence remains |
| `key-rotated` | Replace an operator's key and call `recover()` | Work continues, and no write replays |
| `process-obsolete` | Replace a process, then report from the old generation | Core refuses the old process |
| `challenge-expired` | Check in after the ten-second challenge lifetime | `410 challenge_expired`, and contact stays unchanged |
| `contact-expiry` | Stop one Asset's traffic for 70 seconds | `degraded` at 15 seconds and `offline` at 60, with no new packet |

## Tasks

| ID | Injection | Required result |
| --- | --- | --- |
| `cancel-race` | Cancel as the Asset arrives | The Task ends `completed` or `cancelled`, as the truth log shows |
| `cancel-held` | Cancel an unstarted queued Task | Its slot holds until `cancelled`, then later Tasks run in order |
| `cancel-refused` | Refuse a cancellation | The request clears and execution state returns |
| `pause-empty` | Pause an idle Asset, then queue two Tasks | Both wait in order until Resume |
| `resume-expired` | Let a Resume expire before reading it | The gate stays paused, and the Task is `failed` with `expired` |
| `resume-superseded` | Send Pause after an unread Resume | The Asset keeps the gate and never applies the old Resume |
| `queue-changed` | Reorder during a paged assigned read | `409 queue_changed`, then a fresh read succeeds |
| `reorder-stale` | Reorder with an old `expected_queue_revision` | Core refuses it and order does not change |
| `terminal-conflict` | Report a different outcome after a terminal state | `409 terminal_state_conflict`, and the Task does not change |
| `asset-deleted` | Delete an Asset during a Task | Task records remain, and new evidence is refused |
| `geofeature-edited` | Edit a point during its Move To | The Asset uses its revision, and the report names it |

## Evidence

| ID | Injection | Required result |
| --- | --- | --- |
| `report-replayed` | Resend an accepted report through a second key | No new position, Task change, or public change |
| `sequence-conflict` | Send a new report at an occupied section sequence, then change the facts of an accepted `report_id` | `409 section_sequence_conflict`, then `409 report_identity_conflict`, and nothing commits |
| `execution-conflict` | Send changed Task execution facts at an occupied sequence | `409 evidence_conflict`, and nothing commits |
| `late-position` | Send an older unseen reading | History gains it, and current position stays |
| `future-time` | Send a future-dated reading | Core marks it time-uncertain and never promotes it |
| `tags-refused` | Send `tags` directly to Core in a registration and an authored update, then with an unknown preset and a duplicate | Core refuses each one, and the Asset's Tags do not change |
| `tags-cleared` | Report `{presets: []}`, then send later reports that omit `tags` | The set stays empty, and omission never restores `simulated` |
| `tags-history-only` | Send `{presets: []}` in a `history_only` report | The current set stays `simulated` |

## What evals cannot reach

Evals use no Core internals, so these failures stay with the owning suites.

| Failure | Owner |
| --- | --- |
| Database worker loss, checkpoints, and SQLite corruption | [Core qualification](../Atlas%20Core/qualification.md) |
| Crash points inside file publication and Object integrity | Core qualification. Object uploads are also outside this scope |
| Interrupted Reset and explicit recovery | Core `npm run test:container` |
| Power loss and physical disk faults | Unrun. See [Core qualification](../Atlas%20Core/qualification.md#report-honestly) |
| Flight, radio, and gateway behavior | Outside Atlas Simulations |

[Next: continuous integration](continuous-integration.md)
