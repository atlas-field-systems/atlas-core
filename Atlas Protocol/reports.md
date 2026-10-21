# Reports, time, and contact

`UpdateAsset` changes Asset descriptions, status, and measurements. Accepting evidence
and establishing fresh contact remain distinct outcomes. [Observation reports](observations.md)
describe detected subjects separately from the reporting Asset's own measurements.

## Shared context

Asset updates identify the Dataset and Asset. Reported sections also identify the process
generation and a positive sequence number. Their context includes `generated_at`,
original evidence identity, whether the evidence is current or historical, and
contact proof. Section results carry [quantity times](components/README.md#shared-section-results).
Unknown original time stays null.
Historical evidence retains its identity. A new packet ID cannot make it fresh.
Observation reports use publisher and Observation identities under their own rules.

Apply [reported section classifications](entities.md#reported-sections) independently.
An omitted section preserves its accepted result, classification, and source times.
A supplied section eligible for current replacement replaces its prior result in
full, whether it carries values, an error, or a withdrawal. Apply the separate
[evidence admission and ordering rules](report-evidence.md) before replacement.
Core validates the complete result against its schema.
Missing required fields reject the update.
Never merge subfields with the prior section. Omitted optional fields do not retain
old values. Null subfields are valid only where their schemas permit them.

The reporting source detects failures and reports a section-level error with a code and optional
message. Core records and exposes it without diagnosing hardware, reconstructing
healthy subfields, or falling back to a prior value. Normal validation and ordering apply.
The [section result layout](components/README.md#shared-section-results) carries the
classification, one value/error/withdrawn alternative, and original quantity times.
Preserve original measurement times within complete sections. Fresh contact or
bundling fields together does not make older measurements fresh.

An explicit withdrawn result ends a state-until-changed assertion. Omission still
preserves it. Retain withdrawal evidence and ordering so older reports cannot restore
the assertion. Required section containers remain present with their withdrawn result.

Validate identity, API-key validity, original facts, and all effects atomically.
Classify evidence as accepted, duplicate, or rejected, separately from freshness.
Duplicate evidence alone cannot refresh contact, append movement, repeat activity,
or produce a public change. Order each section, Task stream, and queue stream independently.
New telemetry must not discard a previously unseen earlier Task outcome.

Core deduplicates direct and relayed submissions at its IP-facing update boundary.
Original evidence identity excludes the submitting key, gateway, and delivery-packet
identity. Delivering the same evidence through another key or gateway does not
change its identity. Edge connections and data links may deduplicate independently.
Core does not depend on them to prevent repeated effects.

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

Direct and relayed evidence share one source context naming the Asset and process
generation, separately from the submitting key and gateway. The challenge exchange
binds the Dataset, Asset, process generation, Core run, and challenge identity.
Replacement also carries the expected generation. Typed refusals distinguish failed
authority, generation mismatch, challenge expiry, and challenge-context mismatch.
Schemas must declare their exact message fields and refusal codes before implementation.
The gateway translates attributable Asset proof; its own response cannot stand in
for the Asset. Radio encoding and edge-link retries remain external.

## Time and contact

Deployment supplies correct UTC clocks. Atlas does not estimate offsets, correct
drift, or rewrite source event times. Keep source measurement time, Core receipt
time, and actual state-change time separate. Unchanged fresh status is not a new
status-change time.

Accept otherwise valid future-dated measurements as time-uncertain, with no usable
fresh age. Unknown time remains unknown. Optional clock-uncertainty compatibility
metadata must not reintroduce an offset-calculation subsystem.

Fresh contact requires accepted current-process evidence created after a Core
challenge, within its monotonic expiry. Bind the challenge to Dataset, Asset,
process, and Core run; Restart invalidates it. The initial challenge window is
10 seconds, subject to field qualification.

Historical reports, duplicates, Observation-only reports, fusion updates, open connections, and
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

Append movement only from newly accepted position, speed, or altitude measurements,
including historical evidence, under [Telemetry identity rules](components/telemetry.md#constituent-observation-identity).
Carried-forward readings and retries add no measurement. Retain corrections against
the same constituent identity without creating a new reading or refreshing its age.
Never create samples by copying an entire merged Entity snapshot.
History survives Entity deletion until Reset. Bounded history queries distinguish
unknown Entity IDs from known Entities with no matching samples.

On reconnect, reconcile retained reports and current instructions. Neither a new
connection nor a new process authorizes automatically repeating uncertain physical
work. Keep uncertainty visible until evidence or an explicit operator decision resolves it.

[Next: tasks](tasks.md)
