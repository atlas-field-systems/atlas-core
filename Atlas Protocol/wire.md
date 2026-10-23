# Wire conventions

The initial binding is HTTPS/JSON and WSS. Compact encodings and constrained-radio
bindings are outside initial scope. Binary content remains binary.
[Messaging](messaging.md) defines meaning independently of transport.

## Common representation

Use UUID resource/request IDs and snake_case fields. [Limits](limits.md) fixes counter strings,
exact numeric/timestamp ranges, Unicode lengths, and complete-message bounds.
Spatial values retain binary64 precision. UTC spelling is
`YYYY-MM-DDTHH:mm:ss[.fraction]Z`, with accepted spelling retained.

Requests supply `Atlas-Dataset-ID` and `Atlas-Protocol-Version`. Every response
carries the actual Dataset and exact Protocol version in those headers, including
errors, binary, and empty replies. Releases require exact Core/SDK/Protocol version
agreement. A mismatch is `409 protocol_mismatch`, without downgrade or negotiation.

Authenticated `GET /health` is the discovery exception and needs neither header.
Its JSON `data` contains `protocol_version`, `core_run_id`, effective `limits`,
`temporary_limits`, and the [temporary allocation context](temporary-reads.md).
SDK validates that version,
then supplies both context headers on ordinary requests.

HTTP uses `Authorization: Bearer <api_key>`. Health/reference data require
current authority. A public documentation page can show only a key-entry form.
Keep keys in memory, outside URLs and browser persistent storage.

Success is `{dataset_id, data, commit_cursor?}`. Mutations with public changes
include their committed cursor. Errors are
`{error: {code, message, request_id, details?}, dataset_id}`.
The error request ID is Core-assigned correlation. Details are closed code-specific
fields, never an arbitrary exception dump. The actual Dataset is always present.

Raw authenticated OpenAPI, documentation HTML, binary content, and explicitly empty
replies are envelope exceptions. Validate status, media, headers, and body at both
ends. A malformed mutation response establishes neither commit nor rejection.
Reconcile the outcome using the mutation's original retry facts.

## HTTP correlation

[HTTP correlation](http-correlation.md) defines `Atlas-Attempt-ID` and
`Atlas-Request-ID`. Diagnostic IDs are separate from retry facts and commit proof.
Trusted-origin browser access permits Protocol headers and exposes response context.

## Parsing and edits

Accept one bounded UTF-8 JSON document. Reject duplicate decoded member names,
malformed UTF-8, unpaired surrogates, and nonfinite numbers. Reject unknown fields
in closed Protocol objects. Plugin-owned JSON follows its installed schema and
the bounded [lossless payload contract](operations.md#payload-facts).
Validate original text before normalization. A rounded conversion cannot satisfy
an exact range or integer constraint. `100.0000000000000000001` is not an integer.
Typed integer fields accept exact mathematical integers such as `100`, `100.0`,
and `1e2`, then emit canonical integers. Counter strings use their separate spelling.
[Plugin JSON](operations.md#payload-facts) retains spelling-sensitive number tokens.
Apply independent [byte, value, depth, and work budgets](limits.md) to full envelopes.

Patches preserve omitted fields, replace scalars/arrays, merge defined objects,
and use null only for permitted clearing. Validate the complete merged result
atomically. Never insert defaults, coerce, or discard fields to obtain validity.
Positions remain complete pairs. Asset updates and Observation reports instead use
[whole-section replacement](reports.md#shared-context), including on PATCH bindings.

## Retry and Dataset rules

Each mutation identifies original facts and retry identity. Equal facts recover
the original effect; changed facts conflict; ended identities never recreate it.
Recheck authority and Dataset at commit, including installation-setup writes.
Missing Dataset is `400 dataset_required`; mismatch is `409 dataset_mismatch`.
Only declared discovery/bootstrap exchanges are exempt. Never attach an old request
to a new Dataset automatically. Restart retains Dataset identities; Reset ends them.
API-key creation identity survives Reset but still requires an intentional request
under the current Dataset. Response loss never proves that no effect occurred.

## Lists

Filters use AND between fields, OR within a field; empty arrays match nothing.
Unsupported filters are refused. Moving keyset lists sort IDs bytewise and use
`page_size` from 1 through 1,000, default 100. Byte/value limits can shorten pages.
Responses have `items` and nullable `next_page_token`; only null means complete.
Tokens bind source, Dataset, kind, exact filters, size, and position, and expire
in 60 seconds. Assigned work also binds queue/control revision and captured adoption
under [Task rules](tasks.md#scheduling-and-controls).
[History](history-queries.md) instead freezes a finitely lived view. Tokens never
change their original source.

## Deterministic IP mapping

Message names are exact OpenAPI `operationId` values. JSON messages use
`POST /messages/<snake_case_name>`, with acronym words together, such as
`CreateApiKey` to `create_api_key`. This is a static route table.
`GetHealth` uses `GET /health`; `GetReadiness` uses `GET /readiness`;
reference HTML/schema uses `GET /reference` with declared media. Upload uses
`POST /objects` with multipart parts `descriptor` as JSON and `file` as binary.
Content reads use `GET /objects/{object_id}/content`. Other metadata uses the JSON
mapping. WSS uses `/changes` and [synchronization envelopes](synchronization-messages.md).
The [schema profile](schema-profile.md) fixes generation and lossless boundaries.

[Next: synchronization](synchronization.md)
