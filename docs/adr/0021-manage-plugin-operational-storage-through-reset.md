---
status: accepted
---

# Manage Plugin operational storage through Reset

Accepted on 28 September 2026. Give each installed Plugin an Atlas-managed working directory for its private operational state. Preserve it across Stop, Start and Restart, and clear it on ordinary Reset. This makes Reset cover buffered Plugin work as well as Core records, without requiring Core to understand each Plugin's files or database schema.

## Storage contract

Host management supplies one working-directory mount per Plugin. The Plugin may keep files or a private SQLite database within it. All file-backed operational state belongs there, including pending ingestion, caches, intermediate results and private invocation records. A Plugin must not keep this state in its container's writable layer, arbitrary host paths or an unmanaged external database. In-memory work ends when its process stops.

Keep retained configuration, credentials and installed reference data outside that working directory. They remain installation setup and survive ordinary Reset. For example, an installed elevation dataset survives Reset, while a queue of pending lookups or generated results does not. A Plugin cannot preserve old operational work by putting it in retained setup. Exact mount paths and how the Plugin receives them remain implementation choices; this decision requires one directory contract, not interchangeable storage providers or a general storage framework.

The Plugin owns the meaning and format of its private state. Core's Plugins module retains lifecycle policy, Operation admission and recorded outcomes. The shared host-side management module owns the directory's placement, retention and cleanup. It removes whole owned work directories after stopping writers and does not query private Plugin databases or interpret their contents. Published Objects still go through the SDK and Core's Objects module; private working files do not become Objects or give a Plugin access to Core's database or Object store.

Retaining private files across Restart does not authorize resuming or rerunning an Operation. The [Operation lifecycle](0002-core-manages-installed-plugins.md#operation-transitions), [Plugin fault policy](0006-protect-active-plugin-work-during-lifecycle-changes.md) and [whole-Core interruption rules](0015-separate-start-stop-restart-and-reset.md#unfinished-work-after-stop-or-restart) still apply. Starting a Plugin against a new Dataset cannot resubmit old private work under fresh request identities.

## Reset ordering and recovery

Use the existing [Reset directive and identity](0015-separate-start-stop-restart-and-reset.md#reset-execution). After recording the directive and stopping Core and all managed Plugin writers, host management clears this installation's Plugin work directories before Core establishes the fresh Dataset. Cleanup includes directories for disabled or faulted Plugins and any retained work from earlier Datasets. Stopping a container alone does not clear its mounted storage.

If cleanup fails or is interrupted, retain the directive and report incomplete Reset. Do not establish the fresh Dataset or start Plugin work until cleanup succeeds. The next Start resumes that cleanup while writers remain stopped. Make cleanup durable before allowing the fresh-opening transaction to record the Reset identity; filesystem removal and the SQLite commit are separate operations.

Once Core records that Reset identity, the directive is established. A retry opens the Dataset retained and finishes Plugin startup without clearing its work directories again. This preserves work created by Plugins that already started in the new Dataset, even if management was interrupted before starting the remaining Plugins or removing the directive. Before establishment, repeated cleanup is safe because no Plugin has started new-Dataset work. The host uses Core's private coordination for the establishment decision, preserving Core's exclusive access to its SQLite database.

[Hard Reset](0015-separate-start-stop-restart-and-reset.md#hard-reset) clears the working directories and Atlas-managed retained Plugin setup, credentials and installed reference data under its existing ownership scope. Neither Reset nor Hard Reset undoes effects on External sources, removes unrelated host data or recalls copies held by external clients. A Plugin may obtain fresh observations after Reset through its normal integration.

## Implementation evidence

Extend the existing lifecycle workflows in the [testing strategy](../testing-strategy.md), using a real Plugin container, mounted files and a private SQLite fixture. Verify that Restart preserves private state without rerunning interrupted Operations, ordinary Reset clears operational work while retaining setup and reference data, and Hard Reset clears Atlas-owned Plugin state. Interrupt cleanup partway through multiple directories and verify that Plugin startup stays blocked until completion. Then interrupt after Reset establishment with one Plugin already writing new work and verify that recovery preserves that work. These are required checks for implementation, not executed tests.
