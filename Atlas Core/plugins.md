# Plugins and Operations

**Plugins add removable capabilities without rebuilding Core.** Keep specialized
algorithms and dependencies in their own repositories. Removing a Plugin must not
make its published Atlas results unreadable.

## Installation and trust

Install an explicitly selected, immutable local bundle with image digest, package
identity/version, supported public/private editions, capability IDs, and local
input/output/configuration schemas. No remote schema references. Installed,
enabled, and runtime-available are different states.

A Plugin is trusted extension code, not a hostile-code sandbox. Give it its own
credential and owned work area, not Docker access or Core's database/files.
It uses SDK for ordinary Atlas interactions. Private dispatch coordinates execution;
it is not a second public API or a Plugin-defined Command Catalog.

Keep stable publisher identity separate from installation ID and credential.
Updates preserve installation identity; reinstallations get a new installation and
principal. Reinstallation names an existing publisher explicitly. Publisher identity
does not depend on the submitting API key.

## Delivery without accidental reruns

Protocol defines [Operation admission, state, and recovery](../Atlas%20Protocol/operations.md).
Core enforces that contract through durable exposure records and runtime verification.

Use authenticated Plugin-initiated long polling over a private Unix channel. Bind
runtime identity to installation, principal, Dataset, Core run, and process generation.
Verify readiness against the selected artifact, configuration, and capabilities.

Core records possible exposure before sending work. The Plugin atomically records
receipt identity and input digest before effects. Exact redelivery is safe only to
the same verified live runtime; conflicting input is an error. Retain even completed,
acknowledged receipts until that runtime ends. A reused container name is not proof
of runtime continuity.

Reserve cumulative receipt capacity before accepting new Operations. At exhaustion,
refuse fresh work while keeping retries, reports, and cancellation usable. Do not
automatically evict receipts or restart. Manual protected restart recovers capacity.
This prevents duplicate dispatch; it does not promise exactly-once external effects.

Persist unacknowledged terminal evidence and known effects before reporting. Core
acknowledges its exact accepted revision. Evidence cleanup must not remove live
receipt protection. Use the durable exposure records to apply Protocol's recovery rules.

## Independent lifecycle and storage

Planned stop/update/configuration changes close admission and ingestion, then drain
or cancel finite work while Core and unrelated Plugins remain available. Explicit
force follows [the management contract](lifecycle.md). A fault needs manual restart;
rerunning interrupted processing is a separate decision.

Validate a complete configuration candidate; distinguish saved, active, and
last-working settings. Failed application remains visible until correction or an
explicit restore, not automatic fallback.

Plugin operational work survives Restart but is cleared by Reset for enabled,
disabled, and faulted Plugins. Setup/reference data survives Reset. Uninstall removes
owned private state and credentials after verified exit; published resources and
Operation provenance remain until Reset. Failed cleanup blocks unsafe reuse.

No marketplace, dependency graph, automatic updates, or generic UI builder is part of this baseline.

[Next: diagnostics](diagnostics.md)
