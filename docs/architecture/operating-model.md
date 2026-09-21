# What Atlas is for

Atlas is primarily for one operator, with any additional operators equally trusted to observe Entities, task Assets and use Plugins to process operational data or gather external information. The shared operational picture is for direct use by those operators. Atlas does not require a separate review-and-publish layer for Plugin detections.

Expected use is local Asset coordination for a few hours at a time, rather than continuous coordination over months. Data belongs only to the current run. Restarting Core wipes it; updates and later operating sessions carry no operational data forward. “Session” describes the expected usage here, not a new mission or session resource in the API.

## Expected workload

A busy run has roughly 20 Assets and one or two operators. An ADS-B integration may add 100–200 locally observed aircraft as Tracks, potentially more. Thousands of aircraft are a possible future scale to evaluate, not a promised first-version capacity or a requirement for a worldwide deployment. Reporting frequency, burst rates and Object sizes remain unspecified; resource counts alone do not establish throughput or storage needs.

## Design preference

Prefer lower complexity when additional behavior is not needed for the operating workflows. An interesting capability alone does not justify extra states, configuration or operator steps. The decision to expose Objects only when ready is one concrete application of this preference. Build dedicated Atlas systems with shared utilities where they simplify concrete workflows. A reusable infrastructure framework is no longer an objective. Protocol generation should reduce independent upkeep with minimal customization, backed by substantial independent contract and integration testing. See the [system design](system-design.md) for ownership rules and supported SDK usage modes.

## Scope of this design

This work designs Core together with its closely linked SDK and Protocol. Existing folder and release boundaries still apply. Command Interface layout and interaction design are outside this interview; consumer requirements are recorded only where they establish Core, SDK or Protocol behavior. Individual Plugin algorithms, processing workflows and choices about whether to produce separate results are also outside scope. Core defines the shared resource APIs and their guarantees; a Plugin chooses how to use them. The example of a separate processing result does not establish a universal Object immutability, replacement or version-history policy. The operating system on an Asset owns scheduling, execution, interruption and behavior while connected or disconnected. Core provides the tasking and synchronization contracts, records operator intent and reconciles Asset reports; it does not prescribe the Asset operating system’s queue policy. All external consumers are expected to use the SDK, with basic API access or maintained shared-picture synchronization chosen by the application.

## Operator access

Every authenticated operator has full control. The first version does not implement operator roles, view-only accounts or per-operator permission tiers. Core retains caller identity for activity history; identifying an operator does not imply different levels of authority. Authentication and device/Plugin identity remain Core responsibilities, with their contracts exposed through Protocol and SDK. Installed Plugins are trusted extensions built by the user and may access operational data across sources, including issuing Asset Tasks through the SDK. There is no per-Plugin data-permission system in the first version. Credential management and system administration remain separate from operational access. Device authority remains a separate design question.

## Where work happens

Atlas Core runs on a server throughout an operating session, independently of connected clients. The Command Interface is a client: closing it or losing the operator connection does not stop Core or an accepted Plugin Operation. An operator can reconnect during that Core run to obtain the processing result. Field Assets can independently lose contact, including when they leave radio range. Those disconnections do not mean the Atlas server is offline.

This is the normal deployment and operating model. If Core itself restarts, the next run starts empty. Plugin fault handling and client reconnection occur within a run and do not imply restoring data after a Core restart.

## Local operation and disposable data

An installed Atlas system works without internet access when operators and Assets can reach Core. Authentication, tasking, Objects and synchronization must not require a cloud service. A Plugin that consumes an external internet service depends on that service separately; its loss does not prevent local Core operation. See [the local operation decision](../adr/0010-operate-without-internet-access.md).

Retain operational records only during the current run. Every Core start clears Entity/Track state, Tasks, Object metadata and content, movement/activity history, Plugin Operation records, synchronization records and temporary uploads. Restart includes reset; there is no restart mode that preserves this data. Version-to-version data migrations and backup/restore are outside the design. See [the reset decision](../adr/0013-start-each-core-run-with-empty-data.md).

The operating assumption is that Core does not restart while Assets are running. Restart ends the operating session; participating clients begin fresh for the next session. Same-run disconnection and reconnection remain supported. Seamless continuation across Core restarts, automatic reconciliation of previous-run reports and a run-identity protocol for that purpose are outside scope. This replaces the earlier requirement to detect and reconcile that lifecycle automatically. Installed Plugin selections, credentials and configuration survive as startup setup. The reset affects operational data, not installed software or the setup needed to start the next run.

## Tasks across a disconnection

Within the same Core run, operators can issue Tasks to disconnected Assets. Assets retain an onboard Task queue. On reconnect, an Asset reports what it did while disconnected and reconciles its queue with Core's current Tasks, including cancellations and newly issued work. See [the Task reconciliation decision](../adr/0007-reconcile-asset-tasks-after-disconnection.md).

For example, an operator cancels outstanding Tasks and issues a return Task while an Asset is out of contact. At check-in, the Asset learns of the cancellations and return Task and acts on the updated instructions. Similarly, an operator can cancel a scan of one area and issue a scan of another. Core makes the current Task instructions available during check-in. The Asset operating system decides how to schedule and execute them.

When an operator requests cancellation and the Asset has not confirmed it, Core records Cancellation requested. This state preserves the instruction for synchronization without claiming execution has stopped. An Asset confirmation establishes Canceled; a late completion report is reconciled as described below.

Cancellation at Core cannot retroactively stop work the disconnected Asset already performed. When the Asset reports that it completed the Task before learning of cancellation, Core records Completed, retains the result and preserves the cancellation attempt in activity history. A scan must still satisfy its required-result completion contract; finishing physical acquisition alone does not meet it. Continuing through an onboard queue is an Asset operating system decision outside this design.

## Scan data and processing

The operator issues a scan Task to an Asset. Its hardware determines the result: an Asset with a software-defined radio and antenna produces an Object containing scan data. The operator then invokes a separate Plugin Operation with that Object as input. The Plugin processes the data and produces results. In this example the operator initiates the scan. Plugins are also permitted to initiate Tasks using existing Core-defined Commands through the SDK, without requiring an operator to issue each Task. No planned Plugin needs to exercise that capability immediately; Core must not add a Plugin-specific prohibition.

Core accepts a Plugin Operation with an identifier for querying its state and outcome or requesting cancellation. A long processing Operation continues when the Command Interface closes or disconnects. Plugin detections intended as Entities appear directly in the shared operational picture without an operator review-and-publish step. Connected operators see those Entities through their Command Interfaces; a returning operator obtains the current picture.

If a Plugin crashes during an Operation, Core first reconciles the recorded outcome. Once the attempt is known to have failed, it stays failed and the operator may explicitly rerun it. Restarting the Plugin does not automatically retry that Operation. The same manual-restart policy applies to continuous-source Plugins. Core reports the fault and supports an operator-requested restart; automatic restart and elaborate recovery orchestration are not required for the first version.

Installing, updating, removing, enabling or disabling a Plugin must not require restarting Core or stopping unrelated Plugins. Core APIs and Asset connections remain available. Planned stops and updates still respect the agreed active-work policy. This is independent Plugin lifecycle management, not a requirement to replace running code inside the Core process.

The external Command Interface will have a Plugins entry in its sidebar where the operator can see Plugin faults and request a restart. Core supplies Plugin state and the restart capability. The menu implementation belongs to the Command Interface.

## Task status and result availability

Keep these seven main Task statuses: Pending, Acknowledged, In progress, Cancellation requested, Completed, Canceled and Failed. Do not add a main status such as “scan completed, data pending.”

For a scan, Completed means execution has finished and its required result is available in Atlas. While that result is uploading, the Task remains In progress. Separate Asset-provided progress details can describe “scan finished, uploading data” without adding another main status; the exact contract for those details remains to be designed. Subsequent Plugin processing is independent and does not hold the scan Task open. See [the scan completion decision](../adr/0008-complete-scan-tasks-when-required-results-are-available.md).

Failed records a definitively unsuccessful Task outcome, such as permanent loss of required scan data. A disconnection alone does not establish failure.

Clients and Plugins use SDK Object APIs without depending on physical storage paths or buckets. Large uploads resume from confirmed progress after connection loss within the same Core run. Partial transfer state stays internal; a Core restart discards it with all other operational data. Objects become visible only when ready for use. During a scan-result upload, progress belongs with the Task; Atlas does not list an unavailable or partially uploaded Object. This favors a simpler availability contract over early previews. See [the Object visibility decision](../adr/0009-expose-objects-only-when-ready.md).

## Details for module planning

- Startup: initialize empty operational state and preserve installed Plugin selections, credentials and configuration as startup setup. Core remains running while Assets operate. Data migrations, cross-run preservation and cross-restart client continuity are excluded.

- Core tasking: the detailed reconciliation contract for operator instructions and Asset reports. Cancellation requested and late-completion behavior are settled; Asset scheduling and interruption policies are outside scope.
- Task results: Asset-provided progress details and failure reasons. The successful scan completion boundary, Failed status and Object visibility only when ready are settled.
- Plugins: installation format, configuration and invocation contracts. Independent lifecycle changes without restarting Core are settled. Fault reporting and manual restart are settled for both Operations and continuous sources. Detailed handling of interrupted work and previously published results is deferred to implementation planning, not a reason to design a recovery platform.
- Shared observations: provenance and correction of detections. A review-and-publish layer is excluded.

Interview questions should address shared Core capabilities and guarantees that affect SDK and Protocol consumers. Do not ask the operator to design individual Plugins, Asset operating systems or Command Interface behavior. Resolve routine technical choices through engineering judgment and bring back only consequential system-wide outcome tradeoffs. Core storage, messaging and process mechanisms follow from the selected outcomes. Radio transport implementations and Asset operating system behavior remain outside this design.
