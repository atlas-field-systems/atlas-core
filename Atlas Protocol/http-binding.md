# Concrete HTTP binding

All JSON successes use status 200 and application/json. Authored mutations include
commit_cursor; evidence replies may omit it when duplicate or history-only facts
produce no public change. Deletions return `{deleted: true}`. Revocation returns
key metadata. Releases return `{released: true}`. Failure statuses and details
are defined once in [errors](errors.md). Response headers always describe the
actual context, even when it differs from the request. On success that Dataset
must match the request and body; protocol version must match exactly.
HTTP 401 replies include `WWW-Authenticate: Bearer` under the
[HTTP authentication challenge rule](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.2).

GetReference selects application/vnd.oai.openapi+json or text/html with Accept,
and returns raw OpenAPI JSON or HTML. It has no JSON request body. The standalone
reference document uses the same OpenAPI media type. ReadObjectContent uses its
Object media type, Content-Length, Atlas-Content-SHA256, and Content-Disposition
with only inline or attachment. Descriptors validate these storage facts without
buffering file bytes. Unsupported media, compression, status, headers, or body
shape is a consuming-boundary failure, never an inferred mutation result.

Opaque tokens, cursors, allocation contexts, and version strings are nonempty
Unicode-scalar strings bounded by their whole message; no alphabet is imposed.
Aliases are nonblank and at most 128 scalars. UUIDv4 is required for newly allocated
resource, registration, process, request, report, reading, load, query, read, and
subscription identities; existing references accept canonical lowercase UUIDs.
Moving lists use the closed [query contract](queries.md).
