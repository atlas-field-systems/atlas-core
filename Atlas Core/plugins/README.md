# Plugin execution bookkeeping component

[Spec #117](https://github.com/atlas-field-systems/atlas-core/issues/117) delivers the focused Core/Plugin bookkeeping seam selected by the user. The [Plugin topic](../../docs/topics/plugins.md) owns behavior; [ADR-0002](../../docs/adr/0002-core-manages-installed-plugins.md#execution-evidence) explains the accepted tradeoff. This component is not an operational public Core server or complete S3 workflow.

## Ownership and integration

| Component | Owns | Caller supplies |
| --- | --- | --- |
| Core `plugins.Module` | SQLite acceptance, reservations, exposure, cancellation, report commits and Operation reads | Current Dataset/Core run/writing release, installed Plugin/release capability declarations and host runtime authority |
| Plugin `pluginruntime.Runtime` | Process-lifetime duplicate receipts, capability execution and durable unacknowledged evidence | Private socket, runtime credentials, managed working directory, capability implementation and explicit resource bounds |
| Shared `plugindispatch` | Bounded private framing, canonical schema validation and concrete wire binding | The private Protocol artifact installed with the release |
| Host boundary | Verified process identity, confirmed loss, process actions and lifetime enforcement | Existing host-supervision implementation, outside this delivery |

Use `plugins.Open` before binding a runtime. `Submit`, `Read`, `List` and `Cancel` form the component's consumer seam. `BindRuntime`, `VerifyReconnect` and `ConfirmLoss` accept trusted host facts, not caller or Plugin claims. `Listen` owns the private Unix listener and its connections. Its `Close(ctx)` cancels owned work and joins it within the supplied deadline. If it reports incomplete shutdown, retain storage for the process owner; close Core storage only after server work has joined.

`Drain` requests the [protected stopping policy](../../docs/topics/plugins.md#protecting-active-work); `Drained` reports confirmation for the current runtime to the host owner. A Plugin with continuous ingestion supplies `Config.StopIngestion`; successful return confirms its ingestion writers have joined. Nil declares no continuous ingestion. The Runtime invokes it once on drain or shutdown, preserves it across channel sessions and confirms draining only after ingestion and finite work finish. A failed stop remains a fault and cannot become confirmation on reconnect.

The listener owns an exclusive socket-path claim until its writers join. It recovers a stale socket after Core process death, retries temporary descriptor pressure and reports permanent failures through `Server.Faults()` and `Close`. A fault notification does not establish writer shutdown.

A runtime binding belongs to one installation/principal/Dataset/Core run/generation. Verification must come from the host's unchanged-process check. The live witness and retained receipt proof protect reconnection from a fresh runtime presenting old credentials; they do not implement the host supervisor. Starting a replacement requires new authority. Saved evidence preserves its original execution binding while its reporting envelope uses current authenticated authority.

Capability declarations belong to a selected Plugin installation and release. Readiness advertises exact capability ID/input-version pairs and the Runtime's configured receipt capacity; Core requires that capacity to match its trusted reservation bound before admission. Core rejects an unsupported target/version or invalid input before creating an Operation; independent Plugins may use the same pair with different schemas. Retained Operations keep their original schemas, bundle paths and local resources for result validation and recovered evidence.

Plugin consumers call `pluginruntime.Open` and `Run`. The execution callback owns the meaning of external effects. Its context receives cancellation independently of the original Operation submitter. The Plugin persists evidence in its own directory; Core uses the private messages and never reads that directory.

Stopping a channel session preserves accepted workers and ingestion stopping. `Close(ctx)` closes runtime admission, cancels workers and joins the owned session, execution and ingestion stop within the supplied deadline. A callback error leaves ingestion shutdown unconfirmed. If shutdown is incomplete, the owner must retain working storage and use its process shutdown boundary before deleting it.

`Runtime.Faults()` reports bounded notifications while `Run` retains the first worker failure. Fault observation does not take over `Close`'s cancellation and joining responsibility.

Supply an exclusively owned evidence directory within the Plugin's managed working storage. Other capability work, such as private SQLite state or staging files, belongs in separate Plugin-owned locations under that working storage.

Public API/SDK adapters, installation/configuration management, Docker/systemd control, lifetime leases and full Reset cleanup remain integration work. Those adapters must preserve the separate recovered outcome and the topic's existing rules.

## Persistence and contract source

Core's private [SQL schema](sql/schema.sql) and [queries](sql/queries.sql) generate storage bindings with pinned sqlc. The normal generator deletes those outputs and recreates them. No generated storage file is tracked or edited.

The separate [private Protocol artifact](../../Atlas%20Protocol/plugin-dispatch.json) owns dispatch version, wire structure and message/input/result bounds. It does not add public routes or operational SDK methods. The already pinned Go validator compiles the self-contained private artifact and capability schemas with their supplied local bundle resources. Validation retrieves no filesystem or network references. The private Go binding is handwritten under the [binding exception](../../docs/agents/code-conventions.md#protocol-and-generation): the public OpenAPI 3.0 generator does not consume this independently versioned Draft 2020-12 artifact. There is no second OpenAPI mirror or custom generator. Actual wire bytes validate against the canonical artifact before typed decoding; the existing strict JSON representation check rejects duplicate decoded names and invalid Unicode.

Core uses SQLite WAL with synchronous FULL. Plugin evidence uses synced temporary files, atomic replacement and directory sync, and exact revision acknowledgement. Process-kill tests qualify their exercised cut points on the test filesystem. They do not establish healthy-storage power-loss guarantees or deployment-wide qualification.

Core validates retained records before reconciliation, including their Dataset and writing-release metadata. Dispatch polling queries the current runtime's unfinished work through an index. Original capability schemas and local resources are compiled during opening and retained for result validation.

The canonical private schema supplies array quotas shared by admission and wire validation. Core validates accumulated facts separately from individual messages, so an inventory assembled from bounded reports need not fit one frame. The terminal revision remains reserved when the nonterminal report budget is exhausted.

The [private dispatch and execution-evidence rules](../../docs/topics/plugins.md#private-operation-dispatch-and-reconciliation) own receipts, report ordering, cancellation, exact acknowledgements, runtime fencing and recovered outcomes. Their implementation separates transient progress from durable evidence and keeps Core out of Plugin-private storage.

The post-rename fault hook schedules a directory-sync failure after the real file replacement. It is test fault injection, disabled during ordinary use, and qualifies preservation on that ambiguous-publication path.

## Verification

Run all required checks from the repository root:

```sh
python3 scripts/verify.py --bootstrap
```

The verifier records passing checks in `.artifacts/verification.json` only after execution, includes clean deterministic Plugin SQL generation and runs the real-process component workflows with the Go race detector. Each test process builds the fixture Plugin once in its own normal or race mode, then links that immutable executable into otherwise independent fixtures. Tests use separate processes and private temporary storage, observing Operations and external effects rather than inspecting Core tables. Retained-opening tests use SQL only to inject and restore deliberate corruption while Core is closed; `Open` and `Read` supply their business-state assertions.

The [verification command owner](../../scripts/command_supervisor.py) survives the test worker, owns its descendants and temporary root, and uses the Linux child-subreaper interface to reap orphaned Plugin children, including detached process groups. The required [cleanup check](../../scripts/plugin_checks.py) kills a real workflow worker, reaches a command deadline and interrupts the owner with SIGINT/SIGTERM. Each schedule verifies process exit/reaping and storage removal. Forced SIGKILL of the surviving owner remains outside this qualification.

The [workflow source](workflow_test.go) records the deterministic schedules. The full verifier also retains the existing foundation checks. Test capacities and byte bounds are qualification inputs, not measured field sizing.

| Coverage | Reproducible validation |
| --- | --- |
| Durable acceptance, submission retries, cancellation, duplicate dispatch, capacity, interruption and exact evidence acknowledgement | [Real-process workflows](workflow_test.go) |
| Runtime identity, partial readiness, cancellation retries, replacement fencing and protected drain | [Authority workflows](authority_test.go), [reconnection workflows](reconnect_test.go), [drain workflows](drain_test.go), [ingestion stop workflows](ingestion_test.go), [real-process recovery](workflow_test.go) |
| Report ordering, terminal immutability, output attribution and reserved final revision | [Evidence workflows](evidence_test.go), [revision workflows](revision_test.go) |
| Plugin/release capability ownership, original schemas and local bundle resources | [Installation](installation_test.go), [capability](capability_test.go) and [schema workflows](schema_test.go), [schema boundary tests](../plugindispatch/schema_test.go) |
| Retained integrity, bounded frames/files/bytes, transient progress, worker failures and detached snapshots | [Integrity workflows](integrity_test.go), [private boundary tests](boundary_test.go), [Runtime boundary tests](../pluginruntime/runtime_test.go), [schema-derived limits](../plugindispatch/limits_test.go) |
| Indexed dispatch with retained history, socket ownership, descriptor pressure and bounded shutdown | [Polling workflow](polling_test.go), [listener workflows](listener_test.go), [listener fault notification](listener_fault_test.go), [shutdown workflows](workflow_test.go) |
| Process exit/reaping and storage removal after worker death, deadline or owner interruption | [Executable cleanup checks](../../scripts/plugin_checks.py) |

## Remaining qualification

The approved seam covers the bookkeeping component with separate processes, real SQLite, files and a Unix socket. It does not complete the [S3/S7 workflow matrix](../../docs/architecture/implementation-sequence.md). SDK/direct-Protocol parity, public result helpers, real Plugin containers, host identity/lifetime enforcement, installed-package independence, complete lifecycle/Reset faults, power-loss behavior, sustained workload and production sizing remain required with their owning integrations. There is no arbitrary external-effect exactly-once claim.
