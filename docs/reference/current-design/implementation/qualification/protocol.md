# Qualify the Protocol package

> Retained current design for review. [Planning status](../../../../README.md#planning-status).

Run commands from Atlas Protocol with a Node version supported by package.json
and its pinned npm version. `npm ci --ignore-scripts` uses the integrity-locked toolchain.

```sh
npm ci --ignore-scripts
npm run qualify
```

The `Protocol qualification` GitHub Actions job runs qualification and formatting
on pull requests and pushes to main, with Node 24.22.1 and npm 11.19.0.
That job bundles browser code. Actual browser execution is the separate procedure below.

`npm test` builds the package and executes boundary, resource, HTTP/WSS, geometry,
route inventory, stock JSON Schema 2020-12 and host-policy checks. Test inputs
and expected facts are separate from production schema definitions.

`npm run qualify` runs `npm test`, exports in two clean Node processes, compares
exact bytes, validates OpenAPI with stock Redocly, packs the package, installs an isolated
consumer, typechecks positive and negative usage, runs imports, and bundles the
installed runtime for browsers. The consumer's generated node-entry.mjs imports
`@atlas/protocol` from that installation and runs the unchanged portable checks
and both maintained corpora against it. The parent requires an import from the
installed package regardless of its entry filename, nonzero portable coverage,
every expected fixture, and no failures.

It records artifacts/qualification.json and the OpenAPI lint output. The
externalConsumer.nodeIntegration result includes the runner path, resolved import,
portable and fixture counts and failures. A Node runner, import, output, or check
failure records bounded diagnostics there. A failed installed Node check or local
corpus disagreement saves the completed report before the command exits nonzero.

Run another frozen corpus through the same public boundary adapter:

```sh
npm run fixtures -- /absolute/path/to/acceptance.json
```

The maintained corpora contain 130 contract cases and 44 additional independent
cases. `npm test`, `npm run qualify`, and the browser page execute both.

The adapter in test/fixture-adapter.mjs accepts the fixture format documented by
test/fixtures/README.md. It preserves raw text and bytes. Parsing-only cases use
checkJsonBytes; domain cases use the actual public schemas. It never changes
expectations. Geometry qualification also verifies exhausted-work refusal.

Serve the portable browser qualification page after building:

```sh
npm run browser -- 4318
```

Open http://localhost:4318 in the collaborative preview. The page runs both
independent corpora and portable consumer checks, including all HTTP exchanges and one
valid frame with maximum collinear, thin, and subnormal polygons. Read
window.qualification for machine-readable results. The server stops on SIGINT.
Pass the external consumer browserEntry from qualification.json as a second
argument to run the installed package on that page.

`npm run export` writes artifacts/openapi.json. Generated files are never patched.
The runtime bundle excludes the reference exporter. The pinned Prettier command
`npm run format` formats source and test modules.
`npm run format:check` checks the same files. Exact dependencies, peer
compatibility and integrity hashes are recorded by package.json and package-lock.json.

These checks do not run a Core server, SDK workflows, physical work, persistence,
reconnection, quota ownership, or deployment capacity. Actual browser runs prove
only the browser and version recorded by that run, not Firefox or WebKit support.
