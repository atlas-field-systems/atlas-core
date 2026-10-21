# Observations

**An Observation is one publisher's ongoing record of one detected subject.**
Assets generate Observations. A publishing integration or gateway can deliver them.
The same Observation ID receives successive reports as the subject moves or changes.
It is distinct from the shared [Track](tracks.md) built from that evidence.

## Identity and attribution

Each Observation has one stable publisher identity, separate from an API credential,
gateway, or Plugin installation. A drone remains the publisher when a gateway
delivers its reports. Changing gateways or keys does not change the publisher.
Reinstallation names an existing publisher explicitly. A display name is not proof.
There is no automatic publisher transfer.
A report must name the Observation's recorded publisher. A mismatch rejects the
entire report without changing the Observation or its Track.

Keep the Observation ID distinct from an optional publisher-local subject ID.
An integration that uses local IDs must distinguish separate lifetimes when a
device reuses a number. Reconnect or replay must not create another Observation
for the same continuing source record.

## Reports and movement

A later measurement has new report evidence identity under the same Observation ID.
Retransmission retains that evidence identity. A correction identifies its original
evidence and correction revision. Creating a new packet does not create new evidence.
Exact envelope fields remain undecided.
Reported sections supplied at creation carry the same original report evidence,
source times, and ordering facts required for later reports.

Order complete reported sections by source sequence, not arrival time. Telemetry's
[constituent identity rules](components/telemetry.md#constituent-observation-identity)
keep measurement identity and correction revision independent of section ordering.
Reject stale section replacements, conflicting identity reuse, and stale constituent
revisions. Corrections preserve original measurement age. Unknown source time stays null.

Apply complete-section validation, classification, and value/error/withdrawn results
from [Reports](reports.md). Withdrawal ends a section assertion, not the Observation record.
Observation reports do not require Asset process generations or contact challenges.
Publishing a detection does not establish contact with its source Asset.
Observation creation does not enroll an Asset or create credentials.

For example, Drone A creates Observation O17 for a vehicle. Report R1 places it at
position A. Report R2 moves it to B under O17. Replaying R2 changes nothing.
The [default fusion policy](tracks.md#default-policy) updates the same Track T42.

## State, files, and lifetime

Observation schemas select applicable [components](components/README.md), including
Telemetry, observed subject Type, geometry, and sensor references. Separate authored
descriptions from reported facts. A photograph remains an [Object](objects.md)
associated with the Observation. Publication of the file is a separate outcome.

Observations are retained data records with no individual deletion or automatic
expiry. Silence does not refresh measurement age. A newly accepted report retains
its own original source times. Inactivity preserves the Observation ID, last-known
state, accepted report identities, corrections, and movement. Under the default
policy, resumed reports keep the existing Track association. Retain these records
until a deliberate Reset ends the Dataset.

Here, inactive means a source is no longer reporting that detection. It is not a
defined wire state. Activity flags and transition rules remain unspecified; this
wording does not define a timeout or a close message.

Observation message shapes belong in [Observation messages](messaging/observations.md). Exact schemas and
independent valid and invalid examples still need authoring.

[Next: Tracks](tracks.md)
