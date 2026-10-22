# Observations

An Observation is one publisher's ongoing record of one detected subject.
Assets generate Observations. An integration or gateway can deliver them.
Successive reports use the same Observation ID, distinct from its shared [Track](tracks.md).

## Identity and attribution

Each Observation records one stable `publisher_id`, separate from credentials,
gateways, Plugin installations, and Asset process generations. A gateway does not
become the publisher by forwarding a drone's report. Reinstallation explicitly
names the existing publisher. Display names do not establish continuity.
A report naming another publisher is refused atomically. No automatic transfer exists.

Creation records `source_asset_id` when the publisher represents an Asset.
Core validates that the named source Asset exists in the current Dataset at commit.
Creation cannot name a deleted Asset, including during a racing deletion.
Retain that fixed attribution after deletion. Existing Observations remain reportable
under their recorded publisher and current valid [API authority](identity.md#principals).
The source Asset need not remain live. A revoked key cannot report, but another
currently valid key can deliver the same publisher's evidence.

Deletion never transfers an Observation to a replacement Asset. Publishers without
source Asset attribution omit `source_asset_id`. Never infer it from delivery paths.
The optional [publisher-local subject pair](entities.md#component-composition)
distinguishes reused local IDs. Reconnect or replay does not create another record
for the same continuing source subject.

## Reports and movement

[Report evidence](report-evidence.md) defines every exact envelope, result, reading,
and correction field. Creation uses the same evidence rules for supplied sections
as later reports. New measurements have new reading identities. Replays retain
original identities. Making a new packet does not create new evidence.

Publisher sequence scope persists across gateway changes, credential changes,
restarts, and integration reinstallations. The publisher durably allocates sequence
numbers before emission and resumes above its allocated high-water mark.
It reconciles retained accepted reports and its outstanding submissions after
recovery. It cannot reset the counter, change publisher to evade ordering, or reuse
an allocated number with changed facts. Counter exhaustion is an explicit publication
failure, never wraparound. Sequences are scoped per Observation and section;
the report's sequence applies to each section it supplies.

Older unseen evidence can enter history without changing current state.
Equal-sequence conflicts and stale constituent revisions reject the whole submission.
Historical corrections name original evidence, preserve measurement age, and never
replace current state merely because their delivery is newer.
The default policy commits Observation evidence, movement, corresponding Track
changes, and public effects together. Unknown original time remains null.

Observation reports have no Asset process generation or contact proof. Publishing
a detection establishes neither source Asset contact nor Asset enrollment.
Withdrawal ends a section assertion, not the Observation record.

## State, files, and lifetime

[Entity composition](entities.md#component-composition) gives the exact permitted
fields and initial state. Telemetry, Attitude, Type, and Geometry are source facts.
Descriptions are authored separately. Source photographs are [Objects](objects.md)
associated with the Observation. A successful report does not publish their bytes.
Sensor references and military-display metadata are unsupported initially.

Observations have no individual deletion or automatic expiry. Silence preserves
ID, last-known results, report identities, corrections, movement, and the default
Track association until Reset. Resumed reports update that same pair.
Inactive means only that a source is not reporting. There is no activity wire flag,
inferred timeout, or close message. Silence does not refresh measurement age.

[Observation messages](messaging/observations.md) define the operations.
Machine schemas and runtime acceptance coverage remain unimplemented.

[Next: Tracks](tracks.md)
