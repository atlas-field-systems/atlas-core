---
status: accepted
---

# Administer Core configuration locally

Atlas's field workflow uses local setup and administration of one Core server. The earlier configuration plan allowed remote clients to inspect settings and save both live tuning and deployment changes for later local application. Those capabilities required a public configuration contract and coordination between remote edits and local lifecycle work.

On 6 October 2026 the user confirmed that local administration covers the required workflow, including live tuning and configuration inspection. They explicitly accepted removing public configuration editing and inspection while retaining authenticated remote health and readiness.

Current rules: [Core configuration](../topics/dataset-lifecycle.md#core-configuration), with local coordination under [host supervision and private coordination](../topics/dataset-lifecycle.md#host-supervision-and-private-coordination).

## Decision

Make all Core configuration editing and inspection local CLI/TUI actions through the shared local management implementation. Do not expose configuration endpoints, SDK methods or public Protocol configuration schemas. Live operational settings can still change while Core runs. Deployment settings follow explicit local setup and application.

Remove the public configuration contract previously planned in [#80](https://github.com/atlas-field-systems/atlas-core/issues/80). Preserve validation, concurrency checks against the reviewed revision, local actor attribution, Installation setup retention and safe recovery after failed or interrupted application. Configuration actions share lifecycle serialization and private Core coordination; Core remains the sole accessor of its SQLite database.

## Rationale and alternatives

- Local administration is sufficient for the expected field workflow. Remote configuration editing, inspection and staging are removed capabilities, not behavior-preserving refactoring.
- Keeping remote live tuning while moving only deployment settings local would retain the configuration API, its authority checks and a second caller path into management coordination. The user chose local ownership for both.
- Saved settings can still differ from effective values until a local apply or Restart. Local inspection must explain that difference and startup failures without maintaining a public desired/active resource model.

## Consequences

- The Command Interface cannot inspect full Core configuration or stage settings for local application. Authenticated remote health and readiness remain available.
- CLI and TUI use one management owner for configuration and lifecycle work. No public patch needs a separate private management reservation.
- Existing field bounds, live admission semantics and deferred application requirements remain unchanged. Lowering a limit does not cancel admitted work or discard retained content.
- Failed startup retains saved settings and the last startup-validated revision for explicit local correction or restoration. Removing remote configuration does not permit automatic fallback, silent conversion or unvalidated database edits.
- Detailed CLI spelling, TUI layout and private settings representation remain implementation choices. This decision updates the design; it does not implement the local management system.
