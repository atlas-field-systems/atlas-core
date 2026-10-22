# Plugins and Operations

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
within the bundle under the [selected schema profile](build-profile.md#schema-profile).
Reject unknown manifest properties, duplicate IDs, digest mismatches, symlinks,
path escapes, and unsupported editions before changing the installed selection.
The SHA-256 of the exact manifest bytes identifies the bundle and binds its image
and schemas. A package/version pair cannot name different bundle digests.

Core validates configuration and Operation payloads against those installed schemas.
Accepted Operations retain their original manifest/schema copies until Reset,
including after uninstall, so recovered evidence uses the original definitions.
Private dispatch carries the selected digests and configuration revision; readiness
must match them. Installed, enabled, and runtime-available are different states.
The [finite bundle and runtime limits](limits.md) apply before allocation.

A Plugin is trusted extension code, not a hostile-code sandbox. Give it its own
credential and owned work area, not Docker access or Core's database/files.
It uses SDK for ordinary Atlas interactions. Private dispatch coordinates execution;
it is not a second public API or a Plugin-defined Command Catalog.

Keep stable publisher identity separate from installation ID and credential.
Updates preserve installation identity; reinstallations get a new installation and
principal. Reinstallation names an existing publisher explicitly. Publisher identity
does not depend on the submitting API key. Observation publishers follow
[source attribution rules](../Atlas%20Protocol/observations.md#identity-and-attribution).

## Delivery without accidental reruns

Protocol defines [Operation admission, state, and recovery](../Atlas%20Protocol/operations.md).
Core enforces that contract through durable exposure records and runtime verification.

Use the [private execution contract](plugin-runtime.md) for authenticated long polling,
receipt protection, cancellation, evidence revisions, and exact acknowledgments.
Core records possible exposure before delivery. Runtime loss never authorizes
re-execution of possibly exposed work. This prevents duplicate dispatch; it does not
promise exactly-once external effects.

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

Specialized fusion can be a separate project under the [fusion boundary](fusion.md).
Installing a Plugin does not replace the active policy or define its handover.
Published Observations and Tracks retain their Core-owned lifetime if a Plugin is removed.

No marketplace, dependency graph, automatic updates, or generic UI builder is part of this baseline.

[Next: fusion](fusion.md)
