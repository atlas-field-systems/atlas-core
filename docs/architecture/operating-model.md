# What Atlas is for

Atlas is primarily for one operator, with any additional operators equally trusted to observe Entities, task Assets and use Plugins to process data or gather external information. Plugin detections appear directly in the shared picture; a review-and-publish layer is excluded.

This document owns product scope, workload and field assumptions. Examples illustrate the linked decisions; detailed lifecycle and interface rules live in ADRs and the [system design](system-design.md).

## Field workflow

1. Arrive at a site.
2. Set up and start Atlas Core.
3. Connect the Assets.
4. Run the mission with Core continuously available.

An Asset temporarily losing radio contact does not end the mission. Closing the Command Interface does not stop Core. Restart, Reset and release updates occur outside missions; active mission continuity across Core restart is excluded by [ADR-0015](../adr/0015-separate-start-stop-restart-and-reset.md). This is an operating assumption, not a claim that hardware or processes cannot fail.

## Expected workload

The first deployment uses one Core server with field devices. Expected use is local coordination for a few hours, rather than months. A busy run has roughly 20 Assets and one or two operators. An ADS-B integration may add 100–200 local aircraft Tracks, potentially more. Thousands are a future scale to evaluate, not a promised first-version capacity. Reporting frequency, burst rates and Object sizes remain unspecified; resource counts alone do not establish throughput or storage needs. A mission or session is a usage description, not a new API resource.

## Scope of this design

Design Core with its related SDK and Protocol. Breaking changes from Modernization are acceptable when they simplify the system. Prefer lower complexity when a workflow does not need additional states, configuration or operator steps.

Command Interface interaction design, production Plugin algorithms, device-side runtimes, radio transports and Asset operating systems are outside scope. The small example Plugin below exercises the Core integration. Core defines shared guarantees; integrations choose how to use them. The [system outline](system-outline.md) assigns responsibilities and the [system design](system-design.md) defines their boundaries.

## SDK consumers and radio links

Accepted on 28 September 2026: the general SDK targets participants with sufficient IP bandwidth to obtain the full operational picture: applications, Command Interfaces, Plugins, IP-connected Assets and radio gateways. A gateway usually runs separately from Core, may run on the Core machine, and need not share its local network. The constrained link is between the gateway and bandwidth-limited Assets. This is a deployment assumption, not a measured capacity guarantee; IP access does not require internet access when Core is locally reachable.

Keep HTTP mode and Full synchronization mode in the general SDK. [ADR-0020](../adr/0020-limit-general-sdk-to-http-and-full-sync.md) removes Asset hybrid from the current SDK scope and defers its matching Core synchronization machinery. Gateways choose what crosses the radio link. Bandwidth-limited Assets rely on their gateway rather than running the general SDK; IP-connected Assets use it directly. If a future IP deployment itself needs constrained-link behavior, a dedicated SDK or integration can address it without adding that requirement to the current general SDK.

## Initial MVP

Status: accepted initial scope, not yet implemented. Build Core, Protocol and SDK around three independent examples:

| Example | Observable behavior | Boundary |
| --- | --- | --- |
| Move To Command | An operator issues a Task asking one Asset to move to a destination. The Asset receives it and reports progress and its outcome. | The Asset OS owns movement and execution. Completion needs no movement-log Object or Plugin processing. |
| Elevation Lookup Plugin | A client invokes an Operation with a geographic position and receives the ground elevation at that position. | This is independent of Move To. It needs no Asset Task, input Object or output Object; a small value can be the Operation result. |
| Object transfer | A client uploads known fixture content through the SDK, obtains a ready Object and downloads matching content. | Test Objects independently, without making either example manufacture a file. |

Use a small local elevation dataset for the example and repeatable tests, so the MVP works without internet. The result must state its units and elevation reference. Exact coordinate fields, dataset and lookup behavior remain implementation choices; a production elevation provider is not selected.

Plugins normally live in separate repositories. This example may start under `examples/plugins/` in the Atlas Core repository, with its own build and container, using the supported Plugin contract and SDK. Keep it separable so it can move to its own repository without changing Core behavior.

The MVP proves Task delivery, Plugin invocation and Object transfer through real Core/Protocol/SDK integration. A simulated Asset supplies execution reports for tests; it does not introduce an Asset OS into Core. The [integration checks](system-design.md#mvp-integration-checks) cover disconnection, cancellation and lifecycle behavior. Command Interface implementation is not required for this milestone.

Treat this as a Core contract milestone. [Later validation](../testing-strategy.md#core-contract-and-field-validation-milestones) uses a real Asset to establish physical behavior and a separately built Plugin to establish extension independence; those are not claims a simulated Asset or an in-repository example can prove.

## Operator access

Every authenticated operator has full control, with no operator roles or view-only accounts. Installed Plugins are trusted extensions built by the user. Authentication and caller attribution still matter; [identity and access](system-design.md#identity-and-access) defines the fixed operator, Asset and Plugin boundaries.

## Local operation and data retention

An installed system [works without internet](../adr/0010-operate-without-internet-access.md) when operators and Assets can reach Core. An internet-source Plugin depends on its external service independently.

Start, Stop and Restart preserve data and logs. Reset is the usual development fresh start and preserves installation setup, including Operator profiles. Hard Reset is a separate local CLI/TUI action available whether Atlas is running or stopped that wipes all Atlas-managed state and returns to first-time setup. The [lifecycle decision](../adr/0015-separate-start-stop-restart-and-reset.md) owns the action table, retained setup, release-update Reset and client dataset boundary. Local CLI/TUI tools provide [administration](system-design.md#local-administration).

Plugins keep private operational work in [Atlas-managed working storage](../adr/0021-manage-plugin-operational-storage-through-reset.md). It survives ordinary Restart subject to the existing reconciliation rules and is cleared by Reset. Retained setup and installed reference data remain separate, so a fresh Dataset does not restore an old work queue or require reinstalling the Plugin's reference data.

[Uninstall](../adr/0021-manage-plugin-operational-storage-through-reset.md#uninstall-and-reinstall) clears that Plugin's private work, saved setup, credentials, reference data and owned artifacts after stopping it, while published Atlas resources and recorded Operation outcomes retain their own lifetimes. Disable the Plugin to preserve its installation without running it. Reinstallation starts with an empty working directory and may require configuration and downloads again. Within the same Dataset, the [same authenticated publisher](../adr/0022-one-publisher-per-track.md#publisher-continuity) can continue its existing Tracks using fresh observations.

## Tasks across a disconnection

An operator can cancel a scan of one area and issue another while an Asset is out of contact. During reconnect reconciliation, the Asset checks in, reports completed work and learns the current cancellations and Tasks. It may instead receive a return Task. The Asset OS chooses how to schedule, interrupt and execute its onboard work.

[Task reconciliation](../adr/0007-reconcile-asset-tasks-after-disconnection.md) defines pending cancellation and late outcomes. Losing contact or missing required scan data does not establish Failed; that requires the assigned Asset to report a definitive unsuccessful outcome. Atlas records actual outcomes without pretending a cancellation undid work already performed.

## Scan data and processing

This remains a broader system example, beyond the initial MVP's separate workflows.

The operator tasks an Asset to scan an area. Its hardware determines the result: an Asset with a software-defined radio and antenna produces an Object containing scan data. While uploading the required result, it has not yet met the [scan completion promise](../adr/0008-complete-scan-tasks-when-required-results-are-available.md). [Objects become visible when ready](../adr/0009-expose-objects-only-when-ready.md).

The operator separately invokes a Plugin Operation on that Object. The Plugin owns the algorithm and specialized result format. Processing does not hold the original scan Task open, and the accepted Operation continues if the operator closes or disconnects the Command Interface. A returning operator can obtain its result. Published detections enter the shared picture directly.

[Tasks referencing a Geofeature follow changes to its geometry](../adr/0024-use-live-geofeature-geometry-in-tasks.md). Disconnected Assets may use their last received geometry within the Command's limits and adopt the latest on reconnect. Atlas distinguishes a saved edit from the Asset's confirmation that it applied the change. Once Core accepts that a scan has finished collecting data, later geometry edits require another scan; the existing Task still waits for its required uploads before Completed. Silent Tracks [retain last-known observations with their age](../adr/0022-one-publisher-per-track.md#observation-age). Each Command defines whether it needs current data or can use last-known observations.

This example does not require every Plugin to produce a separate Object or establish general version history. Published Object content follows the [immutable-content rule](../adr/0009-expose-objects-only-when-ready.md); descriptive metadata can change. Plugins may also [initiate Asset Tasks](../adr/0004-core-owns-commands-and-assets-execute-tasks.md) through existing Commands. Area/building searches can be Operations; an aircraft-data integration can continuously publish Entities without becoming taskable.

## Details for module planning

The 28 September grilling round settled [stale descriptive edits](system-design.md#concurrent-descriptive-edits), [one publisher per Track](../adr/0022-one-publisher-per-track.md), [deletion protection for required Entity references](../adr/0023-protect-required-entity-references-during-tasks.md) and [Plugin-private work on uninstall](../adr/0021-manage-plugin-operational-storage-through-reset.md#uninstall-and-reinstall).

The second round settles [same-publisher continuity and silent Tracks](../adr/0022-one-publisher-per-track.md#publisher-continuity), [live Geofeature geometry](../adr/0024-use-live-geofeature-geometry-in-tasks.md) and [Plugin setup removal on uninstall](../adr/0021-manage-plugin-operational-storage-through-reset.md#uninstall-and-reinstall).

The third round settles [offline geometry and adoption evidence](../adr/0024-use-live-geofeature-geometry-in-tasks.md#disconnection-and-adoption), the [collection-finished boundary](../adr/0008-complete-scan-tasks-when-required-results-are-available.md#geometry-and-collection-finished-reports) and [Command-specific Track freshness](../adr/0022-one-publisher-per-track.md#track-data-used-by-commands).

The fourth round permits [publisher corrections to current observations](../adr/0022-one-publisher-per-track.md#correcting-current-observations) while preserving observation age and recorded history, and [defers publisher transfers](../adr/0022-one-publisher-per-track.md#publisher-transfers). Replacement sources use separate Tracks, and existing Task references remain unchanged.

The product decisions raised in these four rounds are settled. Asset progress/failure detail contracts, Command-specific freshness limits, workload measurements, exact wire fields and Plugin installation/invocation formats remain implementation work within the settled boundaries.

Questions for the operator should concern consequential system-wide outcomes. Explain alternatives through the behavior the user would experience, then ask which behavior they prefer. Resolve technical implementation choices through engineering judgment rather than asking the operator to select technologies or mechanisms. Avoid asking the operator to design individual Plugins, Asset operating systems or Command Interface interactions while planning Core.
