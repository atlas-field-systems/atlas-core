# HTTP correlation

> Retained current design for review. [Planning status](../../../../README.md#planning-status).

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

[Wire](wire.md#http-correlation)
