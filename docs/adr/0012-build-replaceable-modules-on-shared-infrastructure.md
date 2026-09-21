---
status: superseded by ADR-0014
---

# Build replaceable modules on shared infrastructure

Superseded by [ADR-0014](0014-build-dedicated-atlas-systems.md). The text below records the earlier rationale, not current implementation requirements.

Atlas modules own cohesive behavior and their data access behind explicit interfaces, using a small shared foundation for infrastructure. The user selected replaceability as a primary objective so an implementation, and eventually the Atlas domain modules as a whole, can be rebuilt without repeatedly rebuilding the underlying platform. The initial implementation must demonstrate that separation, not merely organize code into directories.

Shared infrastructure must not accumulate Entity, Track, Task or Plugin-specific rules. Replacing an implementation that preserves its public contract should leave unrelated modules and foundation behavior unchanged, apart from explicit assembly wiring. Each module initializes its current schema from empty storage; [Core restart wipes operational data](0013-start-each-core-run-with-empty-data.md), so replacement does not require a data migration. A changed public contract still requires deliberate Protocol/SDK evolution. Module replaceability does not require every module to be a Plugin, a separate service or replaceable while Core is running.
