# Wire conventions

**One authored contract must mean the same thing in every language.**
Use HTTP/JSON for requests and WebSocket for the change feed, over authenticated
TLS in deployment. Binary content remains binary, not JSON-encoded bytes.

## Common representation

Use UUID identifiers and snake_case wire fields. Encode 64-bit counters as
canonical decimal strings, not JavaScript numbers. Validate their numeric range,
not only their spelling. Preserve double precision for spatial values.

Requests identify `Atlas-Dataset-ID` and `Atlas-Protocol-Version`. Responses carry
the actual Dataset and selected edition, including declared error responses.
Negotiate the highest mutually supported released edition; reject unsupported
combinations rather than guessing from a version number.

JSON success uses `{dataset_id, data, commit_cursor?}`. Mutations with public
changes include their committed cursor. Errors use
`{error: {code, message, request_id, details?}, dataset_id?}`.
The error's request ID is diagnostic correlation, not retry identity or commit proof.

The authenticated raw OpenAPI document, documentation HTML, binary content, and
explicitly empty responses are declared exceptions to the JSON data envelope.
Validate status, media, headers, and body at both ends. A malformed mutation response
may follow a real commit, so it cannot establish rejection.

## Parsing and edits

Accept one bounded UTF-8 JSON document. Reject duplicate decoded member names at
any depth, malformed UTF-8, unpaired surrogates, and nonfinite numbers. Validate
original text before normalizing typed values or verifying signatures.

Patches leave omitted fields unchanged, replace scalars and arrays, merge defined
objects, and use null only for permitted removal/clearing. Validate the complete
merged result atomically. Never insert defaults, coerce values, or drop unknown
input properties to make validation pass. Complete positions remain complete pairs.

## Retry and Dataset rules

Each mutation declares its retry identity and original facts. Repeating those
facts recovers the original effect; changed facts conflict; ended identities do
not recreate resources. Recheck current authorization and Dataset at commit,
including writes to setup that survives Reset.

Missing Dataset is `400 dataset_required`; a mismatch is a typed `409` refusal.
Discovery/bootstrap exceptions must be explicit. A client must not attach an old
request to a new Dataset automatically. Ordinary Restart retains Dataset-scoped
identities; Reset invalidates them. API-key creation has installation lifetime,
but still needs an intentional current-Dataset request.

## Lists

Filters are explicit: AND between fields, OR within a field, and an empty array
matches nothing. Reject unsupported filters. Ordinary lists are moving keyset
views, not frozen snapshots; IDs sort bytewise. Default pages contain 100 items,
maximum 1,000. Tokens bind source, Dataset, kind, filters, size, and continuation;
ordinary tokens expire after 60 seconds. Assigned-work lists also bind queue revision.

[Next: API](api.md)
