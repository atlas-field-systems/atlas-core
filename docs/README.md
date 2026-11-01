# Atlas, by system

Atlas observes field systems, asks Assets to do work, and retains their reports.
We are replanning it around four replaceable systems.

Read a short story and flow, then ask whether that is how Atlas should work.
Flows show behavior, not every wire message. Detailed reference is optional.

[Why we are starting fresh](why-a-fresh-start.md) explains the repository transition
and why the project owner needs to read the docs whenever they change.

## The four systems

| System | Start here |
| --- | --- |
| [Entities](entities/README.md) | Assets, Observations, Tracks, and Geofeatures |
| [Tasks](tasks/README.md) | Request work and find out what actually happened |
| [Objects](objects/README.md) | Store files and associate them with the work |
| [Plugins](plugins/README.md) | Extend Atlas; the earlier design is available for review |

## Supporting topics

- [Authentication and administration](support/README.md).
- [How the systems work together](shared/README.md).
- [Detailed previous design](reference/README.md), including simulations and qualification.

## Planning status

These stories restate selected existing behavior for review, without approving
every old requirement. Plugin behavior is undecided. Correct mismatches here first.

The original docs still describe the current implementation. The retained reference
preserves their detail; its commands and results do not qualify a future rebuild.

## Direction agreed so far

- Small interfaces and private data ownership for each pillar.
- Authentication and administration kept separate.
- Logical separation first, without requiring separate databases.

Database layout, Plugin responsibilities, cross-system guarantees, and data
preservation remain open. Repository renaming and archiving come later.
