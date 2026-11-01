# Administration and discovery messages

> Retained current design for review. [Planning status](../../../README.md#planning-status).

Any valid API key has the same public permissions. Profiles provide attribution,
not roles. Core local lifecycle and runtime settings remain outside this API.

## Administration

| Message | Expected user and purpose | Request | Result |
| --- | --- | --- | --- |
| `ListResources` | Administration app inspects resource usage and capacity | Bounded inspection query | Resource usage |
| `ReadActivity` | Operator app or diagnostic tool investigates recorded activity | Bounded activity query | Activity records |
| `ListApiKeys` | Administration app reviews provisioned credentials | Bounded key query | Key metadata |
| `CreateApiKey` | Provisioning tool creates a credential for an additional participant | Caller-prepared credential facts and stable creation identity | Committed creation under [Identity](identity.md#enrollment-and-credentials) |
| `RevokeApiKey` | Administration app withdraws an unneeded or compromised credential | Key identity and retry facts | Committed revocation under [Identity](identity.md#deletion-and-revocation) |
| `ListOperators` | Administration app browses operator profiles | Bounded profile query | Matching profiles |
| `GetOperator` | Operator app displays a known operator's profile | Operator identity | Operator profile |
| `CreateOperator` | Administration app records a new operator profile | Profile creation facts and retry identity | Created profile |
| `EditOperator` | Operator app maintains an operator's profile details | `operator_id`, profile edits, `request_id`, and `expected_edit_revision` | Committed profile change |
| `DeleteOperator` | Administration app removes an unneeded operator profile | Operator identity and retry facts | Atomic deletion and revocation of explicitly bound keys |

## Discovery messages

| Message | Expected user and purpose | Request | Result |
| --- | --- | --- | --- |
| `GetHealth` | Connecting application discovers the Dataset, exact Protocol version, and health | Authenticated health and discovery request | Dataset, exact Protocol version, and health under [Wire](../shared/http/wire.md) |
| `GetReadiness` | Deployment monitor checks whether Core is ready to serve requests | Authenticated readiness request | Readiness information |
| `GetReference` | Developer or documentation UI reads the contract and schema reference | Authenticated reference request | Documentation or schema information |

## Identity fields

`CreateOperator` requires `operator_id`, `request_id`, and the profile fields in
[Identity](identity.md#operator-profiles). `EditOperator` requires the same retry
identity and an edit revision precondition. `DeleteOperator` requires `operator_id`
and `request_id`. Exact retries recover committed deletion; a different request
for a deleted profile returns `410 operator_deleted`. Reads return
`404 operator_not_found` for unknown/deleted profiles. Past attribution stays retained.

`CreateApiKey` requires `api_key_id`, `request_id`, caller-prepared `secret`, and
optional non-null `operator_id`. `secret` uses the exact [API-key encoding](identity.md#api-key-encoding).
Retry equality uses the original credential facts
without exposing the retained secret. Responses/list entries contain `api_key_id`,
nullable `operator_id`, `created_at`, and nullable `revoked_at`, never a verifier
or retrievable secret. `RevokeApiKey` requires `api_key_id` and `request_id`.
A repeated revocation is harmless. Key creation/binding serializes with profile deletion.
[Identity](identity.md) owns authority, lifetime, and revocation effects.

List/query bounds and continuation follow [Wire](../shared/http/wire.md#lists). Core owns the
activity categories and resource accounting; neither is synchronization coverage.

[Messaging index](../shared/messages.md)

## Closed records and queries

Operator reads contain operator_id and the profile fields, including edit_revision.
Edits use `edits: {name?, description?}`; description alone permits null clearing.
At least one edit is required. Key and operator lists use the moving-list shape
in [queries](../shared/queries.md). Resource and activity reads use that same paging.

Resource records are `{kind, used, capacity}`. Kind is a nonblank Core-owned name
of at most 128 scalars; used and capacity are counter strings. Activity records
require `activity_id`, `at`, `category`, `message`, `api_key_id`, `operator_id`,
and `operator_deleted`. IDs are UUIDs, at is a timestamp, category is nonblank
and at most 128 scalars, message is at most 4,096. Attribution IDs may be null;
a null operator requires operator_deleted false. No activity payload dictionary
or Protocol activity-category enum exists.

Health adds `healthy` boolean to the discovery fields defined in Wire, Limits,
and Temporary contexts. Readiness data is exactly `{ready: boolean}`. A false
readiness uses status 503 with the same success envelope, never an empty reply.
Reference media negotiation follows [Wire](../shared/http/binding.md).
