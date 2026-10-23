# Administration and discovery messages

Any valid API key has the same public permissions. Profiles provide attribution,
not roles. Core/Plugin local lifecycle and runtime settings remain outside this API.

## Administration

| Message | Expected user and purpose | Request | Result |
| --- | --- | --- | --- |
| `ListResources` | Administration app inspects resource usage and capacity | Bounded inspection query | Resource usage |
| `ReadActivity` | Operator app or diagnostic tool investigates recorded activity | Bounded activity query | Activity records |
| `ListApiKeys` | Administration app reviews provisioned credentials | Bounded key query | Key metadata |
| `CreateApiKey` | Provisioning tool creates a credential for an additional participant | Caller-prepared credential facts and stable creation identity | Committed creation under [Identity](../identity.md#enrollment-and-credentials) |
| `RevokeApiKey` | Administration app withdraws an unneeded or compromised credential | Key identity and retry facts | Committed revocation under [Identity](../identity.md#deletion-and-revocation) |
| `ListOperators` | Administration app browses operator profiles | Bounded profile query | Matching profiles |
| `GetOperator` | Operator app displays a known operator's profile | Operator identity | Operator profile |
| `CreateOperator` | Administration app records a new operator profile | Profile creation facts and retry identity | Created profile |
| `EditOperator` | Operator app maintains an operator's profile details | `operator_id`, profile edits, `request_id`, and `expected_edit_revision` | Committed profile change |
| `DeleteOperator` | Administration app removes an unneeded operator profile | Operator identity and retry facts | Atomic deletion and revocation of explicitly bound keys |

## Discovery messages

| Message | Expected user and purpose | Request | Result |
| --- | --- | --- | --- |
| `GetHealth` | Connecting application discovers the Dataset, exact Protocol version, and health | Authenticated health and discovery request | Dataset, exact Protocol version, and health under [Wire](../wire.md) |
| `GetReadiness` | Deployment monitor checks whether Core is ready to serve requests | Authenticated readiness request | Readiness information |
| `GetReference` | Developer or documentation UI reads the contract and schema reference | Authenticated reference request | Documentation or schema information |

## Identity fields

`CreateOperator` requires `operator_id`, `request_id`, and the profile fields in
[Identity](../identity.md#operator-profiles). `EditOperator` requires the same retry
identity and an edit revision precondition. `DeleteOperator` requires `operator_id`
and `request_id`. Exact retries recover committed deletion; a different request
for a deleted profile returns `410 operator_deleted`. Reads return
`404 operator_not_found` for unknown/deleted profiles. Past attribution stays retained.

`CreateApiKey` requires `api_key_id`, `request_id`, caller-prepared `secret`, and
optional non-null `operator_id`. `secret` uses the exact [API-key encoding](../identity.md#api-key-encoding).
Retry equality uses the original credential facts
without exposing the retained secret. Responses/list entries contain `api_key_id`,
nullable `operator_id`, `created_at`, and nullable `revoked_at`, never a verifier
or retrievable secret. `RevokeApiKey` requires `api_key_id` and `request_id`.
A repeated revocation is harmless. Key creation/binding serializes with profile deletion.
[Identity](../identity.md) owns authority, lifetime, and revocation effects.

List/query bounds and continuation follow [Wire](../wire.md#lists). Core owns the
activity categories and resource accounting; neither is synchronization coverage.

[Messaging index](../messaging.md)
