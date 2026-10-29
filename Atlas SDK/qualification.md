# Qualify the Atlas SDK

Use Node 24.22.1 and npm 11.19.0. Build Core with the same Protocol artifact first.
Keep mutable consumers, browser profiles, databases and logs outside the workspace.
Run from Atlas SDK with a unique external root.

```sh
export ATLAS_TEST_ROOT="$(mktemp -d /var/tmp/atlas-sdk-tests.XXXXXX)"
npm run verify:inputs
npm run qualify
npm run test:browser
```

`verify:inputs` checks pinned tools, lock entries, Core's matching Protocol hash,
the packed artifact, and installed Protocol runtime and declaration bytes.
`qualify` builds, runs all source suites, packs SDK, installs an external consumer,
checks positive and negative inferred types, bundles every public export for
browsers, and reruns public workflows through the installed root entry.
`*.owner.test.mjs` runs only in source. Public type suites resolve the installed
package when `ATLAS_SDK_ENTRY` is set. The unsupported `partial` mode check remains
independent of positive and negative Full-mode checks.

## Public workflow coverage

Real HTTPS/WSS fixtures exercise discovery, exact Dataset/version refusal, prepared
identities and shared evidence, lost replies, deliberate retries, cancellation,
late original-Dataset success, key recovery, bounded ingestion, Restart and Reset.
Reporting tests cover retained source identities, exact readings, sections and
recorded Track attribution. Remote tests cover frozen history, repeated context,
assigned instructions, contact proofs and process replacement. Transfer tests
cover native multipart, byte-zero retry, content/reference validation, provisional
streams, EOF digest verification and cleanup failures.

Full tests cover all five resource kinds, atomic snapshot/feed publication, local
reads without HTTP, frozen queries, journals/subscriptions, stale authorization,
recovery, invalid frames and finite capacity. Integration tests combine the owners
in both modes and check active-stream close, blocked admissions, concurrent close,
lost release evidence, paused release traffic and failure aggregation. Internal
suites retain allocation-owner timing, Session/socket cleanup, diagnostic bounds,
and an isolated bounded-memory transfer check.

The Node runner establishes a test CA before a fresh process starts; TLS validation
stays enabled. A real HTTPS proxy can lose, delay or alter Core responses. Each
passing fixture awaits clients, proxy jobs, sockets and Core workers before removal.
Failed roots remain for inspection. The external package consumer retains
`qualification.json` and the complete browser dependency graph.

## Actual Firefox execution

`test:browser` packs and installs another consumer, type-checks its browser JavaScript
with strict DOM-only declarations, bundles all public exports, and runs Firefox
through real Core HTTPS/WSS. Install the browser matching pinned Playwright 1.64.1.
Set `PLAYWRIGHT_BROWSERS_PATH` for a task-local browser cache and
`ATLAS_BROWSER_CERTUTIL` for NSS certutil when it is outside PATH.

A fresh isolated Firefox profile first rejects the test issuer. The runner imports
its CA into only that profile, then proves normal authenticated TLS. It preserves
HTTP's zero-WebSocket check, CORS/correlation, wrong context/key/version refusals
and retained values after Core Restart. Full then proves initial publication,
authenticated WSS updates, zero-HTTP local reads, explicit Observation/history,
stale authorization, changed-key recovery and awaited socket/client shutdown.
Native Blob/File tests verify multipart order/media against Core, exact retry with
one Object, streamed bytes and digest, reference retrieval, exposed content headers,
and generic-stream refusal before opener or HTTP. Evidence records the actual
artifact, browser version, trust database, wire observations and cleanup.

## Accept qualification evidence

Each runner rejects workspace roots, including symlink aliases, before creating a
mutable fixture. `qualify` records source and installed phases separately in the
consumer's `qualification.json`; Firefox records its own report. Reports retain
the tested Git revision and dirty state, SDK archive SHA-256, tool versions,
command arguments and working directories, expected and actual exits, and bounded
closed logs outside deleted TLS fixtures. Expected negative type exits are explicit.
Failures retain logs and a failed or incomplete report; they cannot produce PASS.

Before accepting a handoff, run `npm run evidence:verify -- --revision <full-HEAD>
<package-qualification.json> <browser-qualification.json>`. The verifier rejects
dirty or mismatched source, missing or changed archives/logs, truncated or unclosed
logs, and failed or incomplete commands. This is trusted local execution evidence,
not cryptographic proof that commands ran. Browser facts survive finalization.
CI uploads reports and referenced logs/artifacts, never whole profiles or fixtures.

CI checks all SDK source, scripts and tests with Protocol's pinned Prettier/config,
and Core source, scripts and tests changed against a validated comparison base.
Legacy unchanged Core files remain outside this incremental formatter gate.

## Limits of this evidence

Source and installed Node suites are separate from actual Firefox. Browser bundling
alone proves neither browser execution nor server compatibility. Chromium, WebKit,
other platforms, sustained workload, container/release validation and power-loss
durability are unrun here. Core has its own [qualification](../Atlas%20Core/qualification.md).
Functional tmpfs Restart and bounded-memory checks establish no disk durability or
supported retained-workload capacity. Independent full-branch review remains a
separate gate.
