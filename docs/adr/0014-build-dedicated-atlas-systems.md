---
status: accepted
---

# Build dedicated Atlas systems

Build dedicated Atlas modules around the current Entities, Tasks, Objects and supporting responsibilities. Share infrastructure utilities where concrete workflows benefit, without making a reusable infrastructure platform or frequent module replacement a primary deliverable.

This supersedes [ADR-0012](0012-build-replaceable-modules-on-shared-infrastructure.md). The user reconsidered the infrastructure-first approach because routinely swapping implementations is not an expected use case. Designing a framework around that possibility would add complexity and technical debt beyond what Atlas needs.

Clear ownership, ordinary module interfaces, private storage access, minimal generator customization and independent behavior tests remain useful. Protocol defines shared external contracts, SDK is the expected entry point for all external consumers, and Core implements Atlas behavior. Internal collaboration can use direct code interfaces. See the [system design](../architecture/system-design.md) for the accepted boundaries and client modes.
