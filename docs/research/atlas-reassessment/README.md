# Atlas architecture and technology reassessment

Current design update: [ADR-0014](../../adr/0014-build-dedicated-atlas-systems.md) selects dedicated Atlas systems over an infrastructure-first framework. The [system design](../../architecture/system-design.md) records SDK modes, private Object storage, Asset-owned scheduling and client-independent Plugin Operations. Core starts before Assets connect and stays running throughout the mission. Restart and Reset are primarily development actions outside missions. Start, Stop and Restart retain records and logs; Reset clears them. Execution continuity across Core restart is outside scope. Earlier research proposals do not override these decisions.

Current lifecycle contract: [ADR-0015](../../adr/0015-separate-start-stop-restart-and-reset.md) supersedes wipe-on-start. Start, Stop and Restart retain operational data and logs; Reset clears them while keeping setup and installed artifacts. Core stays running throughout field missions; Restart and Reset are primarily development actions outside missions. Mission execution continuity across Core restart is outside scope. Updates to a new Core release perform Reset; operational-data migrations are excluded. Backup and restore functionality is excluded. Source observations below describe the inspected historical implementation; successor recommendations remain provisional unless backed by an accepted decision.


Successor decision update: [Core owns Commands and Assets execute Tasks](../../adr/0004-core-owns-commands-and-assets-execute-tasks.md). Plugins expose Operations, process data or ingest external sources; they cannot introduce Asset Commands or be taskable Tool Assets. [Planned stops and updates protect active Plugin work](../../adr/0006-protect-active-plugin-work-during-lifecycle-changes.md). Source descriptions below remain historical evidence; conflicting research proposals are superseded.

Scope clarification: the current [Core system outline](../../architecture/system-outline.md) separates the `Atlas Core/` folder from sibling Protocol and SDK deliverables, keeps Entities/Tasks/Objects as the API pillars, and excludes the Command Interface from the Core system. Earlier research groupings are background proposals, not a folder specification.

Planning update: [ADR-0001](../../adr/0001-release-core-sdk-and-protocol-together.md) accepts one release workflow and matching Core, SDK and Protocol versions, including unchanged components. [Compatible client versions are now accepted](../../adr/0005-allow-compatible-client-versions.md); each release documents a supported client-version range and rejects unsupported clients; exact ranges and checks remain implementation choices. The [system outline](../../architecture/system-outline.md) is the current planning entry point; module and subsystem assignments in these research notes remain proposals. Permanent Plugins and combined backend/UI extensions are also under consideration, so lifetime alone does not determine placement.

Research date: 20 September 2026. Status: recommendations for a simpler successor, not an approved implementation plan.

Research timestamp: 2026-09-20T15:35:31-04:00

The clarified direction is a Core system of permanent modules plus optional extensions for temporary mission capabilities. Those extensions belong in separate repositories and must be removable without adding their specialized implementation or dependencies to Core. Most of the expensive machinery comes from responsibilities Atlas chose to own: plugin distribution, deployment recovery, cross-store content consistency, schema generation, and synchronized client replicas. Replacing individual libraries is a smaller opportunity.

The maintained [differences table](../../architecture/modernization-differences.md) separates confirmed successor changes from behavior being carried forward.

## What the user has decided

- Breaking changes are acceptable when they simplify the system.
- The first deployment has one server with field devices connecting to it.
- Temporary capabilities for one flight, test, or system integration need a separate repository and removable extension mechanism. Permanent capabilities may still belong in Core modules.

The need for optional extensions is now concrete. Their execution, packaging and installation mechanism remains open; the old Plugin catalog and updater are not automatically required. See [temporary mission extensions](11-mission-extensions.md) for the clarification and the removal test.

## Start here

Read [temporary mission extensions](11-mission-extensions.md) first for the latest scope clarification.

1. [System map and feature disposition](01-system-map.md): what exists, how data flows, what is deferred, and what should be kept or reconsidered.
2. [Simpler system options](08-system-options.md): modular Go server, modular TypeScript server, and retained managed Plugins compared on the same responsibilities.
3. [Decision and experiment backlog](09-decision-backlog.md): the decisions in order, the smallest useful experiments, and what would count as evidence.

The [adversarial generation review](12-protocol-generation-adversarial-review.md) evaluates whether broader Protocol generation would reduce maintenance, including counterarguments and a comparison that could disprove the benefit.

Detailed research:

| Area | Report | Main question |
| --- | --- | --- |
| Storage | [Storage](02-storage.md) | Do the metadata/content requirements justify PostgreSQL plus a separate object service? |
| Core runtime and access | [Core runtime](03-core-runtime.md) | Which server responsibilities and libraries simplify the one-server system? |
| Shared contracts | [Protocol](04-protocol.md) | How much schema, generation and compatibility machinery does the retained product need? |
| External clients | [SDK](05-sdk.md) | Which consumers need a complete replica, and which need a typed request client? |
| Integrations | [Plugins](06-plugins.md) | Which capabilities need independent processes or releases rather than ordinary internal modules? |
| Installation and releases | [Deployment and tooling](07-deployment-tooling.md) | What can one supported operator path replace? |
| Dependency coverage | [Technology ledger](10-technology-coverage.md) and [JSON inventory](dependency-inventory.json) | What was examined, at what version, and what remains indirect or out of scope? |

## Recommendations to carry into design

**Keep permanent modules and temporary extensions distinct.** Use ordinary internal calls for Core-owned capabilities. Use a narrow external contract for mission-specific code in separate repositories. A temporary processor remains an extension even when it publishes current-run Atlas data. Independent ownership and removal now justify that separation; they do not automatically justify the old catalog or installer.

**Use Go as the comparison baseline, not an unquestioned requirement.** Existing transaction and Task behavior is substantial reusable work. A TypeScript server deserves a representative slice comparison if language consolidation would make retained integrations easier. Rewriting a router endpoint proves very little; compare cancellation, auth, transaction behavior and Task recovery too.

**Keep storage alternatives open until the workload is named.** PostgreSQL is the known implementation. Compare local content storage before carrying MinIO and its lifecycle into the new deployment. SQLite is a credible one-process experiment, not a drop-in driver replacement. All operational stores and Atlas-managed logs must clear together on Reset; ordinary startup preserves them. Within-run consistency still matters; metadata and bytes do not become one transaction merely by using a local directory. Select one production design after the experiments rather than supporting several speculative profiles.

**Make client synchronization an explicit capability.** The existing SDK already has no external runtime dependencies. Its complexity is largely its own recovery protocol. Preserve a small typed client and offer synchronization only where a consumer needs it. Query invalidation or refetching can be simpler, but only with an explicit freshness contract.

**Reduce contract ownership work before choosing a new schema tool.** Retain language-neutral external contracts and validation. Reassess the combination of JSON Schema, authored Go types, generated validators, raw revision checks and private Plugin protocols. OpenAPI, TypeSpec or Protobuf should win a concrete slice comparison before becoming another source of truth.

**Prove one real Command before importing the entire Task framework.** The inspected production Command catalog is intentionally empty. Tests use fixture Commands. Runtime fencing, honest current-run outcomes and clear cancellation are useful guarantees; the current policy around scheduling, deadlines, actor attribution and restart must earn its place through the first real Asset.

**Choose one deployment product.** The current repository supports a Python launcher and a packaged Node/Ink manager, with overlapping production responsibilities. Decide what installation, update and recovery experience the new Core actually needs before carrying both paths and Plugin recovery machinery forward.

**Treat smaller library changes as follow-up choices.** Standard Go routing/logging, package-manager changes, and test-runner choices matter less than the preceding decisions. Useful dependencies should stay when replacing them would mean owning more behavior. The subsystem reports record individual dispositions and alternatives.

## Disagreements and conditions

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

## Document use

[CONTEXT.md](../../../CONTEXT.md) contains vocabulary only. This folder holds evidence and proposals. Accepted hard-to-reverse choices should be recorded in `docs/adr/` when decided. Implementation specifications belong in GitHub Issues under [the repository convention](../../agents/issue-tracker.md). No issues, pull requests, commits, application changes, or accepted architecture decisions were created by this review.
