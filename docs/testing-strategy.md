# SDK and Core integration testing

Accepted on 22 September 2026. Atlas requires extensive integration testing between the real SDK and Core. External systems are expected to integrate through the SDK; demonstrating its behavioral parity with Core makes those external SDK tests useful evidence about Core integration. Cover the contracts thoroughly with independent expected outcomes, rather than maximizing test count or testing generated code against another output of the same generator.

This is a required testing plan. The repository currently contains documentation, not an implemented suite or measured parity result.

## Real boundaries and independent expectations

Run the actual supported TypeScript SDK against the actual Go Core over its public HTTP/feed boundary, using real SQLite and temporary Object storage. Include the real Plugin container boundary where relevant. Simulated Assets and deterministic fault injection provide reproducible inputs; mocked Core responses alone cannot satisfy these integration requirements.

Run shared, independently authored scenario fixtures through both direct Protocol requests and public SDK methods against equivalent isolated initial datasets. Check expected requests, responses, errors, stored outcomes and observable changes. Normalize only intentionally nondeterministic fields such as allocated IDs or clock values; do not normalize away ordering, missing fields, errors or duplicate effects. Direct HTTP is a test oracle path, not a bypass added to synchronized SDK application methods.

Parity means equivalent specified behavior for corresponding operations. HTTP, full synchronization and Asset hybrid intentionally have different source and freshness rules. At defined synchronization boundaries they must agree on applicable resource values, lifecycle outcomes and deletions. Tests must also prove those mode differences, including not-ready/stale behavior, local queries/feed and the absence of hidden HTTP read fallback. Match supported Core/SDK/Protocol combinations and test explicit rejection of unsupported combinations; version coverage must be recorded.

## Required scenario coverage

| Area | Required integration evidence |
| --- | --- |
| Every public SDK operation | Successful operation, meaningful validation failures, absent/null/partial-field behavior, errors, pagination, request identity and response mapping against Core. Unsupported or deliberately unwrapped routes are listed explicitly. |
| Asset identity and contact | Enrollment retry, two distinct Assets, valid own reports and rejected cross-Asset reports across every mutation path; fresh reports versus duplicates/stale reports; administrative boundaries and revocation. |
| Task lifecycle | Accepted transitions and rejected transitions, cancellation requested versus confirmed, completion/failure races, duplicate and out-of-order reports, late Object readiness, terminal immutability and no inferred outcome from disconnection. Add pause and immediate execution cases when their contracts are decided. |
| Task queues | Concurrent edits from the same revision, idempotent edit retries, delayed confirmations, new Tasks and execution starts during reordering, reconnect reconciliation, no reordering of started work and no Core scheduling gate based on communications. |
| SDK modes | Identical public operational read methods; HTTP passthrough; full local picture and local query/feed behavior; hybrid scope and dependency entry/removal; out-of-scope HTTP behavior; writes to Core and authoritative local reconciliation. |
| Synchronization | Initial pagination while writes occur, feed/recovery handoff, disconnects, duplicate/delayed events, deletion replay, expired cursors, slow consumers and bounded buffers. Prove no silent gaps, duplicate notifications or cursor advancement past unapplied changes. |
| Reset and Restart | Old responses, submissions, retries and cursors rejected after Reset in every mode; no obsolete state resurrection; retained data and change window after Restart; interrupted Operations without automatic rerun. |
| Objects and histories | Interrupted full-file upload and cleanup, lost success response, concurrent identical retries, conflicting identity reuse, ready-only visibility, immutable bytes, download equality, movement deduplication and stable history pagination, activity attribution without secrets. |
| Plugin Operations | Durable acceptance before dispatch, disconnected caller, duplicate submission, progress/cancellation/terminal races, failure with known outputs, Plugin loss/removal and Core interruption. |
| Resource limits | Defined overload responses, bounded memory/storage behavior, slow links and consumers, concurrent Assets, meaningful latency/throughput and transferred-byte measurements. |

Use sequence-driven tests with an independently specified state model for lifecycle and recovery combinations. Preserve failing seeds and packet schedules so randomized failures can be reproduced. Focused unit tests support the suite, especially validation and transition rules; they do not replace real integration coverage.

## Fault and bandwidth testing

Inject dropped requests, lost successful responses, reconnects, duplication, reordering, latency and bandwidth limits at appropriate transport boundaries. Use deterministic barriers and observable readiness rather than arbitrary sleeps. Include targeted crashes between accepted database writes and delivery to verify recovery behavior. Keep test fixtures isolated and resettable.

Measure steady telemetry, Task delivery/cancellation/reordering, initial synchronization and reconnection separately. Compare full synchronization and Asset hybrid with the same Asset workload. Account for transmitted dependencies, metadata, authentication overhead, acknowledgements and retries, not only useful JSON bytes. Set byte/latency/memory budgets from representative measured workloads before claiming a performance guarantee. Load tests must report correctness failures as well as throughput; a faster run with lost updates does not pass.

## External systems and future radio gateways

Publish reusable contract scenarios and expected outcomes that external systems can exercise through the SDK. For a future radio gateway, use the same logical fixtures for firmware-to-gateway translation and gateway-SDK-to-Core behavior. Preserve identity, units, optional values, request/report identity, lifecycle ordering, errors and Dataset boundaries through encoding and decoding.

SDK–Core parity plus firmware–gateway parity provides composable evidence only for the versions, supported operations and conditions covered. Keep a representative end-to-end suite through firmware or a faithful emulator, the gateway, the real SDK and real Core. Translation boundaries and interacting retries can fail even when each isolated pair passes. Physical radio tests remain necessary for claims about actual RF behavior; emulator results must be labeled as such.

Do not require raw HTTP JSON over a future constrained radio link. Compact representations can preserve the same contract, but must pass the semantic scenarios and measured bandwidth tests. No future gateway or firmware implementation is selected by this testing requirement.

## Continuous integration and completion evidence

As features are implemented, their contract scenarios ship with them. Require the deterministic SDK–Core integration suite and compatibility checks for relevant changes; group tests for useful feedback without skipping failures. Run broader randomized, sustained-load and impairment matrices on scheduled runs and before releases. Record exactly which suites and version combinations ran; unrun coverage is not a passing result.

A feature is complete only when its applicable real integration scenarios pass, including relevant failure and retry paths. Preserve reproducible fixtures, failing seeds, versions and useful traces as test artifacts without credentials. Add regressions for demonstrated contract failures, not duplicate smoke tests or snapshots that merely mirror implementation. Exact CI jobs, tooling and numeric workload budgets follow the implementation.
