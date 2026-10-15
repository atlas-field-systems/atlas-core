# Reports, time, and contact

**Receiving a packet, accepting evidence, and establishing fresh contact are
three different things.** One report-acceptance path applies to all Asset routes.

## Shared context

Reports identify the Dataset, Asset, process generation, and positive sequence.
The common context includes `generated_at`, current/historical evidence kind,
original evidence identity, per-quantity observation times, and contact proof.
Unknown original time stays null. Retained historical evidence keeps its identity;
a new packet ID cannot turn the same fact into fresh evidence.

Validate identity, current authority, original facts, and all effects atomically.
Classify reports as accepted, duplicate, or rejected, separately from freshness.
Duplicates cannot refresh contact, append movement, repeat activity, or allocate
another public change. Order each quantity and Task/queue stream independently:
new telemetry must not discard a previously unseen earlier Task outcome.

## Process ownership

Direct-IP Assets prove process ownership with Ed25519 over the defined canonical
JSON representation. Preserve original validated identifier and timestamp spellings;
typed decoder normalization must not change the signed document. The signing profile
uses RFC 8785 and unpadded base64url, with independent vectors before deployment.

Replacing a process requires recovery-key proof, a current challenge, and an atomic
compare-and-swap of the expected generation with its first check-in. Only one
replacement wins. Reconnect is not replacement; an obsolete generation cannot
publish new execution state. A gateway restart is not an Asset restart.

Gateway relay proof and binding-change fields must be finalized before their first
workflow. Do not substitute direct-IP signatures for that separate boundary.

## Time and contact

Deployment supplies correct UTC clocks. Atlas does not estimate offsets, correct
drift, or rewrite source event times. Keep source observation time, Core receipt
time, and actual state-change time separate. Unchanged fresh status is not a new
status-change time.

Accept otherwise valid future-dated observations as time-uncertain, with no usable
fresh age. Unknown time remains unknown. Optional clock-uncertainty compatibility
metadata must not reintroduce an offset-calculation subsystem.

Fresh contact requires accepted current-process evidence created after a Core
challenge, within its monotonic expiry. Bind the challenge to Dataset, Asset,
process, and Core run; Restart invalidates it. The initial challenge window is
10 seconds, subject to field qualification.

Historical reports, duplicates, Track-only observations, open connections, and
operator edits do not establish contact. Gateway IP health does not prove that its
downstream Asset is reachable. Core derives high-bandwidth, healthy, degraded, or
offline communications from the actual link and accepted evidence.

## Movement and recovery

Append movement only for newly accepted explicit position, speed, or altitude,
including historical evidence. Preserve sparse quantity times and deduplicate
corrections. Never create samples by copying an entire merged Entity snapshot.
History survives Entity deletion until Reset. Bounded history queries distinguish
unknown Entity IDs from known Entities with no matching samples.

On reconnect, reconcile retained reports and current instructions. Neither a new
connection nor a new process authorizes automatically repeating uncertain physical
work. Keep uncertainty visible until evidence or an explicit operator decision resolves it.

[Next: tasks](tasks.md)
