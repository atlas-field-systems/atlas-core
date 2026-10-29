# Authorization loss and retained local reads

A validated key rejection sets `authorization-required`. Complete downloaded
picture data remains locally readable, explicitly stale and authorization-required.
Revocation cannot erase data already downloaded by SDK or copied by an application.
This page applies to HTTP mode and Full synchronization alike.

## Stop network work

On known rejection, the instance stops new HTTP requests, uploads, feed connections,
reconnect timers, and remote history continuation/release. Abort remaining network
waits without claiming their writes were rejected. Keep prepared request identities
and accepted or unknown outcomes under [request rules](requests.md).
Fence feed callbacks by credential generation. Keep already applied whole commits;
later frames from the rejected generation cannot advance the frozen picture.
Late valid mutation replies may resolve their original outcomes. They cannot update
the picture, authorize another request, or override a later credential generation.

Changing a credential provider's value is only a candidate. An explicit credential
recovery attempt performs authenticated discovery with that changed credential,
validates the response and exact Protocol version, and reconciles the Dataset.
Only successful discovery/recovery accepts the credential and permits ordinary
network work. A failed or superseded attempt leaves authorization-required in place.
Do not retry rejected credentials in the background or accept them by elapsed time.
An identical rejected credential is not a changed candidate.
Concurrent recovery has one owner; later candidates fence older discovery replies.
Failed candidate discovery preserves an already-ready accepted generation and its
pending work. Ordinary requests still validate Protocol version and Dataset.

Accepted new credentials permit read/feed recovery, not replay of mutations, uploads,
cancellations, or control requests. The caller deliberately retries prepared work
with its original facts after reconciling the accepted Dataset. A changed Dataset
invalidates the old picture and submissions under Protocol. Version mismatch blocks work.

## Local reads and subscriptions

The picture exposes one frozen complete boundary, last synchronized time, and
authorization-required status. Queries and changed-since reads over its complete
picture return data with that status. They send no HTTP. Loading remains unavailable.
Explicit Observation and history HTTP reads are blocked by authorization.
An HTTP-mode instance has no local replica to read. Never manufacture empty results.

Local subscriptions emit authorization-required status. Existing and new subscribers
can replay downloaded complete commits under normal local cursor/gap rules, with
the stale status. They then remain attached to the frozen boundary until recovery.
No new network-derived events, synthetic deletions/creates, or authorization-induced
gaps appear. Do not silently close subscriptions as if they had caught up with Core.

On accepted same-Dataset recovery, replay from the last complete Core cursor when
permitted. Apply whole commits before notifying subscribers. A required rebuild
invalidates generations, cursors, and affected subscriptions under [picture rules](picture.md).
Authorization loss alone does not invalidate the complete picture or its local tokens.
Known Reset, capacity loss, required rebuild, token expiry, and close still do.

## History and allocations

All frozen history views are HTTP-owned. Their tokens report authorization-required
without sending continuation or release. No local view substitutes for them. Already
downloaded application copies can remain readable, without extending remote expiry.

Cancelling an HTTP view or snapshot load while unauthorized records local abandonment.
It does not claim a remote release acknowledgment or queue a hidden release request.
The Core allocation expires at its original deadline. Recovery obeys Protocol's
allocation/retry rules before replacing it. Discard partial private staging; preserve
the complete published picture. Retain only bounded allocation identity/expiry facts
needed to avoid duplicate allocation after lost replies. No persistent SDK cache exists.
