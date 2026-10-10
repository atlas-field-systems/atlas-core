# S1 workflow and qualification

[Spec #122](https://github.com/atlas-field-systems/atlas-core/issues/122) implements the direct-IP, queued coordinate Move To slice. The [implementation boundary](../../docs/architecture/implementation-sequence.md#s1-implementation-boundary) and [testing strategy](../../docs/testing-strategy.md) remain authoritative. The local task graph followed Protocol → Core identity/reporting/Tasks → host management and SDK → retained simulator → integration/review. Development does not require issue updates or commits.

Core owns persistence and acceptance. The host manager owns container lifecycle through private Core maintenance, without opening SQLite. The SDK owns signed traffic, typed mutation outcomes and reconciliation. [The external simulator](../../examples/s1/execution-store.ts) owns execution counts, arrival decisions, retained evidence and explicit recovery. [Reporting retention](../../examples/s1/reporting-runtime.ts) keeps credentials, keys, counters and exact pending descriptors outside the SDK process.

## Run locally

The locked environment is Linux amd64, Node 24.21.0, npm 11.19.0 and the Go/sqlc/Ruff versions in [toolchain.json](../../Atlas%20Protocol/toolchain.json). Install Docker with Compose v2 and OpenSSL. Real-container qualification requires daemon access, plus passwordless local sudo for the offline namespace proof using `unshare` and `nsenter`. Missing prerequisites fail the verifier; no operational checks are skipped.

```sh
python3 scripts/verify.py --bootstrap
```

The verifier regenerates outputs twice from absent directories, builds all three production commands and the local `atlas-core:s1` image, and runs S0, Plugin, S1 SDK/storage/race/container checks. Nested TLS fixtures prove private-key cleanup after worker death, deadline and cancellation. The verifier also kills a real serving workflow worker, expires its deadline and interrupts its supervisor. A surviving fixture owner removes the recorded containers and networks before deleting their mounted storage. It then runs the standalone offline demonstration. A successful run writes `.artifacts/verification.json` with executed check names, source-file hashes, tool versions, binary hashes and the exact container image identity. It removes the previous report before starting; a failed run leaves no passing report.

For operator setup and persistent manager installation, follow [deployment](../../deployment/README.md). After loading tools, dependencies and the image, run the non-test demonstration separately:

```sh
python3 examples/s1/offline-demo.py --artifacts .artifacts --image atlas-core:s1
```

This creates an isolated installation through the real CLI. Core and SDK run with only loopback and an independently checked external `ENETUNREACH`. The demonstration uses normal CA-verified HTTPS, completes Move To, confirms cancellation and restores execution count 1. Its manager survives separate CLI processes; Stop and owned-resource cleanup complete afterward.

## Requirement and evidence map

Each entry names executable evidence. A passing report establishes only the checks that actually ran against that report's source and binaries.

| #122 requirement | Implementation | Executable evidence |
| --- | --- | --- |
| All 19 routes and equivalent SDK/direct behavior | [Protocol](../../Atlas%20Protocol/protocol.json), [Core composition](../../Atlas%20Core/systemoperations), [public SDK](../../Atlas%20SDK/src/client.ts) | [SDK workflow](../../examples/s1/workflow.ts) and independently authored [direct Protocol workflow](direct.ts), run by the real-container `TestPublicSDKAndDirectProtocol` |
| Read authorization, filters, permanent-ID ordering, 60-second paging and observed HTTP boundary | Identity-owned authorized reads, Entity/Task page queries, public SDK | [Deletion against all GET families](../../Atlas%20Core/operationaltests/read_access_test.go), [real HTTPS query matrix and maximum-size selection traversal](../../Atlas%20Core/operationaltests/query_test.go), SDK workflow |
| Offline trust, prepared admin verifier, enrollment authority, shared CLI | [Host manager](../../Atlas%20Core/hostmanagement), [deployment](../../deployment) | [Actual lifecycle tests](../../Atlas%20Core/hostmanagement/workflow_test.go), [setup validation](../../Atlas%20Core/hostmanagement/setup_test.go), [standalone offline program](../../examples/s1/offline-demo.py) |
| Registration defaults, retries, per-Asset identity and process replacement | [Identity](../../Atlas%20Core/identity), [Asset helper](../../Atlas%20SDK/src/asset.ts) | [Concurrent registration/admission variants](../../Atlas%20Core/operationaltests/variants_test.go), [lost replies and replacement barriers](../../Atlas%20Core/operationaltests/faults_test.go), [real SDK recovery](recovery.ts) |
| Queued order, 5.1 m progress and 4.9 m completion, failure/support changes, cancellation and bounded admission | [Tasks](../../Atlas%20Core/tasks), [independent execution](../../examples/s1/execution-store.ts) | SDK/direct workflow, [HTTPS workflow](../../Atlas%20Core/operationaltests/workflow_test.go), [variants](../../Atlas%20Core/operationaltests/variants_test.go), [cancellation/report boundaries](../../Atlas%20Core/operationaltests/boundaries_test.go), [independent transitions](../../Atlas%20Core/tasks/transition_test.go), [1001st Task admission](../../Atlas%20Core/operationaltests/paging_test.go) |
| Sparse per-quantity timing, tombstones, stable movement/history traversal | [Entities](../../Atlas%20Core/entities), [history/page handlers](../../Atlas%20Core/systemoperations/pagination.go) | Workflow, [sparse boundary cases](../../Atlas%20Core/operationaltests/boundaries_test.go), [history variants](../../Atlas%20Core/operationaltests/variants_test.go), [cursor Restart, expiry, progress and concurrent history append](../../Atlas%20Core/operationaltests/paging_test.go) |
| Atomic original-fact acceptance, duplicate/conflict/current-process checks, Contact | [Write commits](../../Atlas%20Core/writecommit), [identity](../../Atlas%20Core/identity), [canonical facts](../../Atlas%20Core/corefacts) | [All report routes](../../Atlas%20Core/operationaltests/boundaries_test.go), [precommit and actual response-loss schedules](../../Atlas%20Core/operationaltests/faults_test.go), [cross-language canonical vectors](canonical-vectors.json) |
| Retained completed/running/suspended/unknown execution; no rerun; explicit continuation recovery | External simulator and reporting retention, SDK reconciliation | [Real-container recovery](recovery.ts), [execution retention](retention.test.ts), [private keys and pending descriptor retention](reporting-retention.test.ts) |
| Alias/edit concurrency and guarded deletion/revocation | Entities and identity in the shared commit | Workflow, variants, [Unicode Alias lookup, collision, edit and Restart](../../Atlas%20Core/operationaltests/alias_test.go), [both-order deletion/report/assignment barriers](../../Atlas%20Core/operationaltests/faults_test.go) |
| Stop/Restart/Reset, establishment proof, lost result and new-work preservation | Host manager, [Core maintenance](../../Atlas%20Core/coremaintenance), write commits | Real lifecycle/race tests, [retained opening and Reset](../../Atlas%20Core/operationaltests/maintenance_test.go), [writing release/schema refusal](../../Atlas%20Core/writecommit/boundary_test.go), [surviving fixture-owner failure schedules](../../scripts/s1_checks.py) |
| Typed unknown outcomes, no implicit retry, obsolete Dataset and delayed replies | Public SDK and prepared descriptors | [SDK boundary and credential-deadline tests](client-boundaries.test.ts), [bootstrap loss](bootstrap.test.ts), real recovery and Core Reset barriers |
| Bounded gzip, smaller complete messages, original bytes/proofs, strict decoding/TLS | [Core encoding](../../Atlas%20Core/httpcontract/encoding.go), [Node transport](../../Atlas%20SDK/src/node.ts) | [Real TLS transport faults](transport.test.ts), [Core encoding checks](../../Atlas%20Core/httpcontract/encoding_test.go), [nested TLS fixture failure schedules](fixture-lifetime.ts), existing request/response validation suites |

The supported local Protocol edition is unpublished `0.1.0`; unsupported editions are refused. S1 implements HTTP mode. Objects, Plugin execution, broader Commands, Full synchronization, complete public administration, Hard Reset/update, load budgets and physical/radio evidence retain their later-slice owners. This qualification does not establish power-loss durability, a released compatibility range or field readiness.
