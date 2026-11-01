# Plugins and Operations

> Historical design for review, not approved. [Planning status](../../README.md#planning-status).

**Plugins add removable capabilities without rebuilding Core.** Keep specialized
algorithms and dependencies in their own repositories. Removing a Plugin must not
make its published Atlas results unreadable.

## Installation and trust

Install an explicitly selected, immutable local directory bundle. Its `plugin.json`
manifest declares `package_id`, `package_version`, exact `protocol_version`, private
`dispatch_version` equal to `1`, `image_digest`, `configuration_schema`, and `capabilities`.
Package and capability IDs are UUIDs. Versions are nonempty exact strings, not ranges.
The image is preloaded and named by its SHA-256 digest; installation never pulls it.

Each capability declares its ID and input, output, and known-effects schema references.
Each schema reference names a relative file and its SHA-256 digest. References stay
within the bundle under the [selected schema profile](https://github.com/atlas-field-systems/atlas-core/blob/30a3f9958c6eb6aa953596d413b12c3a3d3fb02e/Atlas%20Core/build-profile.md#schema-profile).
Reject unknown manifest properties, duplicate IDs, digest mismatches, symlinks,
path escapes, and unsupported editions before changing the installed selection.
The SHA-256 of the exact manifest bytes identifies the bundle and binds its image
and schemas. A package/version pair cannot name different bundle digests.

Core validates configuration and Operation payloads against those installed schemas.
Accepted Operations retain their original manifest/schema copies until Reset,
including after uninstall, so recovered evidence uses the original definitions.
Private dispatch carries the selected digests and configuration revision; readiness
must match them. Installed, enabled, and runtime-available are different states.
The [finite bundle and runtime limits](https://github.com/atlas-field-systems/atlas-core/blob/30a3f9958c6eb6aa953596d413b12c3a3d3fb02e/Atlas%20Core/limits.md) apply before allocation.

A Plugin is trusted extension code, not a hostile-code sandbox. Give it its own
credential and owned work area, not Docker access or Core's database/files.
It uses SDK for ordinary Atlas interactions. Private dispatch coordinates execution;
it is not a second public API or a Plugin-defined Command Catalog.

Keep stable publisher identity separate from installation ID and credential.
Updates preserve installation identity; reinstallations get a new installation and
principal. Continuing an existing publisher requires its explicit ID and
[allocator-state recovery](https://github.com/atlas-field-systems/atlas-core/blob/30a3f9958c6eb6aa953596d413b12c3a3d3fb02e/Atlas%20Protocol/observations.md#reports-and-movement).
Uninstall can remove private allocator state; its ID and Core's accepted reads alone
cannot recover it. When continuity is required, the Plugin prepares its handoff
before uninstall. It stops allocating and exports a durable upper bound, or uses
a shared allocator. Core's uninstall performs no allocator transfer step.
Publisher identity
does not depend on the submitting API key. Observation publishers follow
[source attribution rules](https://github.com/atlas-field-systems/atlas-core/blob/30a3f9958c6eb6aa953596d413b12c3a3d3fb02e/Atlas%20Protocol/observations.md#identity-and-attribution).

## Delivery without accidental reruns

Protocol defines [Operation admission, state, and recovery](operations.md).
Core enforces that contract through durable exposure records and runtime verification.

Use the [private execution contract](runtime.md) for authenticated long polling,
receipt protection, cancellation, evidence revisions, and exact acknowledgments.
Core records possible exposure before delivery. Runtime loss never authorizes
re-execution of possibly exposed work. This prevents duplicate dispatch; it does not
promise exactly-once external effects.

## Independent lifecycle and storage

Planned stop/update/configuration changes close admission and ingestion, then drain
or cancel finite work while Core and unrelated Plugins remain available. Explicit
force follows [the management contract](https://github.com/atlas-field-systems/atlas-core/blob/30a3f9958c6eb6aa953596d413b12c3a3d3fb02e/Atlas%20Core/lifecycle.md). A fault needs manual restart;
rerunning interrupted processing is a separate decision.

Validate a complete configuration candidate; distinguish saved, active, and
last-working settings. Failed application remains visible until correction or an
explicit restore, not automatic fallback.

Plugin operational work survives Restart but is cleared by Reset for enabled,
disabled, and faulted Plugins. Setup/reference data survives Reset. Uninstall removes
owned private state and credentials after verified exit; published resources and
Operation provenance remain until Reset. Failed cleanup blocks unsafe reuse.

Specialized fusion can be a separate project under the [fusion boundary](https://github.com/atlas-field-systems/atlas-core/blob/30a3f9958c6eb6aa953596d413b12c3a3d3fb02e/Atlas%20Core/fusion.md).
Installing a Plugin does not replace the active policy or define its handover.
Published Observations and Tracks retain their Core-owned lifetime if a Plugin is removed.

No marketplace, dependency graph, automatic updates, or generic UI builder is part of this baseline.

[Next: fusion](https://github.com/atlas-field-systems/atlas-core/blob/30a3f9958c6eb6aa953596d413b12c3a3d3fb02e/Atlas%20Core/fusion.md)
