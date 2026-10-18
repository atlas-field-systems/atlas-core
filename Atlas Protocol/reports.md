# Reports, time, and contact

`UpdateAsset` changes an Asset's descriptions, status, and observations.
Accepting evidence and establishing fresh contact remain distinct outcomes.

## Shared context

Updates identify the Dataset and Asset. Reported sections also identify the process
generation and a positive sequence number. Their context includes `generated_at`,
original evidence identity, whether the evidence is current or historical,
source times for each quantity, and contact proof. Unknown original time stays null.
Historical evidence retains its identity. A new packet ID cannot make it fresh.

Apply [reported section classifications](entities.md#reported-sections) independently.
An omitted section preserves its accepted result, classification, and source times.
A supplied section is a complete replacement. Core validates it against its full schema.
Never merge its subfields with the prior section. Missing required fields reject
the update. Omitted optional fields do not retain old values. Null subfields are
valid only where their schemas permit them.

The Asset detects failures and reports a section-level error with a code and optional
message. Core records and exposes it without diagnosing hardware, reconstructing
healthy subfields, or falling back to a prior value. Normal validation and ordering apply.
Preserve original observation times within complete sections. Fresh contact or
bundling fields together does not make older observations fresh.

An explicit withdrawn result ends a state-until-changed assertion. Omission still
preserves it. Retain withdrawal evidence and ordering so older reports cannot restore
the assertion. Required section containers remain present with their withdrawn result.

Validate identity, API-key validity, original facts, and all effects atomically.
Classify evidence as accepted, duplicate, or rejected, separately from freshness.
Duplicate evidence alone cannot refresh contact, append movement, repeat activity,
or produce a public change. Order each section, Task stream, and queue stream independently.
New telemetry must not discard a previously unseen earlier Task outcome.

Original evidence identity excludes credentials, gateways, and delivery-packet IDs.
Core deduplicates it at the IP-facing boundary. Independent edge-link deduplication
does not replace Core's protection against repeated effects.

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

Deployment supplies correct UTC clocks. Atlas does not calculate offsets, correct
drift, or rewrite event times. Observation, receipt, and state-change times remain
distinct. Unchanged fresh status is not a new status change.

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

`healthy` lasts less than 15 seconds after fresh contact; `degraded` lasts from
15 seconds until 60; `offline` starts at 60. No proven contact this Core run means
offline. These initial thresholds need field qualification, separately from challenge expiry.
Use Core's monotonic elapsed time, never source timestamps. Timer transitions are
public committed changes even without another report.

Keep bandwidth capability separate from communications health. A high-bandwidth
link can be offline. Gateway connectivity alone establishes neither the downstream
Asset's health nor its bandwidth capability; unknown capability stays unknown.

## Movement and recovery

Append movement only from newly accepted position, speed, or altitude, including
historical evidence. Preserve quantity times and deduplicate corrections. Never copy
merged Entity snapshots into samples. History survives Entity deletion until Reset.
Bounded queries distinguish unknown IDs from known Entities with no matching samples.

On reconnect, reconcile retained reports and current instructions. Neither a new
connection nor a new process authorizes automatically repeating uncertain physical
work. Keep uncertainty visible until evidence or an explicit operator decision resolves it.

[Next: tasks](tasks.md)
