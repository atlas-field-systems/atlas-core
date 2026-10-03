# Slice 0 contract checks

This is the production foundation's isolated contract fixture for [spec #94](https://github.com/atlas-field-systems/atlas-core/issues/94). The [#69 proof](../../docs/research/atlas-reassessment/13-protocol-toolchain-proof.md) remains unchanged as prior art. A passing fixture is not an implemented operational Core API.

From a supported clean checkout:

```sh
python3 scripts/verify.py --bootstrap
```

Prerequisites and exact locks are in [Protocol](../../Atlas%20Protocol/README.md). CI runs that same command for every pull request and branch push. It preserves `.artifacts/verification.log` and the passing `.artifacts/verification.json` report, including source revision, working-tree status, exact tool pins and regenerated file digests. A failed check removes any previous passing report. Required checks cannot be skipped by this entry point.

The agreed behavioral boundary is generated TypeScript transport over actual loopback HTTP to generated Go strict interfaces, real temporary SQLite in WAL mode, and private temporary file locations. The independently authored direct-HTTP path starts from an equivalent separate fixture and checks the same literal expected outcome. Profile, non-HTTP message, local Catalog and runner checks supplement that workflow where the public boundary is schema consumption, package lookup or process lifetime. Clean generation is a separate build check, never a behavioral oracle.

| Coverage | Requirement-to-implementation-to-check record |
| --- | --- |
| Foundation, generation, locks and fixture lifetime (#95) | Table below |
| Patch fidelity, structural rejection and typed request errors (#96) | [Request and patch qualification](README-96.md) |
| Untrusted responses and artificial-edition compatibility (#97) | [Response qualification](README-97.md) |
| Shared report context, precision and canonical non-HTTP messages (#98) | [Report and message fidelity](README-98.md) |
| Local Command Catalog and canonical input associations (#99) | [Representative Catalog](README-99.md) |

| #95 requirement | Implementation | Executed check |
| --- | --- | --- |
| Core and sibling SDK/Protocol ownership | Sibling deliverables and ownership table in Protocol README | Go/SDK builds use those deliverables; public binding inputs exclude test fragments |
| Bounded shared baseline | Canonical `protocol.json`, shared header/parameter references, shared Position/report/read/mutation/error definitions | Public Go/TS generation and strict compilation; profile checks consume canonical decimal/context schemas |
| Exact tool/runtime/parser locks | `toolchain.json`, separate generator/runtime Go graphs, SDK npm lock | Exact tool-version checks, `npm ci --ignore-scripts`, both `go mod verify`; archive fixture rejects wrong digest before extraction and fake Go binary rejects wrong version |
| Disposable deterministic generation | `scripts/generate.py` removes all four output directories, then generates public/test API and private SQL bindings | Two absent-output runs compared byte for byte; outputs are ignored build artifacts |
| Strict Go and generated TypeScript transport | Fixture PUT/GET bound to generated strict handlers; shared Core request adapter and SDK schema/response middleware | `workflow.test.ts` generated transport write/read-back and independent direct Protocol assertions |
| Real temporary SQLite WAL/generated queries | Runner-owned database, `PutValue`/`ReadValue` from private authored SQL | Readiness reports SQLite 3.53.4/WAL; both HTTP workflows read the persisted literal value and exact decimal token |
| Bounded fixture lifetime/private data | `runner.ts` creates directory before spawn; observable JSON readiness; startup/request/shutdown deadlines; SIGTERM then bounded kill fallback | `lifetime.test.ts` checks stopped PID and absent directory after normal completion, missing readiness and initialized startup failure |
| Fixture isolation and canonical reuse | Sorted `*.contract.json` assembly rejects canonical collisions; test-generated bindings/SQL remain in test directories | Public generation uses canonical input alone; SDK strict build and consumer-package dry run include only public types/adapters; fixture checks use separate generated test paths |
| Required verification and CI | `scripts/verify.py`, `.github/workflows/contract-foundation.yml` | Go formatting/build/test/vet, strict TypeScript, SDK build, all contract scenarios and deterministic generation, through one command |
| Profile and coverage limits | Protocol README and limits below | Canonical decimal syntax in SDK and real Go HTTP; missing inherited mutation cursor rejection; original proof unchanged |

The initial value contract checks the literal string `Slice 0: stored through real SQLite` and counter `9007199254740993`, not values generated from the handler or query implementation. Separate fixture processes keep generated-client and direct-Protocol state equivalent without resetting production state. All HTTP requests have finite deadlines, including generated transport calls.

## Extending this fixture

Add uniquely named fixture-only routes/components in a `*.contract.json` fragment. Assembly reuses canonical declarations before generation and fails instead of overriding a shared fact. Add a `*.test.ts` scenario; the shared test runner executes all such files without changing its list. Extend handwritten Go fixture handlers in `Atlas Core/tests/contractfixture`, private SQL here, or the same Core/SDK adapters when the ticket requires it. Keep effects and response-corruption controls test-only. Do not add another field schema in handwritten code or edit generated output.

## Current limits

#95 establishes the value workflow, structural boundary participation, toolchain reconstruction and fixture lifetime. The linked coverage records extend that same foundation with patch/request negatives, corrupted responses and artificial-edition compatibility, shared report/message fixtures and local Command Catalog checks. Binary-transfer qualification remains with #100. Prior research qualification does not count as executed coverage of a new deliverable.

The artificial `0.1.0`/`0.2.0` editions, fixed Dataset ID and representative commit cursors are test facts. Slice 0 does not implement discovery, real edition negotiation, commit-time Reset protection, cursor assignment/replay meaning or actual release compatibility. Request errors allocate diagnostic correlation IDs without establishing submission identity or a commit outcome. Public operational endpoint/resource schemas remain with their owning later slices. It implements no enrollment, Tasks, Object publication, Plugin execution, synchronization, TLS, host lifecycle, quota, capacity, crash durability or field-readiness guarantee. Operational SDK helpers retain the accepted unknown-outcome and safe-retry obligations; a response validation failure alone cannot establish that a mutation was rejected.
