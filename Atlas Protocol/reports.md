# Reports, time, and contact

**UpdateAsset changes descriptions, status, and observations through one path.**
Accepting evidence and establishing fresh contact remain distinct outcomes.

## Shared context

Updates identify Dataset and Asset. Reported sections also identify the process
generation and positive sequence. Their context includes `generated_at`, original
evidence identity, current/historical kind, per-quantity source times, and contact proof.
Unknown original time stays null. Retained historical evidence keeps its identity;
a new packet ID cannot turn the same fact into fresh evidence.

Apply [reported section classifications](entities.md#reported-sections) independently.
An omitted section preserves its accepted result, classification, and source times.
A supplied section is a complete replacement, validated against its full schema.
Never merge its subfields with the prior section. Missing required fields reject
the update; omitted optional fields do not retain old values. Null subfields are
valid only where their schemas permit them.

An accepted reported error becomes the affected current result; reads expose it
without fallback to a prior value. Error reports follow normal validation and ordering.
Preserve original observation times within complete sections. Fresh contact or
bundling fields together does not make older observations fresh.

Validate identity, API-key validity, original facts, and all effects atomically.
Classify evidence as accepted, duplicate, or rejected, separately from freshness.
Duplicate evidence alone cannot refresh contact, append movement, repeat activity,
or allocate a public change. Order each section and Task/queue stream independently:
new telemetry must not discard a previously unseen earlier Task outcome.

Core's IP-facing update boundary owns authoritative deduplication for both direct
and relayed submissions. Original evidence identity excludes the submitting key,
gateway, and delivery-packet identity. The same evidence arriving through a second
key or gateway remains the same evidence. Edge connections and data links may
deduplicate independently; Core does not depend on them to prevent repeated effects.

## Process generations

Direct-IP and gateway reports use the [shared API-key permissions](identity.md#principals).
Keep the reported Asset and process separate from the submitting key. Preserve
original validated identifier and timestamp spellings in retained report facts.

Registration records the initial process generation without establishing contact.
Core can issue a challenge bound to that process or a proposed replacement.
Replacing a process uses a current challenge and an atomic compare-and-swap of the
expected generation with its first check-in. Any valid API key may request this
replacement. Only one replacement wins. Reconnect is not replacement; an obsolete
generation cannot publish new execution state. A gateway restart is not an Asset restart.

The gateway envelope, source-identity fields, and challenge exchange remain
unspecified. The gateway translates attributable Asset evidence, including a
response to Core's challenge; its own response cannot stand in for the Asset.
Radio encoding and edge-link retries remain external.

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
description changes alone do not establish contact. Gateway IP health does not
prove a downstream Asset is reachable.

Communications health is `healthy` for less than 15 seconds after accepted fresh
contact, `degraded` from 15 seconds until 60 seconds, and `offline` at 60 seconds.
No proven contact in the current Core run means offline. These are initial defaults
subject to field qualification, separate from the 10-second challenge expiry.
Use Core's monotonic elapsed time; source timestamps do not reset this timer.
Expiry transitions are public committed changes even when no new packet arrives.

Keep bandwidth capability separate from communications health. A high-bandwidth
link can be offline. Gateway connectivity alone establishes neither the downstream
Asset's health nor its bandwidth capability; unknown capability stays unknown.

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
