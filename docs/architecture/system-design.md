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

## Objects hide storage

Clients identify Objects and access their content through Core APIs exposed by the SDK. Physical buckets, filesystem paths and storage-provider details stay inside the Objects implementation. They are not public Object fields or Plugin integration requirements.

Objects become visible only when their required content is usable. Storage may change without changing that client promise. Stop/Start and Restart retain metadata, content and logs; Reset clears operational state and logs while preserving installation setup. Large uploads must resume from confirmed progress after a client reconnects within the same Core run, without retransmitting the entire Object. Partial uploads remain private until ready, and Reset wipes transfer state. Ordinary Stop/Start and Restart preserve stored transfer state; reattaching an active transfer still needs implementation design. Neither the storage backend nor the resumable transfer mechanism is selected by this decision.

## Core tasking and Asset execution

Core owns Command definitions, validation of tasking requests, recorded operator instructions, Task lifecycle records and reconciliation of Asset reports. It preserves the seven agreed Task statuses and required-result completion rules.

The Asset operating system owns scheduling, queue order, execution, interruption and connected/offline behavior. Do not carry the old immediate-start deadline, server-selected execution order or live execution-readiness gate into Task creation merely because Modernization has them. Issuing a valid Task to a disconnected Asset must remain possible. Core can validate the target and its supported Commands without claiming the Asset is ready to execute now.

Document this ownership in the tasking contract. Any new Core rule must support a Core-owned guarantee rather than prescribe Asset scheduling. Task check-in communicates current instructions and reported outcomes; it is not a generic workflow or patch language.

## Plugin Operations

Core owns accepted Plugin Operation attempts and retains their records until Reset. Acceptance returns an identifier through which the caller can retrieve state and outcome and request cancellation. Closing or disconnecting the initiating client does not cancel the work. The exact status fields and cancellation acknowledgement contract remain implementation design work.

Use this lifecycle for long processing without requiring the caller to keep an HTTP request open. Do not inherit Modernization's request-bound 25-second limit as a universal Operation limit. Plugins remain separate from taskable Assets and do not acquire Asset Commands or Tool Asset identities. They may initiate Tasks for Assets using existing Core-defined Commands through the SDK; no per-invocation operator approval is required.

A fault is reported for manual attention. Restarting a Plugin does not rerun a failed Operation; rerun is explicit. Planned stops and updates respect active-work protection. Core Stop/Start and Restart preserve Operation records; Reset wipes them along with other operational data and logs. Preservation alone does not promise automatic execution resumption. This requires no automatic recovery platform. Internal modules use Plugin packaging only when the capability needs that independently managed extension lifecycle.

Installed Plugins are trusted user-built extensions with access to operational data, including data created by other sources. Do not introduce per-Plugin data grants or an operator-only gate on Task creation. Credential management and system administration remain separate. Normal Core validation and within-run consistency rules still apply to Plugin requests.

## Change publication

Working implementation guidance, pending confirmation of the explanation: the module making a change supplies its public representation. Shared publication code records and delivers that representation in an order consistent with committed state. For example, Tasks describes a Task status change; delivery code does not inspect private Task tables to reconstruct its meaning.

This keeps a useful shared delivery function small. It does not establish a general event bus or require every internal call to emit an event. Preserve consistency between resource changes and their published records within the current run.

## Generation and testing

Generate repeated contract representations with supported tooling and a small configuration. Keep generated files disposable and business behavior in separate handwritten files. Avoid output patches, endpoint-specific templates and wrapper APIs that repeat generated operations. A narrow handwritten binding is preferable when generation requires disproportionate customization. Count reusable generator extensions as maintained code and justify them by the independent work they remove.

Use a pinned toolchain and deterministic regeneration. Test independently authored wire examples, public behavior, supported compatibility and real API/storage integration. Generated snapshots are not the sole oracle. Focus coverage on the actual promises: offline Task reconciliation within one run, ready-only Objects with resumable same-run uploads, Plugin-initiated Asset Tasks, Plugin Operations surviving caller disconnection, Stop/Start and Restart retention plus Reset cleanup with retained setup, and basic SDK access without full-picture synchronization.

The [lifecycle decision](../adr/0015-separate-start-stop-restart-and-reset.md) separates retained state from execution resumption. Test that Start, Stop and Restart retain data/logs and that Reset removes them while preserving setup. Core normally stays running during field operations; active-work handling across a whole-Core restart remains to be designed. Updating Core to a new release performs Reset, clearing operational data and logs while preserving installation setup and Plugin artifacts. Operational-data migrations are excluded; backup and restore functionality is excluded.
