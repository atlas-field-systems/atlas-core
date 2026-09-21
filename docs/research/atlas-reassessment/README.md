# Atlas architecture and technology reassessment

Research date: 20 September 2026. Timestamp: 2026-09-20T15:35:31-04:00. This folder retains the source investigation, alternatives and proposed experiments; it is not the current implementation plan.

## Status and authority

Reports combine observations of the pinned Modernization revision with successor proposals and later research corrections. Their recommendations, experiment gates and “open” questions reflect that investigation; some have since been settled. An accepted direction does not establish that a proposed tool or experiment has been selected or validated.

For current planning, read the [operating model](../../architecture/operating-model.md), [responsibility map](../../architecture/system-outline.md) and [system design](../../architecture/system-design.md). The [documentation guide](../../agents/domain.md) defines ownership. Use these decision pointers when a report touches:

| Subject | Successor authority |
| --- | --- |
| Selected stack and generation tools | [ADR-0016](../../adr/0016-use-go-sqlite-and-openapi-tooling.md) |
| Docker deployment and Plugin containers | [ADR-0017](../../adr/0017-deploy-core-and-plugins-as-docker-containers.md) |
| Runtime retention, Reset, updates and mission continuity | [ADR-0015](../../adr/0015-separate-start-stop-restart-and-reset.md) |
| Plugin ownership and Operations | [ADR-0002](../../adr/0002-core-manages-installed-plugins.md), [stopping and faults](../../adr/0006-protect-active-plugin-work-during-lifecycle-changes.md), [local administration](../../architecture/system-design.md#local-administration) |
| Commands, tasking and results | [ADR-0004](../../adr/0004-core-owns-commands-and-assets-execute-tasks.md), [reconciliation](../../adr/0007-reconcile-asset-tasks-after-disconnection.md), [scan completion](../../adr/0008-complete-scan-tasks-when-required-results-are-available.md), [Object visibility](../../adr/0009-expose-objects-only-when-ready.md) |
| Releases and client compatibility | [ADR-0001](../../adr/0001-release-core-sdk-and-protocol-together.md), [ADR-0005](../../adr/0005-allow-compatible-client-versions.md) |
| Generation and architecture | [ADR-0011](../../adr/0011-generate-shared-contracts-with-minimal-customization.md), [ADR-0014](../../adr/0014-build-dedicated-atlas-systems.md) |
| SDK, access, storage privacy and publication ownership | [System design](../../architecture/system-design.md) |

Accepted successor decisions govern over research alternatives. Keep source observations pinned and correct factual errors where found; avoid copying new policy into every report. The [comparison register](../../architecture/modernization-differences.md) records confirmed differences. Requested implementation and experiment specifications belong in [GitHub Issues](../../agents/issue-tracker.md).

## Research navigation

- [System map](01-system-map.md): inspected features and flows.
- [System options](08-system-options.md): alternative successor shapes.
- [Decision and experiment backlog](09-decision-backlog.md): research proposals to reassess against accepted decisions before scheduling work.
- [Mission extensions](11-mission-extensions.md): the original removable-extension motivation and design proposals, followed by the accepted Plugin decisions above.
- [Adversarial generation review](12-protocol-generation-adversarial-review.md): arguments, counterarguments and an unexecuted comparison for Protocol generation.

| Area | Report | Main question |
| --- | --- | --- |
| Storage | [Storage](02-storage.md) | Do the metadata/content requirements justify PostgreSQL plus a separate object service? |
| Core runtime and access | [Core runtime](03-core-runtime.md) | Which server responsibilities and libraries simplify the one-server system? |
| Shared contracts | [Protocol](04-protocol.md) | How much schema, generation and compatibility machinery does the retained product need? |
| External clients | [SDK](05-sdk.md) | Which consumers need a complete replica, and which need a typed request client? |
| Integrations | [Plugins](06-plugins.md) | Which capabilities need independent processes or releases rather than ordinary internal modules? |
| Installation and releases | [Deployment and tooling](07-deployment-tooling.md) | What can one supported operator path replace? |
| Dependency coverage | [Technology ledger](10-technology-coverage.md) and [JSON inventory](dependency-inventory.json) | What was examined, at what version, and what remains indirect or out of scope? |

## Research synthesis

**Keep permanent modules and temporary extensions distinct.** Use ordinary internal calls for Core-owned capabilities. Use a narrow external contract for mission-specific code in separate repositories. A temporary processor remains an extension even when it publishes current-run Atlas data. Independent ownership and removal now justify that separation; they do not automatically justify the old catalog or installer.

**Use Go as the comparison baseline, not an unquestioned requirement.** Existing transaction and Task behavior is substantial reusable work. A TypeScript server deserves a representative slice comparison if language consolidation would make retained integrations easier. Rewriting a router endpoint proves very little; compare cancellation, auth, transaction behavior and Task recovery too.

**Keep storage alternatives open until the workload is named.** PostgreSQL is the known implementation. Compare local content storage before carrying MinIO and its lifecycle into the new deployment. SQLite is a credible one-process experiment, not a drop-in driver replacement. All operational stores and Atlas-managed logs must clear together on Reset; ordinary startup preserves them. Within-run consistency still matters; metadata and bytes do not become one transaction merely by using a local directory. Select one production design after the experiments rather than supporting several speculative profiles.

**Make client synchronization an explicit capability.** The existing SDK already has no external runtime dependencies. Its complexity is largely its own recovery protocol. Preserve a small typed client and offer synchronization only where a consumer needs it. Query invalidation or refetching can be simpler, but only with an explicit freshness contract.

**Reduce contract ownership work before choosing a new schema tool.** Retain language-neutral external contracts and validation. Reassess the combination of JSON Schema, authored Go types, generated validators, raw revision checks and private Plugin protocols. OpenAPI, TypeSpec or Protobuf should win a concrete slice comparison before becoming another source of truth.

**Prove one real Command before importing the entire Task framework.** The inspected production Command catalog is intentionally empty. Tests use fixture Commands. Assigned-Asset reporting, honest outcomes, the confirmed-cancellation boundary and actor-attributed activity history are accepted requirements. Exact mechanisms follow from the first real Asset. Scheduling belongs to the Asset OS, the old immediate-start deadline is excluded, and mission recovery across Core restart is outside scope.

**Choose one deployment product.** The current repository supports a Python launcher and a packaged Node/Ink manager, with overlapping production responsibilities. Decide what installation, update and recovery experience the new Core actually needs before carrying both paths and Plugin recovery machinery forward.

**Treat smaller library changes as follow-up choices.** Standard Go routing/logging, package-manager changes, and test-runner choices matter less than the preceding decisions. Useful dependencies should stay when replacing them would mean owning more behavior. The subsystem reports record individual dispositions and alternatives.

### Disagreements and conditions

The storage assessment gives SQLite a serious place in the comparison because the existing versioned write path is already serialized. The runtime assessment favors retaining Go because its transaction, cancellation and execution behavior would otherwise need to be ported. Neither claim determines the other choice. Go can use either database, and a modular architecture does not settle storage.

The Plugin and deployment assessments explain why the old distributed extension design has useful safety checks. That does not make it necessary for built-in capabilities. The relevant comparison includes both removed machinery and lost independent-release or process-isolation benefits.

The main synthesis favors a Go modular server as the starting hypothesis and a small set of experiments before choosing storage and client semantics. These are recommendations, not accepted ADRs. No benchmark results support a claim that a proposed alternative is faster or cheaper yet.

## Evidence baseline

The local source repository is `/Users/lanearaujo/Documents/coding/Atlas Modernization`. Its checked-out `main` was `b6e622a9e21796a94ac517f0329a491bfc03a5ce`, one commit ahead and 306 behind its remote-tracking branch, with untracked legacy directories. Reviewing only that working folder would have omitted later changes.

A read-only `git ls-remote origin refs/heads/main` confirmed GitHub `main` at:

[`8edee4e2743fbf0f85c16dfe638d9222141cf279`](https://github.com/the-Drunken-coder/Atlas-Modernization/tree/8edee4e2743fbf0f85c16dfe638d9222141cf279), committed 18 September 2026, `refactor: consolidate duplicated Atlas helpers (#450)`.

The locally available commit was exported with `git archive` into `/private/tmp/atlas-core-reassessment-20260920`. Researchers read that fixed snapshot. They did not reset, switch, clean, or edit the original repository. Unmerged branches, untracked legacy directories, installed outputs, active deployments and physical device state are outside this baseline.

The destination began at `fc7d337976ea46e20e11468489f245e5a0f87498` with agent documentation and an empty README. Only documentation and the research inventory were added or edited.

## Review method and limits

Six Luna agents at extra-high reasoning researched storage, runtime, Protocol, SDK, Plugins and deployment. The coordinating agent mapped the system, extracted the dependency inventory and reconciled the findings. A Terra agent at medium reasoning independently challenged the synthesis. Findings were revised to preserve source-access controls, distinguish ingestion from queries, and keep future field-client version rollout policy explicit.

Evidence includes local source, tests as documentation of contracts, existing design decisions, and current official external documentation linked in each report. Old `docs/problems/` files were leads, not automatically accepted defect findings. A temporary archive without `.git` is expected; its identity was established by the coordinator before delegation.

This was primarily a static architecture and technology review. The Protocol researcher additionally ran `go test ./...` and `go run ./tools/check` successfully in the fixed Protocol snapshot. No full application build, acceptance suite, live-server test, radio test, security scan, load benchmark or restore drill was run. Other existing tests were read as evidence of intended contracts, not established as passing. Proposed performance, operational and reliability gains remain hypotheses until the listed experiments run.

The dependency review covers direct technologies in the requested areas and the supporting deployment/build tools. Indirect Go requirements and all 425 npm lock entries from the broader source monorepo are recorded; each transitive package was not separately compared with competitors. UI, simulations and Meshtastic internals were inspected as adjacent consumers, not independently redesigned.

Protocol verification ran in `/private/tmp/atlas-core-reassessment-20260920/packages/protocol` with `GOCACHE=/private/tmp/atlas-protocol-go-cache`. Both commands exited 0. The artifact check reported that Protocol examples, Go contracts, and generated artifacts are current.

Local documentation links, source file paths and source line-anchor ranges were checked against the snapshot. The inventory parses as JSON. Whitespace checks include the new untracked files as well as the tracked README. External web links were used during research but were not all rechecked as a separate link audit.
