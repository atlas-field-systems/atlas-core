# Wire conventions

Core's IP binding carries Protocol messages over HTTP/JSON and WebSocket.
[Messaging](messaging.md) defines the exchanges independently of their transport.
This page defines their IP representation. Deployments use authenticated TLS.
Binary content remains binary, not JSON-encoded bytes.

## Common representation

Use UUID identifiers and snake_case wire fields. Encode 64-bit counters as
canonical decimal strings, not JavaScript numbers. Validate their numeric range,
not only their spelling. Preserve double precision for spatial values. Timestamp strings use uppercase `T`,
`Z` or an explicit numeric offset, and at most nine fractional digits. Reject
impossible calendar dates and leap seconds; retain accepted spelling.

Requests identify `Atlas-Dataset-ID` and `Atlas-Protocol-Version`. Responses carry
the actual Dataset and Core's Protocol version, including declared error responses.
Require the exact version shared by Core, SDK, and Protocol for that release.
A mismatch returns `409 protocol_mismatch`; do not negotiate ranges or downgrade.

Authenticated `GET /health` is the discovery exception: it accepts requests without
Dataset or version headers. Its normal JSON envelope includes the current
`dataset_id` and `data.protocol_version`. SDK discovers these values, requires its
own exact Protocol version, and then supplies both headers on ordinary requests.

Health and reference data require authentication. A public documentation page may
show only a key-entry form without exposing schemas. Keep keys in memory,
not URLs or browser persistent storage.

JSON success uses `{dataset_id, data, commit_cursor?}`. Mutations with public
changes include their committed cursor. Errors use
`{error: {code, message, request_id, details?}, dataset_id?}`.
The error's request ID is diagnostic correlation, not retry identity or commit proof.

The authenticated raw OpenAPI document, documentation HTML, binary content, and
explicitly empty responses are declared exceptions to the JSON data envelope.
Upload uses an unpadded base64url `Atlas-Object-Descriptor` header containing its
UTF-8 JSON descriptor, followed by one complete binary body. Content reads expose
length, content type, SHA-256 `Content-Digest`, and read disposition.
Validate status, media, headers, and body at both ends. A malformed mutation response
may follow a real commit, so it cannot establish rejection.

WebSocket upgrade carries no credentials or public data. The first `authenticate`
frame supplies the key, Dataset, and exact version. Core owns the authentication
timeout and connection state. Authenticated snapshot release works before a data
subscription. [OpenAPI](openapi.json) defines controls and complete change frames.

## Parsing and edits

Accept one bounded UTF-8 JSON document. Reject duplicate decoded member names at
any depth, malformed UTF-8, unpaired surrogates, and nonfinite numbers. Validate
original text before normalizing typed values.

Patches leave omitted fields unchanged, replace scalars and arrays, merge defined
objects, and use null only for permitted removal/clearing. Validate the complete
merged result atomically. Never insert defaults, coerce values, or drop unknown
input properties to make validation pass. Complete positions remain complete pairs.
Asset updates use [whole-section replacement](reports.md#shared-context) instead
of subfield merging, including on bindings that use PATCH.

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

Alias lookups use an `alias` query value. This preserves aliases such as `..`
that URL parsers would normalize inside a path.

## Lists

Filters are explicit: AND between fields, OR within a field, and an empty array
matches nothing. Reject unsupported filters. Ordinary lists are moving keyset
views, not frozen snapshots; IDs sort bytewise. Default pages contain 100 items,
maximum 1,000. Encode an array filter as one JSON-array query value, such as `ids=[]`. Reject
repeated decoded query names. Omission and an empty array remain distinct.
Tokens bind source, Dataset, kind, filters, size, and continuation;
ordinary tokens expire after 60 seconds. Assigned-work lists also bind queue revision.

[Next: synchronization](synchronization.md)
