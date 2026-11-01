# Observations

> Retained current design for review. [Planning status](../../../../README.md#planning-status).

An Observation is one publisher's ongoing record of one detected subject.
Assets generate Observations. An integration or gateway can deliver them.
Successive reports use the same Observation ID, distinct from its shared [Track](../tracks/tracks.md).

## Identity and attribution

Each Observation records one stable `publisher_id`, separate from credentials,
gateways, integration installations, and Asset process generations. A gateway does not
become the publisher by forwarding a drone's report. Continuing a publisher after
reinstallation names its existing ID and satisfies sequence recovery below.
Display names do not establish continuity.
A report naming another publisher is refused atomically. No automatic transfer exists.

Creation records `source_asset_id` when the publisher represents an Asset.
Core validates that the named source Asset exists in the current Dataset at commit.
Creation cannot name a deleted Asset, including during a racing deletion.
Retain that fixed attribution after deletion. Existing Observations remain reportable
under their recorded publisher and current valid [API authority](../../support/identity.md#principals).
The source Asset need not remain live. A revoked key cannot report, but another
currently valid key can deliver the same publisher's evidence.

Deletion never transfers an Observation to a replacement Asset. Publishers without
source Asset attribution omit `source_asset_id`. Never infer it from delivery paths.
The optional [publisher-local subject pair](../structure.md#component-composition)
distinguishes reused local IDs. Reconnect or replay does not create another record
for the same continuing source subject.

## Reports and movement

[Report format](../reporting/format.md) defines the exact envelope, results, and reading
fields. [Evidence admission](../reporting/evidence.md) applies equally to creation and
later reports. New measurements have new reading identities. Replays retain
original identities. Making a new packet does not create new evidence.

Publisher sequence scope persists across gateway changes, credential changes,
restarts, and integration reinstallations. The publisher durably allocates sequence
numbers before emission and resumes above its allocated high-water mark.
Current Entity reads cannot reveal allocated-but-unsent sequence numbers. Before
handoff, stop the old allocator or share the same authoritative allocator. Recover
a durable upper bound covering every prior allocation for each affected stream.
Retry outstanding reports only with their original facts. A skipped allocation is
harmless; reusing it for different facts is not. If the upper bound is unavailable,
stop new publication for that Observation. The publisher exposes the failure in
its own diagnostics; no new Core state or Observation flag is created. Retain its
last-known Observation and Track. Restored allocator state or Reset permits recovery;
an accepted-state read, a new key, or reinstall alone cannot supply the missing proof.
Later detections may start a new Observation and source lifetime, even for the same
physical subject. They do not resume or link the old record. The publisher
cannot reset the counter, change publisher to evade ordering, or reuse
an allocated number with changed facts. Counter exhaustion is an explicit publication
failure, never wraparound. Sequences are scoped per Observation and section;
the report's sequence applies to each section it supplies.

Older unseen evidence can enter history without changing current state.
Equal-sequence conflicts and changed facts under an existing scoped reading ID
reject the whole submission. History-only reports preserve original measurement
age and never replace current state merely because delivery is newer.
The default policy commits Observation evidence, movement, corresponding Track
changes, and public effects together. Unknown original time remains null.

Observation reports have no Asset process generation or contact proof. Publishing
a detection establishes neither source Asset contact nor Asset enrollment.
Withdrawal ends a section assertion, not the Observation record.

## State, files, and lifetime

[Entity composition](../structure.md#component-composition) gives the exact permitted
fields and initial state. Telemetry, Attitude, Type, and Geometry are source facts.
Descriptions are authored separately. Source photographs are [Objects](../../objects/objects.md)
associated with the Observation. A successful report does not publish their bytes.
Sensor references and military-display metadata are unsupported initially.

Observations have no individual deletion or automatic expiry. Silence preserves
ID, last-known results, report identities, position history, and the default
Track association until Reset. Resumed reports update that same pair.
Inactive means only that a source is not reporting. There is no activity wire flag,
inferred timeout, or close message. Silence does not refresh measurement age.

[Observation messages](messages.md) define the operations.
The package validates message shapes and stateless evidence relationships.
Core evidence admission, transactions, and durable history remain integration work.

[Next: Tracks](../tracks/tracks.md)
