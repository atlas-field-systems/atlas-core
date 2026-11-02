# Subsystem planning

These pages hold the subsystem stories moved out of the Atlas charter.
They describe intended behavior for further planning, not proof that the current
implementation provides it. Existing implementation references remain intact.

Read the [central charter](https://github.com/atlas-field-systems/atlas/blob/main/CHARTER.md)
and [operating environment](https://github.com/atlas-field-systems/atlas/blob/main/environment.md)
for project-wide context. Read the relevant subsystem below for its rules.

## Read one system

| System | Planning |
| --- | --- |
| Entities | [Assets, Observations, Tracks, and Geofeatures](entities/README.md), with [history](entities/history.md) |
| Tasks | [Requested work and reported outcomes](tasks/README.md) |
| Objects | [Files and their availability](objects/README.md) |
| Plugins | [Informational extensions](plugins/README.md) |
| Run lifecycle | [Operating a run](support/operations.md), [archive proposal](support/archive.md), and [initial choices](support/environment.md) |

Entities, Tasks, Objects, and Plugins keep small interfaces and private data
ownership. Separate databases and deployments are optional.
Storing Plugin planning here does not assign Plugin runtime supervision to Core.
That component's implementation home remains undecided.

## Status and ownership

**Selected direction** records the owner's stated choices. **Proposed** marks a
suggestion for review. **Open** marks a decision still needed.
Moving a page changes its home, not the approval status of its contents.

For current shared contracts, use [Protocol](../Atlas%20Protocol/README.md).
Server mechanisms belong in [Core](../Atlas%20Core/README.md), and client behavior
belongs in [SDK](../Atlas%20SDK/README.md). Before implementing a selected plan,
update its owning contract and reconcile any differences with current behavior.
Keep planning distinct from implementation evidence.

## Client direction

The selected SDK direction is HTTP by default with opt-in in-memory Full
synchronization. History is requested explicitly rather than downloaded with live state.

Reconnection preserves identity and reconciles existing work. It does not authorize
repeating an uncertain physical action. Local persistence and recovery details belong
to each runtime and need explicit contracts where components depend on them.
