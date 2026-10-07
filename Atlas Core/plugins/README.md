# Plugin execution bookkeeping component

[Spec #117](https://github.com/atlas-field-systems/atlas-core/issues/117) delivers the focused Core/Plugin bookkeeping seam selected by the user. The [Plugin topic](../../docs/topics/plugins.md) owns behavior; [ADR-0002](../../docs/adr/0002-core-manages-installed-plugins.md#execution-evidence) explains the accepted tradeoff. This component is not an operational public Core server or complete S3 workflow.

## Ownership and integration

| Component | Owns | Caller supplies |
| --- | --- | --- |
| Core `plugins.Module` | SQLite acceptance, reservations, exposure, cancellation, report commits and Operation reads | Current Dataset/Core run/writing release, validated capability schemas and host runtime authority |
| Plugin `pluginruntime.Runtime` | Process-lifetime duplicate receipts, capability execution and durable unacknowledged evidence | Private socket, runtime credentials, managed working directory, capability implementation and explicit resource bounds |
| Shared `plugindispatch` | Bounded private framing, canonical schema validation and concrete wire binding | The private Protocol artifact installed with the release |
| Host boundary | Verified process identity, confirmed loss, process actions and lifetime enforcement | Existing host-supervision implementation, outside this delivery |

Use `plugins.Open` before binding a runtime. `Submit`, `Read`, `List` and `Cancel` form the component's consumer seam. `BindRuntime`, `VerifyReconnect` and `ConfirmLoss` accept trusted host facts, not caller or Plugin claims. `Listen` owns the private Unix listener and its connections. Its `Close(ctx)` cancels owned work and joins it within the supplied deadline. If it reports incomplete shutdown, retain storage for the process owner; close Core storage only after server work has joined.

`Drain` requests the existing protected stopping policy; `Drained` reports its exact-runtime confirmation to the host owner. A request or loss of availability alone is not stop permission.

A runtime binding belongs to one installation/principal/Dataset/Core run/generation. Verification must come from the host's unchanged-process check. The live witness and retained receipt proof protect reconnection from a fresh runtime presenting old credentials; they do not implement the host supervisor. Starting a replacement requires new authority. Saved evidence preserves its original execution binding while its reporting envelope uses current authenticated authority.

Plugin consumers call `pluginruntime.Open` and `Run`. The execution callback owns the meaning of external effects. Its context receives cancellation independently of the original Operation submitter. The Plugin persists evidence in its own directory; Core uses the private messages and never reads that directory.

Stopping a channel session preserves accepted workers. `Close(ctx)` closes runtime admission, cancels workers and joins the owned session and execution within the supplied deadline. If shutdown is incomplete, the owner must retain working storage and use its process shutdown boundary before deleting it.

Supply an exclusively owned evidence directory within the Plugin's managed working storage. Other capability work, such as private SQLite state or staging files, belongs in separate Plugin-owned locations under that working storage.

Public API/SDK adapters, installation/configuration management, Docker/systemd control, lifetime leases and full Reset cleanup remain integration work. Those adapters must preserve the separate recovered outcome and the topic's existing rules.

## Persistence and contract source

Core's private [SQL schema](sql/schema.sql) and [queries](sql/queries.sql) generate storage bindings with pinned sqlc. The normal generator deletes those outputs and recreates them. No generated storage file is tracked or edited.

The separate [private Protocol artifact](../../Atlas%20Protocol/plugin-dispatch.json) owns dispatch version, wire structure and message/input/result bounds. It does not add public routes or operational SDK methods. Its self-contained JSON Schema capability/evidence profile is compiled by the already pinned Go validator. The private Go binding is handwritten under the [binding exception](../../docs/agents/code-conventions.md#protocol-and-generation): the public OpenAPI 3.0 generator does not consume this independently versioned Draft 2020-12 artifact. There is no second OpenAPI mirror or custom generator. Actual wire bytes validate against the canonical artifact before typed decoding; the existing strict JSON representation check rejects duplicate decoded names and invalid Unicode.

Core uses SQLite WAL with synchronous FULL. Plugin evidence uses synced temporary files, atomic replacement and directory sync, and exact revision acknowledgement. Process-kill tests qualify their exercised cut points on the test filesystem. They do not establish healthy-storage power-loss guarantees or deployment-wide qualification.

Ordinary Plugin progress stays in memory. Reports carrying known effects, output references or a terminal outcome are saved before reporting and can be recovered after process replacement.

The post-rename fault hook schedules a directory-sync failure after the real file replacement. It is test fault injection, disabled during ordinary use, and qualifies preservation on that ambiguous-publication path.

## Verification

Run all required checks from the repository root:

```sh
python3 scripts/verify.py --bootstrap
```

The verifier records passing checks in `.artifacts/verification.json` only after execution, includes clean deterministic Plugin SQL generation and runs the real-process component workflows with the Go race detector. The fixture Plugin is separately built and uses private temporary storage; tests observe Operations and external fixture effects rather than inspecting Core tables.

The [workflow source](workflow_test.go) records the deterministic schedules. The full verifier also retains the existing foundation checks. Test capacities and byte bounds are qualification inputs, not measured field sizing.

| Requirement | Implementation | Reproducible validation |
| --- | --- | --- |
| Durable acceptance, matching retries and bounded reservations | `Module.Submit` and private SQLite transactions | `TestAcceptedWorkOutlivesCallerAndRetriesOnce`, `TestConcurrentIdenticalSubmissionRetriesCreateOneExecution`, `TestConcurrentReservationsAndNeverExposedCancellation` |
| Same-runtime duplicate suppression after acknowledgement | `Runtime.Accept` and retained live receipts | `TestLiveReceiptSurvivesLostAcknowledgementsAndCapacity` |
| Cancellation before and after exposure | `Module.Cancel` and runtime-owned execution context | `TestExposedCancellationSurvivesReceiptAndProgress`, `TestCancellationAfterExposureAndLostReceiptIsNeverUndispatched` |
| Verified reconnect, replacement fencing and protected drain | Runtime bindings, private readiness and `Module.Drain` | `TestDisconnectedRuntimeRequiresVerifiedReconnectAndRetainedReceipts`, `TestVerifiedProcessCannotReconnectAfterLosingLiveWitness`, `TestManualReplacementRebuildsNeverExposedReservations`, `TestActualRuntimeChannelPreservesWorkAcrossSessionCancellationAndDrains` |
| Immutable interruption with authenticated recovered evidence | Core report commit and Plugin evidence persistence | `TestConfirmedDeathRecoversSavedOutcomeWithoutReopening`, `TestCoreProcessCrashRetainsConfirmedAndRecoversOriginalRunEvidence`, `TestDurableKnownEffectArrivesThroughReplacementReadiness` |
| Exact acknowledgement and honest uncertainty around effects | Revision-bound cleanup and storage-fault fencing | `TestDelayedEvidenceAcknowledgementKeepsNewerRevisionAfterDeath`, `TestAmbiguousFilePublicationFencesOldAckAndRecoversNewEvidence`, `TestRealEffectBeforePersistenceRemainsUnknownAndNeverReruns` |
| Ordinary progress remains transient | Runtime pending reports, separate from durable evidence | `TestUnreportedOrdinaryProgressLeavesReplacementReadinessEmpty`, `TestTransientProgressKeepsNewerPendingRevisionAndNeverBecomesRetained` |
| Bounded messages, inputs, retained files and readiness | Canonical private contract, evidence quotas and paged readiness | `TestInputByteBoundPrecedesCanonicalizationAndPreservesReservations`, `TestLargeAcknowledgedReceiptInventoryReconnectsInBoundedPages`, `TestEvidenceQuotaRetainsPreviouslySavedOutcome`, `TestByteQuotaRefusesReplacementWithoutErasingUnacknowledgedEvidence` |
| Faulted retained evidence and rejected stale or malformed messages | Plugin-owned startup validation and private boundary validation | `TestCorruptRetainedEvidenceFaultsReadiness`, [boundary tests](boundary_test.go) |
| Owned, bounded shutdown and detached snapshots | Server/runtime `Close` and copied receipt/evidence values | `TestServerCloseCancelsOwnedReportsAndBoundsIncompleteJoin`, [Runtime boundary tests](../pluginruntime/runtime_test.go), process fixture cleanup |

## Remaining qualification

The approved seam covers the bookkeeping component with separate processes, real SQLite, files and a Unix socket. It does not complete the [S3/S7 workflow matrix](../../docs/architecture/implementation-sequence.md). SDK/direct-Protocol parity, public result helpers, real Plugin containers, host identity/lifetime enforcement, installed-package independence, complete lifecycle/Reset faults, power-loss behavior, sustained workload and production sizing remain required with their owning integrations. There is no arbitrary external-effect exactly-once claim.
