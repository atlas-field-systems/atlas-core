# Use the Atlas SDK

The package implements Protocol 0.6.0 with HTTP by default and opt-in Full
synchronization. Install the packed SDK with its hash-pinned Protocol artifact.
For a source checkout, prepare Protocol with `npm run protocol:prepare`, install
with `npm ci --ignore-scripts`, then run `npm run build`.

```ts
import { createClient } from '@atlas/sdk';
import { NewId, Sequence, Uuid } from '@atlas/protocol';

const client = createClient({
  baseUrl: 'https://core.example:8443',
  credentials: () => applicationCredential,
});
await client.connect();
if (client.state.kind !== 'ready') throw new Error('Connection unavailable');
const assetId = Uuid.parse(configuredAssetId);
const processGeneration = Uuid.parse(configuredProcessGeneration);
const reporter = client.reporting.asset({ id: assetId, process_generation: processGeneration });
const operation = reporter.update({ request_id: NewId.parse(crypto.randomUUID()) }, {
  report_id: NewId.parse(crypto.randomUUID()), sequence: Sequence.parse(nextReportSequence),
  generated_at: null, mode: 'current', sections: {
    tags: { state: 'value', classification: 'state_until_changed', observed_at: null,
      value: { presets: ['simulated'] } },
  },
});
const result = await operation.send();
operation.close();
const read = await client.assets.get({ asset_id: assetId });
if (read.kind === 'response' && read.response.kind === 'success') {
  const tags = read.response.body.data.tags;
  if (tags?.state === 'value') console.log(tags.value.presets);
}
const cleanup = await client.close();
```

[Tags](../Atlas%20Protocol/components/tags.md) defines preset meaning and refusal.
Observation reporters send a source direction the same way, as one
[Bearing Measurement](../Atlas%20Protocol/components/bearing-measurement.md) section.

## Choose read behavior

Omitted mode or `mode: 'http'` returns `HttpClient`. `mode: 'full'` returns
`FullClient`; a dynamic option returns the discriminated `Client` union.
Full Assets, Tracks, Geofeatures, Tasks and Object metadata expose synchronous
`get`, `list` and `query`, plus Entity `byAlias`. Check `kind === 'available'`
before using a value. A complete stale value includes its readiness status.
Loading, rebuild and stopped states are unavailable. There is no HTTP fallback.
`client.picture` exposes status, local cursor, `changedSince`, `subscribe` and
explicit capacity `retry`. See [picture rules](picture.md) for token lifetimes.

`client.http` provides explicit HTTP resource reads in either mode. HTTP lists
return cursors with `next()` and `close()`; they retain their original selection.
Observations, history, assigned work, contact, content, references, administration,
`resources`, `readiness` and `activity` always use HTTP.

## Use resource workflows

- `assets.history`, `observations.history` and `tracks.history` return frozen remote
  views. Supply stable `query_id` and `entity_id`; use `next()` and await `close()`.
  The handle exposes its original allocation, repeated context and release evidence.
- `tasks.assigned` retains process, read, queue, control and Core-run context.
  Reading instructions does not acknowledge or execute them.
- `assets.contact` returns a current or replacement challenge handle. `read()`
  retains its original allocation; `checkIn()` and `replace()` prepare proofs.
- `reporting.register`, `reporting.asset`, `reporting.createObservation` and
  `reporting.observation` retain source identities across section updates/reports.
  Observation reporters offer explicit `reconcile()` and `recordedTrack()` reads.
  After Dataset invalidation, these reads return `not_sent/dataset_invalidated`;
  preparing another report through the stale reporter throws `dataset_invalidated`.
- `component(schema, value)` constructs detached frozen Protocol values.
  `commandCatalog` is the installed local Protocol catalog.

[Requests](requests.md) owns frozen preparation, deliberate retries, cancellation,
and uncertain outcomes. Writes never update Full's picture. Changed-key
[authorization recovery](authorization.md) never resubmits writes.

## Transfer complete files

`objects.upload(descriptor, source)` returns a prepared upload. Supply stable IDs,
length, SHA-256, media and metadata. Blob/File use native browser multipart. Node
also accepts a fresh byte-zero stream opener; a direct stream is one-shot. Generic browser streams fail before opening or fetching. A retry starts at byte
zero. Caller upload streams must supply chunks no larger than 1 MiB.

`objects.content({ object_id, disposition }, { maxBytes? })` returns a download.
Await `open()` to obtain validated headers and a provisional `stream`. Consume the
stream, then require a successful content result from `settled` before trusting
complete length and digest verification. `cancel()` awaits cleanup. An open or
unread stream retains admission until EOF, cancellation or its deadline.
Downloads accept chunks within the declared length and return copies of at most
1 MiB. Excess content fails integrity verification.
`reference('text/html')` and `reference('application/vnd.oai.openapi+json')` return
bounded validated documents. Content bytes never enter the local picture.

## Bound and close owners

Options include attempt deadlines, request/response budgets, prepared evidence,
`picture` limits and `remote: { handles, retainedBytes }`. Remote defaults are
16 handles and 1 MiB; maxima are 1,024 and 16 MiB. Default network admission is
16 attempts with a 30-second deadline. Full requires at least two admission slots.

`close(): Promise<ClientCloseResult>` awaits all owners and drains stopped attempts
before remote releases. Inspect `result.remote` for acknowledgment evidence.
Authorization pause permits no release traffic. `ClientCloseError` aggregates
cleanup failures and exposes remote evidence when available.

Node and browsers use normal TLS trust. Configure private CAs before starting
Node or in the browser profile. Optional Summary/Debug observers use the bounded
[diagnostic contract](diagnostics.md). See [qualification](qualification.md) for
executed coverage and limits.
