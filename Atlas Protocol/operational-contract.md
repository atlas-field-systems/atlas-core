# S1 operational encoding

The [authored OpenAPI](protocol.json) contains the 19 routes in [#122](https://github.com/atlas-field-systems/atlas-core/issues/122). This page records their concrete encoding choices. [Asset reporting](../docs/topics/asset-reporting.md), [Tasks](../docs/topics/tasks.md), [Identity and access](../docs/topics/identity-and-access.md) and [SDK](../docs/topics/sdk.md) own the behavior. Edition `0.1.0` is unpublished local qualification material.

## Resources and results

Operational JSON successes use `{dataset_id,data,commit_cursor?,read_context?}`; Dataset mutations require the committed cursor. JSON reads carry `read_context: {source: "http", commit_cursor}` from the same authorized SQLite transaction as their data. Errors use the existing typed `Error`. Operational requests require `Atlas-Dataset-ID` and `Atlas-Protocol-Version`, and responses carry the actual Dataset and selected edition. Health, readiness and documentation discovery do not require a Dataset precondition. Authentication supports `Authorization: Bearer` or `X-API-Key`. Deletion succeeds with 204 and context headers. Protected `/docs` serves HTML, and authenticated `/openapi.json` serves raw OpenAPI JSON. Both exceptions retain typed JSON errors and context headers.

`RegisterAssetRequest` carries stable `id`, `type: asset`, `registration_id`, permitted Descriptive inputs and optional `command_manifest`. A registration result returns current `entity` and original `association`, without a secret. `Asset` includes required components, `command_manifest`, per-unit `reporting`, `task_queue` and nullable `process_authority`. Report requests contain only supplied source facts. Derived metadata appears only in reads/results.

Entity PATCH accepts one Descriptive edit or one Entity report. Descriptive edits carry `expected_edit_revision`. Check-in may additionally carry an `authority_claim`. Status reporting carries `{report_context,status}`. Accepted reports return the current resource plus `acceptance`; check-in may include the original authority association. The receipt separates disposition, applied fields, Task effect, movement sample identities and Contact refresh. A duplicate retains the original acceptance receipt and returns current recorded resource state.

Task creation carries `asset_id`, `idempotency_key`, `command: move_to`, `input` and optional `scheduling: queued`. The input has a complete coordinate target and optional explicit ellipsoid target altitude. Current Catalog lookup advertises this S1 variant only. Pause and broader Geofeature-target schemas remain structural prior examples, separate from advertised support.

Task status PATCH uses `kind: cancellation_request` with its `request_id`, or `kind: report` with shared report context and execution facts. Progress may report `fraction`, `distance_remaining_m` and `position_uncertainty_m`. Generic failure has typed `code` and `message`. Cancellation confirmations/declines identify the request. Source lifecycle times and execution identity remain separate from Core resource times. The owning Task module enforces valid combinations and transitions after structural validation.

An empty Task queue starts at revision `0`, with empty requested/confirmed lists, `confirmed_revision: null`, adoption `none` and no claimed execution. Acknowledgement, creation and reads never establish queue adoption. S1 has no editing or adoption operation.

List results contain `items` and nullable opaque `next_cursor`. Assigned-work results also pin `queue_revision` and return `task_queue`; changed queue continuation returns `page_changed`. History requests carry inclusive `from`, exclusive `to`, and `time_basis`, defaulting to `received_at`. Movement results include original per-quantity `observed_at`, Core receipt time, `matched_quantities` and explicit deleted-Entity state. Quantity names are `position`, `speed_mps` and `altitude`; heading is current telemetry without a Movement sample.

Array-valued list filters use JSON query parameter content, percent-encoded in the URL. For example, an empty ID selection is `ids=%5B%5D`. The public SDK accepts typed filter values and encodes these wire strings. The [query contract](../docs/topics/sdk.md#query-and-status-contract) owns filter semantics, ordinary ID ordering and the separate assigned-work order. Ordinary paging tokens bind the query and expire after 60 seconds; report replay retention uses its independent bound.

## Enrollment and signatures

A direct Asset prepares and retains its credential secret before first transmission. It sends the secret in its authentication header. Core retains only the unpadded base64url SHA-256 digest of the secret's UTF-8 bytes. Deployment tooling signs an `EnrollmentGrant` binding `authorization_id`, `installation_id`, `asset_id`, `credential_id`, `credential_verifier` and `recovery_public_key`. The `proof` is Ed25519 over the canonical object containing those fields plus `kind: enrollment`, without `proof`. Core checks the installation and presented credential digest before atomically provisioning registration. After Reset, a surviving credential re-registers with a new registration identity and no new grant. Revocation is permanent until Hard Reset.

All signatures use [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) canonical UTF-8 JSON and [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032) Ed25519, with unpadded base64url keys, signatures and digests. Duplicate JSON keys, invalid Unicode scalars and nonfinite numbers are rejected before canonicalization. Object-key order is insignificant; array order, omission, null and original timestamp strings remain significant. Do not reconstruct signed facts from Go UUID or date-time values.

The report-signing object is:

```json
{
  "kind": "checkin",
  "dataset_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "protocol_version": "0.1.0",
  "target_id": "11111111-1111-4111-8111-111111111111",
  "report_context": {},
  "payload": {}
}
```

Here `report_context` contains the submitted context without `process_proof`. `payload` contains the submitted body without `report_context` and `authority_claim`. Operation kinds are `checkin`, `entity_report`, `status_report` and `task_report`. Task-report payload includes its `kind: report` discriminator. Compression happens after the complete logical report is signed.

Recovery signs `{kind: authority_transfer,dataset_id,asset_id,transfer_id,process_id,expected_generation,process_public_key,report_digest}`. `report_digest` is the unpadded base64url SHA-256 digest of canonical report-signing bytes. The first report's process signature excludes the claim, avoiding circular inputs. Expected generation `0` establishes generation `1`; later claims compare and advance the retained current generation atomically. The trusted Asset runtime owns the process private key; the Asset OS/deployment authority owns recovery signing. Core retains public material.

`SourceInstant` and `NullableSourceInstant` retain accepted source string spellings through generated Go using supported `x-go-type: string`, while both language validators enforce date-time syntax. Core-authored receipt/change/resource/challenge times use normal date-time bindings. Retained `clock_uncertainty_ms` is optional nullable compatibility metadata under ADR-0029 and has no S1 computation or age budget.

## HTTP JSON encoding and limits

Requests support independent `identity` and `gzip` messages. Core responses declare request receiver support with `Accept-Encoding: gzip, identity`; omission of `Content-Encoding` means identity. Responses negotiate using ordinary `Accept-Encoding`. Select gzip only when the complete eligible HTTP message is smaller, including encoding signaling and framing. Preserve decompressed bytes and all signed facts, identities and retry behavior. No cross-message compression dictionary or batching delay is used.

S1 requires identity to remain acceptable for responses. If the client explicitly excludes it, Core returns a bodyless `406` before dispatch. This also applies when that client accepts gzip: response eligibility and compression benefit are unknown before the domain operation runs. Refusing early preserves the size rule without rejecting a mutation after it has committed. Clients can offer `gzip, identity` to receive beneficial compression and direct small responses.

S1 accepts exactly one gzip member. Reject concatenated members, trailing bytes, corrupt/truncated streams and unsupported encodings before domain effects. Bound compressed input, expanded JSON, parsing depth and processing resources. Apply the same original-document, schema and proof validation after decoding. Resource refusal remains typed and does not imply that an unvalidated/lost mutation response proves noncommit.

## Structural evidence

`operational-profile.test.ts` and its Go consumer qualify exclusive heading bounds, source timestamp syntax and concrete composed envelope representation. `report.test.ts` sends the shared report fixtures through generated and direct HTTP, including omitted compatibility uncertainty and retained fractional/offset source spellings. `report-rejection.test.ts` preserves malformed, missing required timing, Unicode, duplicate-name, nonfinite and bound rejections. These checks supplement the operational Core/SDK workflow and fault matrix; schema/generator checks alone do not establish route behavior.
