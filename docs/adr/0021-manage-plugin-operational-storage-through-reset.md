---
status: accepted
---

# Manage Plugin operational storage through Reset

Plugins buffer operational work of their own, such as pending ingestion, caches, intermediate results and private invocation records. Reset must cover that work as well as Core records, without requiring Core to understand each Plugin's files or database schema. Uninstalling a Plugin also leaves private work, setup and artifacts that need a defined lifetime.

Current rules: [Plugins](../topics/plugins.md#private-operational-storage), with Reset ordering and recovery under [Reset execution](../topics/dataset-lifecycle.md#reset-execution).

## Decision

Give each installed Plugin an Atlas-managed working directory for its private operational state, as files or a private SQLite database. Preserve it across Stop, Start and Restart, and clear it on ordinary Reset after stopping writers and before Core establishes the fresh Dataset, without clearing it again once that Reset is established. Retained configuration, credentials and installed reference data stay outside it as installation setup.

The Plugin owns the meaning and format of its private state. Core's Plugins module retains lifecycle policy, Operation admission and recorded outcomes. The shared host-side management module owns the directory's placement, retention and cleanup, removing whole owned work directories after stopping writers without interpreting their contents.

Uninstalling a Plugin clears its private working directory, saved configuration, usable credentials, downloaded reference data and owned installation artifacts after the Plugin has been stopped under the active-work protection rules. Published Atlas resources, Core-owned Operation records and publisher attribution retain their own lifetimes. A disabled Plugin is not uninstalled.

Decision history:

- 28 September 2026: the working-directory contract and its Reset cleanup were accepted.
- 28 September 2026: the uninstall cleanup of private work, saved configuration, usable credentials, downloaded reference data and owned installation artifacts was accepted.

## Rationale and alternatives

- A per-Plugin directory lets Reset cover buffered Plugin work without Core understanding each Plugin's files or database schema.
- The decision requires one directory contract, not interchangeable storage providers or a general storage framework.
- Uninstall cleanup is Plugin-scoped, not Hard Reset; it does not remove unrelated or shared resources.

## Consequences

- The host uses Core's private coordination to decide whether a Reset is established, preserving Core's exclusive access to its SQLite database.
- A Plugin must not keep operational state in its container's writable layer, arbitrary host paths or an unmanaged external database, and cannot preserve old work by putting it in retained setup.
- Retaining private files across Restart does not authorize resuming or rerunning an Operation.
- Reset and uninstall cleanup failures must be reported rather than claimed as success.
- A reinstall starts with an empty working directory and may need fresh configuration, credentials and reference-data downloads.
- Exact mount paths and how the Plugin receives them remain implementation choices.
