# Qualify the HTTP SDK

Use Node 24.22.1 and npm 11.19.0. Build Core with the same Protocol artifact first.
Run these commands from Atlas SDK, with a unique external directory for tests.

```sh
export ATLAS_TEST_ROOT="$(mktemp -d /var/tmp/atlas-sdk-tests.XXXXXX)"
npm run verify:inputs
npm run qualify
```

`verify:inputs` checks pinned tools, lock entries, Core's matching Protocol hash,
the packed artifact, and the installed Protocol runtime and declaration bytes.
`qualify` builds, runs real HTTPS tests, packs SDK, installs an external consumer,
checks positive and negative inferred types, bundles for browsers, and repeats the
HTTPS tests using that installed package. The consumer retains `qualification.json`
and its browser dependency graph under the external test root.

The test runner creates a test CA and starts a fresh Node process with
`NODE_EXTRA_CA_CERTS`. TLS validation remains enabled. Core fixtures provision and
close installations. Domain assertions use public HTTPS exchanges. A real HTTPS
proxy drops, delays, or alters responses after Core processes requests.

The workflows check discovery, exact version and Dataset refusal, original list
selection, immutable preparation, shared retry evidence, lost committed replies,
deliberate deduplication, operation-specific refusal, self-revocation, explicit
changed-key recovery, paused traffic, concurrent attempts, cancellation, late
success, bounded ingestion, Reset, restart, and shutdown. The package check rejects
Node imports and the reference exporter from the browser bundle.

Each passing test closes clients, proxy sockets, and Core workers before removing
its installation. Failed runner roots remain for inspection. These functional
checks do not establish sustained workload capacity, power-loss durability,
actual browser execution, Full synchronization, or the unimplemented workflows
listed in the [package guide](package-usage.md).
Running on tmpfs supplies no disk-durability evidence.
