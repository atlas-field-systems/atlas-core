# Use the Protocol package

Install @atlas/protocol 0.6.0 from its packed artifact. The runtime entry has no
Node storage dependencies. The build-only `@atlas/protocol/reference` entry owns
stock OpenAPI export. [Qualification](qualification.md) builds and packs both.

```ts
import {
	exchanges, readJson, writeJson, readHttp, readWssServer,
	type Task,
} from '@atlas/protocol';

const input = readJson(exchanges.CreateTask.request, requestBytes);
if (input.command === 'move_to') input.inputs.target;
const outgoing = writeJson(exchanges.CreateTask.request, input);
const reply = readHttp(exchanges.GetTask, receivedHttp, {
	datasetId, request: { task_id: taskId },
});
if (reply.kind === 'success') {
	const task: Task = reply.body.data;
}
const frame = readWssServer(frameBytes, { datasetId, subscriptionId });
```

Supply original bytes. `readHttpRequest` checks a full inbound HTTP descriptor;
`readHttp` checks received status, media, context headers and selected body.
Headers use the browser `Headers` class. Upload transport supplies only bounded
descriptor bytes through `uploadDescriptor`. Binary reads omit body bytes and
return a validated content descriptor. Reference replies retain raw UTF-8 text;
OpenAPI JSON also passes strict JSON preflight. Stock reference validation belongs
to the build entry. No function opens a connection, buffers a file, or changes state.

With a supplied first-page request, `readHttp` checks page size, attribution,
list filters, history scope/time selection, synchronization negotiation, and the
replay starting cursor. Out-of-selection rows fail with `invalid_http`. Values
within a filter are ORed; supplied filters are ANDed; an empty filter array matches
nothing. Alias selection uses full Unicode case folding without normalization.
The public `selection` table applies these filters to the five synchronized resource kinds.
This validates returned rows, not completeness of the result. SDK retains the
original query for continuation checks; a token alone supplies no selection facts.
Snapshot replies also enforce their declared limits against the complete raw
HTTP envelope or WSS frame. Continuation ownership remains with Core and the caller.

Constructed values for JSON/WSS writers and `readHttp` request context use plain
or null-prototype objects with enumerable data fields. Arrays contain only dense,
enumerable indexed data and their normal non-enumerable length. Hidden fields,
accessors, symbols, sparse arrays, and extra array properties fail with invalid_value
before schema validation or geometry work. Array length budgets precede
property-name allocation. Getters are never called by these
descriptor checks. They do not sandbox caller-realm Proxy traps.

HTTP and WSS boundaries enforce the installed `PROTOCOL_VERSION`; context cannot
override it. Readers retain foreign-version `protocol_mismatch` errors only when
their optional details agree with the response header or frame version. WSS writers
always require the installed version, including mismatch refusals.
`readWssClient` and `readWssServer` also enforce optional expected Dataset, control
request, and subscription context. WSS writers validate constructed frames.
Supplied budgets also cap returned negotiation limits.
Bare schemas and `readJson` validate
shape and stateless semantics; they do not establish authority or transitions.

`budgets` names request, response, control, and synchronization defaults from
[Limits](limits.md). Optional limits only lower these ceilings. The default aggregate
geometry allowance is 4,194,304 units per call; each polygon reserves n² + 8n for
n coordinate pairs before topology allocation. Exhaustion is resource_limit.
Server control frames also observe the 16 KiB and 4,096-value limits.
ProtocolError has a bounded code and issues, without submitted values or exceptions.
Inbound `invalid_http` issues use fixed header, method, path, media, or body
locations and missing, invalid, mismatch, or unsupported reasons. Header locations
use `header.<name>`, such as `header.Authorization`; no header value is included.

The `commandCatalog`, `exchanges`, component and resource schemas are public.
Named component types and RequestOf/ResponseOf exchange types are inferred
from those schemas. With TypeScript `exactOptionalPropertyTypes`, optional wire
fields permit omission and reject explicit `undefined`, including nested fields.
Runtime schemas and writers also reject own `undefined` fields without removing them.
Omission, null, zero, accepted
timestamp spelling and polygon winding survive validation and serialization.
Private file imports are blocked by package exports.

The runtime entry explicitly exports supported wire schemas, their inferred types,
the Catalog, errors, and JSON/HTTP/WSS boundary functions. Schema builders,
numeric conversion, ordering, and uniqueness helpers are package internals.
