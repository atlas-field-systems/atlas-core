# Identity and authority

**Each participant has its own API key. All valid keys have identical public-API
permissions.**

## Principals

Operators, Assets, gateways, and Plugins use the same API permission model. Any
valid key may read, write, use public administration, or submit reports for any
Asset or publisher. There are no role tiers or per-Asset API-key scopes. Local
host administration still requires local access.

A valid API key is sufficient to authenticate direct-IP and gateway reports.
No separate Asset signing or recovery secret is required.

Core records the submitting key separately from the reported source. Credential
associations describe attribution and lifecycle, not API permissions. Profile names
do not prove which person used a key. Equal permissions do not bypass Dataset,
identity, ordering, or state-transition validation.

A trusted gateway can translate radio evidence. Core validates the reported facts,
not physical truth. Gateway or key replacement preserves source-scoped observation
identity without making the new credential a different observation source.

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
Entity and evidence, revokes associated credentials, and rejects new Tasks and
reports for that Asset regardless of submitting key. It does **not** claim
that physical work stopped, finish Tasks, or release their reference guards.

Deleted or retired Asset identities cannot reenroll until Hard Reset. Ordinary Reset
does not remove that denial. Credential replacement revokes the previous binding;
old actions cannot revoke a newly created binding by accidentally reusing an ID.

Revocation takes effect at commit, including open feeds and uploads awaiting
publication. Recheck authorization at the final effect boundary. Refusal after
revocation says nothing about whether an earlier request already committed.

[Next: reports](reports.md)
