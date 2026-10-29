# Use the HTTP SDK

This package implements HTTP resource clients and prepared JSON domain writes for
Protocol 0.3.0. Full synchronization, frozen remote history, assigned-work reads,
contact allocation, reporting convenience helpers, binary transfers, reference
downloads, and diagnostic observers are not implemented in this package yet.
The five contract pages still define the complete SDK scope.

Install the packed SDK together with its hash-pinned Protocol artifact. For a
source checkout, prepare Protocol with `npm run protocol:prepare`, install with
`npm ci --ignore-scripts`, and run `npm run build` from this directory.

```ts
import { createClient } from '@atlas/sdk';
import { NewId } from '@atlas/protocol';

const client = createClient({
	baseUrl: 'https://core.example:8443',
	credentials: () => applicationCredential,
});
const discovery = await client.connect();
if (client.state.kind !== 'ready') throw new Error('Connection unavailable');

const operation = client.operators.create({
	operator_id: NewId.parse(crypto.randomUUID()),
	request_id: NewId.parse(crypto.randomUUID()),
	name: 'Pilot',
});
const result = await operation.send();
if (result.attempt.kind === 'response' && result.attempt.response.kind === 'success') {
	const operator = result.attempt.response.body.data;
}
await client.close();
```

Resource groups are `assets`, `observations`, `tracks`, `geofeatures`, `tasks`,
`objects`, `operators`, and `apiKeys`. Their methods accept Protocol-inferred
request objects. `resources`, `activity`, and `readiness` are explicit HTTP reads.
`client.http` exposes the same HTTP clients for future routing integration.
Object methods currently concern metadata only.

## Read pages

```ts
const query = client.assets.list({ page_size: 100, filters: { health: ['offline'] } });
const page = await query.next();
if (page.kind === 'response' && page.response.kind === 'success') {
	const assets = page.response.body.data.items;
}
query.close();
```

Each cursor retains the original selection and validates every page against it.
`next()` returns `end` after the final page. A failed or cancelled wait does not
advance it. A cursor never accepts a foreign token or starts a replacement query.

## Inspect a write

Preparation validates and freezes facts. It can throw `ProtocolError` or `SdkError`
before sending. `send()` returns an attempt result and the operation's current
[effect evidence](requests.md). Repeating `send()` deliberately retries the same
facts. Repeated preparation with the same scoped identity shares evidence;
conflicting facts fail locally. Accepted evidence retains the validating attempt
and Core request IDs. The attempt response contains the resource and commit cursor.

`operation.start()` returns an attempt with `settled` and `wait(signal)`.
Cancelling a wait leaves that attempt running to its bounded deadline. A late
matching success updates `operation.outcome`. `close()` aborts network work and
waits for owned attempts to settle. Core's committed effects survive close.

After validated key rejection, network methods return `authorization_required`
without traffic. Change the credential provider, then call `recover()` explicitly.
Changing its value alone does not replace accepted credentials. Recovery never
resubmits writes. `connect()` also refreshes discovery under accepted credentials.
An optional `datasetId` pins the expected Dataset and refuses another one.

## Configure bounds

Defaults are a 30-second attempt deadline, 16 concurrent attempts, 1,024 retained
operation identities, and a 16 MiB accounting budget for retained equality facts.
Request and response budgets default to Protocol's ceilings and can only decrease.
Discovery limits can lower them further. Transport keeps at most one bounded byte
buffer per response. Operation evidence retains no attempt log or response images.
All capacities refuse explicitly. Retained identities last until close. At most
64 rejected credentials are retained per instance; reaching that bound refuses
further recovery. There are no timers while idle.

Node uses its normal TLS trust. Set `NODE_EXTRA_CA_CERTS` before starting Node when
using a private CA. Browsers use their configured trust and Core's trusted origins.
See [qualification](qualification.md) for tested targets and remaining coverage.
