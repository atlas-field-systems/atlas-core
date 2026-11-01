# Identity and authority

**Each participant has its own API key. All valid keys have identical public-API
permissions.**

## Principals

Operators, Assets, gateways, and independent integrations use the same API permission model. Any
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
not physical truth. Gateway or key replacement preserves Observation publisher and
original report evidence identity. It does not create a new reporting source.

## Entity identity

Entity and Observation IDs are immutable and share one unique space within the Dataset.
Deleted Asset and Geofeature IDs remain reserved until Reset. Observations and
Tracks retain their IDs until Reset. Optional Entity and Observation aliases are unique
across these resources under the alias comparison below. Preserve the submitted spelling.
Deleting an Entity releases its alias, without permitting reuse of its ID.

Alias equality uses Unicode default full case folding, then exact string equality.
The package pins `unicode-case-folding` 1.1.2, whose C and F mappings match
`CaseFolding-18.0.0.txt` dated 2026-02-03 from the
[Unicode Character Database](https://www.unicode.org/Public/UCD/latest/ucd/CaseFolding.txt).
The table's SHA-256 is `a004797658a457bec4dc11683e39f69249ea3b595b752dbea6721c4c9f587b0d`.
No normalization, locale-specific Turkic mappings, or fuzzy matching applies.
For example, `Straße` equals `STRASSE`, and `Σ` equals both `σ` and `ς`.
Precomposed `é` differs from `e` followed by U+0301.
Each `Get*ByAlias` success requires a present, equal alias and retains its spelling.
Comparison is stateless. Core owns Dataset-wide uniqueness and retained identity history.

## Enrollment and credentials

Prepare stable registration/request IDs and recoverable credential material before
sending. The registering client prepares and retains its new credential secret;
Core retains its verifier. Registration atomically creates the Entity, principal,
credential binding, and retry record. A lost reply must not lose the only usable
secret. While the Entity exists, retrying the same original facts returns its
identity and current resource, not defaults, and does not replace or reveal the secret.

Local administration provisions the first API key before public-API use. An existing
valid key authorizes public enrollment under the same permissions as other writes.
Open enrollment is local-only and off by default. Record its provenance; warn
while enabled or unrevoked open enrollments remain. Turning it off does not revoke existing bindings. Cleanup must
identify and confirm the exact bindings, including bindings whose Entities were
cleared by Reset, without affecting a later replacement.

New Assets start with unknown status, offline communications, and no last-seen time.
Registration alone is not contact. Reset retains valid setup bindings, but the Asset
must register into the new Dataset using fresh request identity, not relabeled reports.

API-key creation uses stable creation IDs. Core stores verifiers, not retrievable
secrets. Creation identity survives Reset; its old Dataset's commit cursor does not.
An exact creation retry after Reset returns the retained identity and the new
Dataset's establishment cursor, which includes the retained installation setup.
First-key provisioning and credential replacement are local administration.

## API-key encoding

An API key contains exactly 32 bytes from a cryptographically secure random source.
Its `secret` wire value is canonical unpadded [base64url](https://datatracker.ietf.org/doc/html/rfc4648#section-5):
43 ASCII characters from `A-Z`, `a-z`, `0-9`, `_`, and `-`. Reject other characters,
padding, whitespace, or a value that does not decode to 32 bytes and reencode identically.
The same value is used in registration, key creation, local provisioning, HTTP
Bearer authentication, and WSS `api_key`. Validation cannot prove source randomness.

## Deletion and revocation

Asset deletion atomically removes the Entity, revokes associated credentials, and
publishes the deletion. Unfinished Tasks do not block it. Their records, original
Asset references, and accepted evidence remain. Deletion does not change their
execution state or release their reference guards. Deletion closes the Asset's own reporting for that ID. Core refuses new Tasks and updates for that identity, regardless of
submitting key. This includes `UpdateAsset`, `ReportTaskExecution`,
`ReportTaskResults`, and `ConfirmTaskOrder`, even for evidence generated before
deletion.

For example, delete Asset A while Task T is running. A gateway with a valid key
later delivers T's previously unseen completion evidence. Core refuses the report.
T retains its last accepted execution state and reference guards.

Updates and registration retries cannot recreate a deleted Asset. Deleted IDs follow
[Entity lifetime rules](entities.md). The physical system may register again with
a new Asset ID and credentials under the normal [enrollment rules](#enrollment-and-credentials).
Previous Tasks remain attached to their original Asset ID. Existing Observations
remain reportable under their recorded publisher and current valid authority,
even after source Asset deletion. Keep deleted source attribution. New Observations
cannot name a deleted source Asset. A replacement Asset never inherits old records.

Credential replacement revokes the previous binding; old actions cannot revoke a
newly created binding by accidentally reusing an ID.

Revocation takes effect at commit, including open feeds and uploads awaiting
publication. Recheck authorization at the final effect boundary. Refusal after
revocation says nothing about whether an earlier request already committed.

## Operator profiles

[Operator rules](operators.md) define profile lifetime, explicit key bindings,
atomic deletion/revocation, and retained attribution. Names grant no authority.

[Next: reports](reports.md)
