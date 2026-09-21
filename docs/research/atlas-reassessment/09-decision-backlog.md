# Decision and experiment backlog

Current lifecycle contract: [ADR-0015](../../adr/0015-separate-start-stop-restart-and-reset.md) supersedes wipe-on-start. Start, Stop and Restart retain operational data and logs; Reset clears them while keeping setup and installed artifacts. Core stays running throughout field missions; Restart and Reset are primarily development actions outside missions. Mission execution continuity across Core restart is outside scope. Updates to a new Core release perform Reset; operational-data migrations are excluded. Backup and restore functionality is excluded. Source observations below describe the inspected historical implementation; successor recommendations remain provisional unless backed by an accepted decision.


Successor decision update: [Core owns Commands and Assets execute Tasks](../../adr/0004-core-owns-commands-and-assets-execute-tasks.md). Plugins expose Operations, process data or ingest external sources; they cannot introduce Asset Commands or be taskable Tool Assets. [Planned stops and updates protect active Plugin work](../../adr/0006-protect-active-plugin-work-during-lifecycle-changes.md). Source descriptions below remain historical evidence; conflicting research proposals are superseded.

Decision update: Core now [owns installed Plugin lifecycles](../../adr/0002-core-manages-installed-plugins.md) and [retains activity history until Reset](../../adr/0015-separate-start-stop-restart-and-reset.md). Earlier alternatives in this research remain evidence for implementation tradeoffs, not unresolved choices about whether Core manages Plugins or records these actions.

Planning update: [ADR-0001](../../adr/0001-release-core-sdk-and-protocol-together.md) accepts one release workflow and matching Core, SDK and Protocol versions, including unchanged components. [Compatible client versions are now accepted](../../adr/0005-allow-compatible-client-versions.md); each release documents a supported client-version range and rejects unsupported clients; exact ranges and checks remain implementation choices. The [system outline](../../architecture/system-outline.md) is the current planning entry point; module and subsystem assignments in these research notes remain proposals. Permanent Plugins and combined backend/UI extensions are also under consideration, so lifetime alone does not determine placement.

Research date: 2026-09-20
Research timestamp: 2026-09-20T15:35:31-04:00

Status: research handoff. This file contains proposals, not accepted ADRs or implementation tickets. No GitHub issues were created.

## Settled scope

The user accepts breaking changes that simplify the successor, wants one server with field devices for a few hours of local coordination per run, requires installed Core to operate without internet, preserve operational data/logs across Start, Stop and Restart, and clear them on Reset, and needs removable mission extensions in separate repositories. Core is the system being designed, not necessarily one software module. Permanent modules and temporary extensions must coexist; the extension execution and management mechanism remains open. See [the clarified requirement](11-mission-extensions.md).

No old wire compatibility, plugin install format, database layout, or directory structure is automatically binding. Data integrity and honest execution outcomes are still required for any retained capability.

## Decisions in dependency order

| ID | Decision | Recommended starting point | Alternatives worth testing | Evidence required before acceptance |
| --- | --- | --- | --- | --- |
| D1 | Which real workflows define the first Core? | Observe an Asset, inspect an External source, execute one real Command | Observation/query-only release before tasking | Name the actual device/source/Command, visible outcome and failure behavior |
| D2 | How do integration capabilities belong to Core? | Core-managed installed extensions in separate repositories alongside permanent modules; lifecycle changes do not restart Core | Managed processes or containers; exact installation and supervision mechanism remains open | Run, remove and archive a specialized processor without changing the Core build or leaving dependent results unreadable |
| D3 | Server implementation language | Go modular server as reuse baseline | TypeScript/Node modular server | Same observation, Task and integration slice; count ported behavior and custom infrastructure as well as feature code |
| D4 | Metadata and content storage | PostgreSQL baseline; compare fewer-service storage | PostgreSQL plus local content; SQLite plus local content; bounded bytes in DB if workload permits | Expected write/byte workload, restart retention and Reset cleanup across stores, concurrent reads, disk-full handling and operator effort |
| D5 | Client consistency contract | Typed request client with explicit optional synchronization | Query invalidation/refetch; within-run replica only for clients that need it | Demonstrate freshness, delete races, reconnect, hydration races and slow-consumer behavior under the selected contract |
| D6 | Contract ownership and generation | Language-neutral external contract with one owner | Keep JSON Schema and shrink generator; TypeSpec/OpenAPI or a language-derived contract after a slice test | Optional/null, unions, patches, validation, client generation and artifact drift pass the same fixtures; define supported overlap for later field-client upgrades |
| D7 | Operator and device authority | Operators have full control; Asset credentials identify the reporting Asset; Plugin operational credentials cannot administer Core or impersonate Asset execution | Choose simple enrollment and credential mechanisms within the [fixed boundaries](../../architecture/system-design.md#identity-and-access) | Verify assigned-Asset report checks, denied Plugin administration, allowed Plugin Task issuance and actor attribution |
| D8 | Deployment and update product | One documented server package and one primary operator path | Simple Compose; binary/service manager; interactive manager when its UX is required | Fresh-host installation, restart retention, Reset cleanup, update startup and credential rotation all have tested outcomes |
| D9 | Runtime history and lifecycle | Start, Stop and Restart preserve data/logs; Reset clears them while preserving setup and artifacts | Storage and log implementations that satisfy the lifecycle | Verify both retention and clearing across metadata, content, history, transfer/sync state and logs; updates to new Core releases perform Reset; operational-data migrations are excluded and active mission continuity across Core restart is outside scope |
| D10 | External libraries and tools | Keep useful current dependencies; prefer existing standard APIs when behavior stays clear | Candidate replacements in the six subsystem reports | Demonstrated reduction in maintained behavior or operational cost; no replacement based only on popularity |

D2 precedes catalog, Plugin private protocol, Source Gateway process, and Plugin updater decisions. D3 affects how much existing integration code must be ported. D4 and D5 must agree on transaction and cursor guarantees. D6 should follow at least one real workflow so the team does not build another broad schema framework around an empty production Command catalog.

## Minimum experiment set

These are proposed experiments to run after selecting scope, not work executed during the review.

### E1. A removable mission extension

Use a specialized signal-report processor in its own repository. Connect through the smallest Atlas interface that provides its inputs, execution control and result publication. Compare an explicitly configured external program or container with only the management behavior the workflow actually needs.

Pass when it can be built, attached, invoked, stopped, removed and archived without editing Core's source or normal dependency graph. Core must run with the extension absent; results and provenance remain readable if it is removed during the same run; Reset wipes them; planned stops/updates cease admission and ingestion before finite work finishes or is canceled, with explicit force stop for uncooperative shutdown. Use an operator-issued Asset scan Task to produce an input Object, then invoke a separate Plugin Operation on it; do not add a Command to represent Plugin processing. Check that its specialized format stays in the extension contract. The [removal test](11-mission-extensions.md) gives the full criteria.

### E2. One real Task, not only fixture tasking

Pick the first actual Asset and Command. Define what successful completion means, what cancellation can guarantee, and what remains unknown after losing contact. Exercise duplicate delivery, out-of-order reports, old runtime replies after replacement and an Asset restart while Core stays running. Whole-Core mission recovery is outside scope.

Pass when no stale runtime can change the new runtime's work, repeated requests do not create unintended execution, and transport acknowledgement cannot be mistaken for task completion. If the current immediate/queued policy does not fit the Asset, revise that policy explicitly. Do not copy the fixed immediate-start window without confirming the field workflow.

### E3. Runtime storage and lifecycle comparison

The confirmed planning workload is roughly 20 Assets, one or two operators, and potentially 100–200 locally observed aircraft Tracks from ADS-B. Thousands of aircraft are a future scale to evaluate rather than a promised initial capacity. Report frequency, burst rates and Object size distribution still need definition; runs last a few hours. Large uploads must resume after same-run connection loss.

Measure the PostgreSQL baseline, then change one axis at a time. Compare a local content directory before assuming SQLite is necessary; compare SQLite if a single-process server and measured workload make it credible. A single database containing bounded content is a separate candidate if it fits real sizes. Keep alternatives in throwaway branches and select one production design rather than shipping several profiles prematurely.

Pass when Stop/Start and Restart preserve operational data/logs, Reset clears them while preserving setup and artifacts, rollback publishes no mutation and interrupted uploads cannot expose unusable Objects. Record p50/p95/p99 request latency, sustained write rate, lock waits, per-run storage growth and startup and Reset duration. Set the acceptance thresholds from the product workload before ranking candidates.

### E4. Narrow client versus local replica

Use a browser view and a field client against the same server. Compare plain typed requests plus a change notification/refetch path with the current replica contract. Pick an explicit freshness promise for each consumer.

Pass when each candidate meets its stated promise under a disconnect, expired replay cursor, concurrent snapshot/write, delete followed by an older response, and a slow consumer. Report the custom client states removed and extra network traffic incurred. A simpler client may offer weaker offline behavior; state that deliberately.

### E5. Contract generator slice

Choose one Entity report, one nullable/optional patch, one Task transition, and one source operation envelope. Generate the required Go and TypeScript contracts with each serious candidate. Use the existing conformance examples as starting evidence, not a requirement to regenerate the whole monorepo.

Pass when invalid input is rejected consistently, generated artifacts are repeatable, internal database changes do not leak onto the wire, and an unrelated documentation edit does not force a false compatibility mismatch. Record handwritten exceptions and build dependencies. Do not migrate the full schema to answer this question.

## Existing decisions most worth reopening

The detailed notes link the exact source decisions. This is their order of product impact:

1. Plugins run as configured containers over private HTTP and release through a signed catalog. Keep temporary capabilities external; reevaluate which parts of the old management platform their lifecycle requires.
2. Every client may hydrate a complete local dataset and maintain a recovery-capable replica. Reopen because clients may need different levels of consistency.
3. Metadata and bytes always require PostgreSQL plus MinIO. Reopen because the first deployment is one server and Object requirements are not yet fixed.
4. Exact Protocol revision equality includes the current authored representation. Compatible client versions are now accepted; define compatibility checks and supported upgrade overlap alongside generation ownership.
5. Core ownership of Asset Commands is now accepted. Prove the first actual Asset tasking need; keep Plugin Operations and specialized processing out of the Command catalog.
6. The source omits operator identity from Task creation and cancellation records. The successor requires actor-attributed activity history retained across Stop/Start and Restart, then cleared on Reset. Design attribution to follow that lifecycle.
7. The deployment manager supports a broad set of recovery and independent-update states. Reopen the supported operator product before copying the manager.

Small swaps such as zerolog to slog, npm to pnpm, or chi to the standard router come after these choices. They can remove dependencies, but they do not remove an unnecessary release system or replica contract.

## How this fits the existing skills

- Research stays in this folder. Each report separates source observations, recommendations, alternative costs and unknowns.
- `CONTEXT.md` stays a glossary. It does not hold the proposed stack or implementation plan.
- Once a hard-to-reverse tradeoff is accepted, record the decision in `docs/adr/` and link its research evidence. No accepted ADR is created merely because a researcher prefers an option.
- Once an experiment or implementation slice is requested, publish its specification as a GitHub issue under the repository's issue convention. Include behavior, acceptance conditions and the selected scope; do not turn every research question into a ticket automatically.
- Source `docs/problems/` reports are investigation leads. This architecture review does not reproduce or inherit them as confirmed runtime defects.
