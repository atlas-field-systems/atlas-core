# Identity and authority

**Permission to read state is not permission to claim that an Asset did something.**

## Principals

| Principal | Authority |
| --- | --- |
| Operator | Operational control and public administration; no fabricated Asset reports |
| Asset | Its own registration, current state, and execution evidence |
| Gateway | Reports for explicitly bound Assets, preserving their identities |
| Plugin | Operational reads/writes and Task requests; no Asset impersonation or administration |

Authenticated principals have broad operational reads, including Objects and
synchronization. There is no separate viewer/approval hierarchy for the initial
one-or-two-operator deployment. Profile names do not prove which person used a key.

A trusted gateway can translate radio evidence; the drone need not speak Core's
signed IP format over radio. Core checks the gateway's binding, not physical truth.
A faulty gateway can lie for its bound Assets. Binding withdrawal denies further
writes; gateway replacement must preserve source-scoped observation identity.

## Enrollment and credentials

Prepare stable registration/request IDs and recoverable credential material before
sending. Registration atomically creates the Entity, principal, credential binding,
and retry record. A lost reply must not lose the only usable secret. Retrying the
same original facts returns the existing identity and current resource, not defaults.

Deployment authorization gates first enrollment. Open enrollment is local-only and
off by default. Record its provenance; warn while it is enabled or unrevoked open
enrollments remain. Turning it off does not revoke existing bindings. Cleanup must
identify and confirm the exact bindings, including bindings whose Entities were
cleared by Reset, without affecting a later replacement.

New Assets start with unknown status, offline communications, and no last-seen time.
Registration alone is not contact. Reset retains valid setup bindings, but the Asset
must register into the new Dataset using fresh request identity, not relabeled reports.

API-key creation uses caller-prepared secrets with at least 32 random bytes and stable creation IDs;
Core stores verifiers, not retrievable secrets. Creation identity survives Reset.
First-key provisioning and credential replacement are local administration.

## Deletion, retirement, and revocation

Normal Asset deletion is blocked by nonterminal Tasks. Allowed deletion atomically
removes the Entity, revokes its credentials, and publishes the deletion.

Retirement handles an unreachable Asset with unresolved work. It preserves the
Entity and evidence, revokes authority, and rejects new Tasks. It does **not** claim
that physical work stopped, finish Tasks, or release their reference guards.

Deleted or retired Asset identities cannot reenroll until Hard Reset. Ordinary Reset
does not remove that denial. Credential replacement revokes the previous binding;
old actions cannot revoke a newly created binding by accidentally reusing an ID.

Revocation takes effect at commit, including open feeds and uploads awaiting
publication. Recheck authorization at the final effect boundary. Refusal after
revocation says nothing about whether an earlier request already committed.

[Next: reports](reports.md)
