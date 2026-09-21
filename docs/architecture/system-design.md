# Dedicated Atlas systems and shared contracts

Status: accepted direction. [ADR-0014](../adr/0014-build-dedicated-atlas-systems.md) supersedes the infrastructure-first plan. [ADR-0011](../adr/0011-generate-shared-contracts-with-minimal-customization.md) retains the generation policy. No language, database, generator or runtime implementation is selected here.

The [Modernization comparison](modernization-differences.md) records each confirmed difference, with old-source evidence and the successor decision.

## Architecture

Build the dedicated responsibilities in the [Core system outline](system-outline.md): Entities, Tasks, Objects, Plugins, Identity and access, Synchronization, and System operations. Organize their implementations around the Atlas behavior they own. These responsibilities do not imply separate services, processes or databases.

Atlas still needs infrastructure for storage connections, transactions, API serving, configuration and logging. Share concrete utilities where the implemented workflows benefit. A reusable infrastructure platform, universal module lifecycle and routine module replacement are not objectives. Abstractions must simplify actual Atlas work; do not build a separate framework in anticipation of rebuilding the application on it.

Each module owns its behavior and private data access. Collaborating modules call explicit interfaces rather than reaching into each other's tables. Keep transactions that span those interfaces explicit and practical. Ordinary code interfaces are sufficient; internal calls do not need network requests, serialization or Plugin machinery.

Protocol defines shared external resources, operations, messages, errors and observable guarantees. Core implements those guarantees, and SDK exposes them to consumers. Protocol is not the private database schema or a specification of every internal function. Public wire types can be used directly where they fit; a small explicit conversion is appropriate where internal meaning differs.

## SDK as the supported entry point

All external applications, Assets and Plugins are expected to use the SDK to interact with Core. A health-check client, Command Interface and data-processing Plugin use the same supported SDK, with behavior appropriate to their needs.

Provide basic API access without starting a synchronized replica. Applications that need a maintained shared picture opt into synchronization and caching through the SDK. An application's role does not select its mode automatically. The SDK should make both uses clear without duplicating endpoint definitions or requiring a second client library outside it. The exact configuration and API shape remain to be designed.

Core remains responsible for authentication and validation at its API boundary. The SDK is the supported client entry point, not a substitute for those server responsibilities.

## Identity and access

All authenticated operators have full control. Core uses fixed caller boundaries, without operator roles or configurable per-Plugin data permissions:

- Each Asset has its own authenticated identity. Asset credentials cannot act as another Asset or administer Core. Core checks that an execution report comes from the Asset assigned to the Task; a claimed Asset ID in a request is not sufficient. Apply this check on every path that can record Asset execution, including any generic resource mutation path.
- Plugins use ordinary SDK operational APIs across sources, including creating and canceling Tasks with existing Commands. They cannot impersonate an Asset's execution reports. Plugin credentials cannot manage Atlas credentials, change Core configuration, control Core lifecycle, or install/manage Plugins. Those administrative actions require authenticated operator authority.
- SDK method availability does not grant permission. Core enforces authorization at the API boundary. Keep enrollment simple; credential formats, setup mechanics and route bindings remain implementation choices.

Plugins are trusted code with broad operational access, not isolated tenants. These API rules do not promise host-process sandboxing. A trusted Plugin may receive provider credentials for its own integration. A credential broker or Source Gateway is optional; Atlas does not promise that provider secrets are always hidden from Plugins. Datastream delivery is not a selected successor capability.

## Objects hide storage

Clients identify Objects and access their content through Core APIs exposed by the SDK. Physical buckets, filesystem paths and storage-provider details stay inside the Objects implementation. They are not public Object fields or Plugin integration requirements.

Objects become visible only when their required content is usable. Storage may change without changing that client promise. Stop/Start and Restart retain metadata, content and logs; Reset clears operational state and logs while preserving installation setup. Large uploads must resume from confirmed progress after a client reconnects within the same Core run, without retransmitting the entire Object. Partial uploads remain private until ready, and Reset wipes transfer state. Ordinary Stop/Start and Restart preserve stored transfer state; reattaching an active transfer across a Core restart is outside scope. Neither the storage backend nor the resumable transfer mechanism is selected by this decision.

## Core tasking and Asset execution

Core owns Command definitions, validation of tasking requests, recorded operator instructions, Task lifecycle records and reconciliation of Asset reports. It preserves the seven agreed Task statuses and required-result completion rules. Cancellation remains requested until a final outcome is confirmed; completion with required results is allowed before confirmed Canceled, and confirmed Canceled never becomes Completed. The [reconciliation decision](../adr/0007-reconcile-asset-tasks-after-disconnection.md) defines that boundary.

The Asset operating system owns scheduling, queue order, execution, interruption and connected/offline behavior. Do not carry the old immediate-start deadline, server-selected execution order or live execution-readiness gate into Task creation merely because Modernization has them. Issuing a valid Task to a disconnected Asset must remain possible. Core validates the target, supported Commands and reporting Asset without claiming the Asset is ready to execute now. Registration/fencing machinery from Modernization is not a required subsystem; reject unauthorized, duplicate or obsolete reports through the smallest contract that enforces these guarantees.

Document this ownership in the tasking contract. Any new Core rule must support a Core-owned guarantee rather than prescribe Asset scheduling. Task check-in communicates current instructions and reported outcomes; it is not a generic workflow or patch language.

## Plugin Operations

Core owns accepted Plugin Operation attempts and retains their records until Reset. Acceptance returns an identifier through which the caller can retrieve state and outcome and request cancellation. Closing or disconnecting the initiating client does not cancel the work. The SDK preserves submission identity across retries so a lost acceptance response returns the original Operation; an explicit rerun creates a new attempt. Exact wire fields remain implementation design work. See [Operation submission and effects](../adr/0002-core-manages-installed-plugins.md).

Use this lifecycle for long processing without requiring the caller to keep an HTTP request open. Do not inherit Modernization's request-bound 25-second limit as a universal Operation limit. Plugins remain separate from taskable Assets and do not acquire Asset Commands or Tool Asset identities. They may initiate Tasks for Assets using existing Core-defined Commands through the SDK; no per-invocation operator approval is required.

A fault is reported for manual attention. Restarting a Plugin does not rerun a failed Operation; rerun is explicit. Known effects survive failure and are associated with the Operation; deliberate reruns may produce additional results. Planned stops cease admission and ingestion before finite work finishes or is canceled; an uncooperative Plugin can be explicitly force-stopped. See [Plugin stopping](../adr/0006-protect-active-plugin-work-during-lifecycle-changes.md). Core Stop/Start and Restart preserve Operation records; Reset wipes them along with other operational data and logs. Execution continuity across a whole-Core restart is outside scope. This requires no automatic recovery platform. Internal modules use Plugin packaging only when the capability needs that independently managed extension lifecycle.

Installed Plugins are trusted user-built extensions with access to operational data, including data created by other sources. Do not introduce per-Plugin data grants or an operator-only gate on Task creation. The [fixed access boundaries](#identity-and-access) reserve administration for operators and execution reports for the assigned Asset. Normal Core validation and within-run consistency rules still apply to Plugin requests.

## Change publication

The module making a change supplies its public representation. This ownership rule is accepted. Shared publication code records and delivers that representation in an order consistent with committed state. For example, Tasks describes a Task status change; delivery code does not inspect private Task tables to reconstruct its meaning.

This keeps a useful shared delivery function small. It does not establish a general event bus or require every internal call to emit an event. Preserve consistency between resource changes and their published records within the current run.

## Generation and testing

Generate repeated contract representations with supported tooling and a small configuration. Keep generated files disposable and business behavior in separate handwritten files. Avoid output patches, endpoint-specific templates and wrapper APIs that repeat generated operations. A narrow handwritten binding is preferable when generation requires disproportionate customization. Count reusable generator extensions as maintained code and justify them by the independent work they remove.

Use a pinned toolchain and deterministic regeneration. Test independently authored wire examples, public behavior, supported compatibility and real API/storage integration. Generated snapshots are not the sole oracle. Focus coverage on the actual promises: offline Task reconciliation within one run, ready-only Objects with resumable same-run uploads, Plugin-initiated Asset Tasks, Plugin Operations surviving caller disconnection, Stop/Start and Restart retention plus Reset cleanup with retained setup, basic SDK access without full-picture synchronization, assigned-Asset report checks, allowed Plugin Task issuance and denied Plugin administration.

The [lifecycle decision](../adr/0015-separate-start-stop-restart-and-reset.md) separates retained state from execution resumption. Test that Start, Stop and Restart retain data/logs and that Reset removes them while preserving setup. The field workflow is setup, Asset connection and a mission with Core continuously available. Restart and Reset are primarily development actions outside missions. Active-work recovery across a whole-Core restart is outside scope. Updating Core to a new release performs Reset, clearing operational data and logs while preserving installation setup and Plugin artifacts. Operational-data migrations are excluded; backup and restore functionality is excluded.

The first runnable workflow is one Asset Task producing one ready Object followed by one Plugin Operation. Add lost-response, cancellation and Plugin-stop cases as those behaviors are implemented. This tests the accepted contracts without making every failure scenario a prerequisite to starting implementation.

Reset safety uses a dataset identifier retained across Restart and changed on Reset. SDK consumers discard their old picture and pending submissions when it changes; Core rejects requests associated with obsolete dataset state. See [lifecycle](../adr/0015-separate-start-stop-restart-and-reset.md). Release startup validates retained configuration and Plugin compatibility, reports invalid configuration, and leaves incompatible Plugins installed but disabled. Supported client-version ranges and rejection behavior follow [compatibility](../adr/0005-allow-compatible-client-versions.md).
