# Wire conventions

Core's IP binding carries Protocol messages over HTTP/JSON and WebSocket.
[Messaging](messaging.md) defines the exchanges independently of their transport.
This page defines their IP representation. Deployments use authenticated TLS.
Binary content remains binary, not JSON-encoded bytes.

## Common representation

Use UUID identifiers and snake_case wire fields. Encode 64-bit counters as
canonical decimal strings, not JavaScript numbers. Validate their numeric range,
not only their spelling. Preserve double precision for spatial values.

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
The error's request ID follows the correlation rules below.

The authenticated raw OpenAPI document, documentation HTML, binary content, and
explicitly empty responses are declared exceptions to the JSON data envelope.
Validate status, media, headers, and body at both ends. A malformed mutation response
may follow a real commit, so it cannot establish rejection.

## HTTP correlation

An optional `Atlas-Attempt-ID` request header identifies one client-visible HTTP attempt.
Its value is one canonical lowercase UUIDv4. SDK supplies a fresh value per attempt,
including deliberate retries of the same mutation. Core records a valid value at
ingress. Missing, malformed, or multiple header fields leave correlation unavailable;
ignore them without recording their raw contents. Normal header size limits apply.
Core does not track or reject reuse of an attempt value across requests.
Transport retransmissions and redirects hidden by the client runtime may share
the same attempt context; this ID is not a count of physical transmissions.

Core assigns its own request ID and returns `Atlas-Request-ID` on every Core-served
HTTP response, including discovery, errors, binary content, and empty responses.
Its value is a canonical lowercase UUIDv4. An error's `request_id` is the same ID.
This Core-assigned ID differs from stable request IDs in a mutation's retry facts.
The IP binding permits the attempt header for trusted browser origins and exposes
the response header to them. Browser WebSocket handshakes need no custom header.

These IDs are diagnostic context, never authority, retry facts, or commit proof.
Discard malformed correlation headers at the consuming boundary. A header defect
alone does not change an otherwise validated domain outcome. A lost response may
leave only the sent attempt ID available to match client and server diagnostics.
Protocol defines this metadata, not a logger, diagnostic event schema, or log feed.

## Parsing and edits

Accept one bounded UTF-8 JSON document. Reject duplicate decoded member names at
any depth, malformed UTF-8, unpaired surrogates, and nonfinite numbers. Validate
original text before normalizing typed values. A numeric token must not pass a
declared range or integer constraint solely because conversion rounds it.
For example, `100.0000000000000000001` is not an integer even if a double rounds
it to `100`. Typed integer fields accept mathematical integers such as `100`,
`100.0`, and `1e2`. Check the exact source value and field bounds before conversion.
Emit canonical integers and account for their encoded size. Counter strings retain
their separate canonical spelling. [Plugin numbers](operations.md#payload-facts)
have spelling-sensitive retry facts.

Encoded bytes, JSON value count, nesting depth, and semantic validation work are
different limits. A long JSON string is one value. Apply whole-message limits to
requests, responses, and frames, including metadata and repeated resource images.

Patches leave omitted fields unchanged, replace scalars and arrays, merge defined
objects, and use null only for permitted removal/clearing. Validate the complete
merged result atomically. Never insert defaults, coerce values, or drop unknown
input properties to make validation pass. Complete positions remain complete pairs.
Asset updates and Observation reports use [whole-section replacement](reports.md#shared-context) instead
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

## Lists

Filters are explicit: AND between fields, OR within a field, and an empty array
matches nothing. Reject unsupported filters. Ordinary lists are moving keyset
views, not frozen snapshots; IDs sort bytewise. Requested page size defaults to 100,
maximum 1,000. It is an upper bound; byte and value limits may require shorter pages.
The continuation token determines whether more items remain, not the item count.
Tokens bind source, Dataset, kind, filters, size, and continuation;
ordinary tokens expire after 60 seconds. Assigned-work tokens also bind queue revision
and carry captured adoption under [Task paging rules](tasks.md#scheduling-and-controls).

[Next: synchronization](synchronization.md)
