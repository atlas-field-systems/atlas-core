# A simpler Core system

Current lifecycle contract: [ADR-0015](../../adr/0015-separate-start-stop-restart-and-reset.md) supersedes wipe-on-start. Start, Stop and Restart retain operational data and logs; Reset clears them while keeping setup and installed artifacts. Core stays running throughout field missions; Restart and Reset are primarily development actions outside missions. Mission execution continuity across Core restart is outside scope. Updates to a new Core release perform Reset; operational-data migrations are excluded. Backup and restore functionality is excluded. Source observations below describe the inspected historical implementation; successor recommendations remain provisional unless backed by an accepted decision.


Successor decision update: [Core owns Commands and Assets execute Tasks](../../adr/0004-core-owns-commands-and-assets-execute-tasks.md). Plugins expose Operations, process data or ingest external sources; they cannot introduce Asset Commands or be taskable Tool Assets. [Planned stops and updates protect active Plugin work](../../adr/0006-protect-active-plugin-work-during-lifecycle-changes.md). Source descriptions below remain historical evidence; conflicting research proposals are superseded.

Planning update: [ADR-0001](../../adr/0001-release-core-sdk-and-protocol-together.md) accepts one release workflow and matching Core, SDK and Protocol versions, including unchanged components. [Compatible client versions are now accepted](../../adr/0005-allow-compatible-client-versions.md); each release documents a supported client-version range and rejects unsupported clients; exact ranges and checks remain implementation choices. The [system outline](../../architecture/system-outline.md) is the current planning entry point; module and subsystem assignments in these research notes remain proposals. Permanent Plugins and combined backend/UI extensions are also under consideration, so lifetime alone does not determine placement.

Research date: 2026-09-20
Research timestamp: 2026-09-20T15:35:31-04:00

Status: proposal for discussion. No stack, feature removal, or module layout in this note has been accepted.

## Confirmed planning constraints

On 20 September 2026 the user clarified:

- Breaking changes are acceptable when they simplify the system.
- The first deployment is one server with field devices connecting to it.
- Temporary capabilities for one flight, test, or specialized system need separate repositories and a removable extension mechanism. Permanent capabilities can still be Core modules.

The user clarified the purpose of Plugins after the initial comparison. [Temporary mission extensions](11-mission-extensions.md) records that requirement. The design now needs both permanent modules and optional extensions; it need not inherit the full managed Plugin platform.

One server does not imply continuous connectivity. Field clients still need a clear policy for disconnects, stale observations, repeated delivery, and work whose outcome is unknown. It does mean we should not import clustering, distributed configuration, or multiple independent release managers without a demonstrated need.

## Recommended starting hypothesis

Use a modular monolith for the server. Give it a small number of modules with explicit ownership, ordinary function calls internally, one composition root, and one coordinated server release. Keep the external Protocol and SDK at the edges where another program actually connects.

This recommendation concerns structure first. Go and TypeScript are competing implementation choices for that structure. A system implemented in Go can still have a TypeScript client SDK; that does not require server modules to call each other through HTTP.

Proposed ownership, to test against the first workflows:

| Module | Owns | Small external interface | What callers should not have to know |
| --- | --- | --- | --- |
| Operational picture | Entity identity, current observations, optional movement history | Report observation, read/query Entity, import/inspect history | JSONB layout, clock locks, history indexes |
| Tasking | Commands, Task state transitions, runtime identity and delivery | Request work, register ready runtime, signal delivery and reconcile runtime-scoped work, report outcome, cancel | Row locks, fencing, queue bookkeeping |
| Content | Object metadata and bytes | Store, read, reference, delete content | Upload intents, physical paths, cleanup retries |
| Integrations | Source-specific queries and ingestion | Invoke a Plugin Operation or manage ingestion; publish through the SDK | Upstream credentials, parsing, provider-specific retry behavior |
| Access | Operator and machine identity and authorization | Authenticate and authorize named actions | Cookie/session storage, key hashes, throttle records |
| Synchronization | Published changes and recovery | Snapshot, resume after cursor, receive updates | Database notification mechanics, retained log cleanup |

Plugin Operations may publish observations and continue after the caller disconnects. Use their accepted attempt identity, queryable outcome and explicit cancellation for invoked processing. Periodic or continuous ingestion follows the managed Plugin lifecycle. Keep Asset Tasks separate; ingestion does not make a Plugin taskable or require automatic retries.

These are responsibility proposals, not six required packages or independently deployable services. If the first workflow does not use content or history, it should not force those modules into the first runnable slice. Internal implementation can stay small until real callers make separation useful.

A source-specific integration can be a subsystem inside Integrations. It should call the Operational picture or Tasking interface for domain mutations. It should not write their tables directly. Sharing a process does not justify sharing every implementation detail.

Breaking the old contracts during extraction does not settle future device rollout policy. Before deploying the first field client, decide whether client upgrades can lag the server, how supported versions are identified, and what an incompatible client does. One server release is not one simultaneous release across every deployed device.

## Compare three concrete shapes

| Question | A. Go server with internal modules | B. TypeScript server with internal modules | C. Core plus managed external Plugins |
| --- | --- | --- | --- |
| Server runtime | Go | Node | Go Core plus Node Plugin runtimes in the source design |
| Integration calls | In-process interfaces by default | In-process interfaces by default | Private HTTP and public SDK |
| Release unit | One server release | One server release | Core release plus separately managed Plugin releases |
| Existing code reuse | Core domain behavior and Go storage integration | SDK and TypeScript integration logic; server behavior must be ported | Most existing architecture and lifecycle code |
| Main simplification | Remove extension packaging and duplicated configuration while retaining mature Core behavior | Consolidate server and integration language and contract tooling | Smaller initial rewrite, but much of the operational complexity remains |
| Main cost | Port retained TypeScript integrations or run selected workers separately | Reprove transaction, concurrency, auth, and recovery behavior during the port | Keep catalog trust, compatibility, manager journals, discovery, health, and version coordination |
| Failure isolation | Internal calls share process fate; a bounded worker can be added for a demonstrated problem | Same process-fate concern; long CPU work needs explicit handling | Separate processes isolate crashes but do not provide data authorization by themselves |
| Use when | Existing Go behavior is worth retaining and built-in capabilities cover the product | A representative slice proves the language consolidation pays for the port | Independent installs/releases, incompatible runtimes, or process isolation are actual product requirements |

A remains the server implementation baseline and B deserves a bounded comparison. Both need a small optional extension path for the clarified mission use case. C represents the old full managed platform; its catalog, installer and recovery machinery still need separate justification. These choices are no longer alternatives between all internal modules and all external Plugins. See [Core runtime](03-core-runtime.md), [Plugins](06-plugins.md), and [deployment](07-deployment-tooling.md) for source-backed technology details and alternatives.

## Which Plugin machinery can be reduced

For capabilities selected as permanent built-ins, potential deletions include runtime manifest discovery for query-only integrations, private Core-to-Plugin HTTP envelopes, Plugin endpoint fragments, per-Plugin container templates, private protocol-major negotiation, a signed install catalog, Plugin rollback journals, and some health-state plumbing.

Temporary mission extensions remain external under the clarified requirement. Assess their minimum invocation, lifecycle and configuration needs separately from the full old platform.

Each deletion is conditional. Choosing built-in integrations gives up independently installable releases and moves failures into the server's process. A data-source outage still needs bounded timeouts, cancellation, concurrency limits, and a clear error. Source credentials still need explicit ownership and redaction. Internal modules cannot be described as a sandbox.

A retained source client also needs the source-specific subset of origin validation, header protection, bounded requests and responses, admission, retries and rate controls. Removing the Gateway process does not remove those requirements. Avoid rebuilding a universal Gateway inside the server when a narrow source client is sufficient.

The Source Gateway decision should split into two questions. Who owns access credentials? Where does that code execute? A credential-owning source client can remain useful even when a separate Gateway container and HTTP protocol are unnecessary. A worker process can remain useful even when a Plugin marketplace and installer are unnecessary.

Evidence and old decision conflicts are detailed in [the Plugin assessment](06-plugins.md). Reopening those decisions does not require adopting an all-or-nothing extension framework.

## Keep the domain distinctions that still earn their cost

A Command defines behavior an Asset supports; a Task requests its execution by that Asset. A Plugin Operation is a separate invocation with a Core-owned identifier, queryable state and outcome, and explicit cancellation. It may perform long processing and continue after caller disconnection. Long Plugin work remains an Operation and does not require a Tool Asset. See [the accepted lifecycle](../../architecture/system-design.md#plugin-operations).

Likewise, a current Entity view, retained movement history, content bytes, and a recoverable change feed have different retention and consistency needs. Organizing them as modules should make those differences explicit rather than force one universal resource abstraction over all of them.

The source's empty production Command catalog makes the first real Command a better test of these interfaces than another generalized framework. Source evidence and the relevant flows are in [the system map](01-system-map.md).

## Where the next decision should come from

Build no production architecture from a diagram alone. Compare candidates with the same small product slice:

1. A field client reports an observation; a browser reads it and receives a subsequent change.
2. A real source integration answers a bounded query, fails cleanly, and can be cancelled.
3. One real Command reaches one Asset runtime; same-run disconnection and reconnect preserve current instructions and reconcile reports; completion and cancellation have defined outcomes. Core remains running throughout the scenario.
4. Run a temporary processor from a separate repository, remove it, and prove Core and retained results remain usable without that repository or its dependencies.
5. Verify that Stop/Start and Restart preserve operational metadata, content, history and logs. Then Reset and verify they are cleared while installation setup and Plugin artifacts survive. Backup and restore functionality is excluded; mission execution continuity across Core restart is outside scope.

Measure setup steps, required processes, configuration and secrets, independently maintained contracts, custom recovery states, and code a feature author must touch. Also measure latency and throughput against a declared workload. Do not choose the shorter implementation if it quietly stops handling deletion races or uncertain Task outcomes.

Use the same fixtures and behavioral assertions for Go and TypeScript candidates. The test is whether language consolidation removes enough actual work to justify replacing the server, not whether one HTTP endpoint takes fewer lines.
