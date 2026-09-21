# Domain documentation

Atlas uses one root [CONTEXT.md](../../CONTEXT.md) and shared [ADRs](../adr/). Read the glossary before exploring or changing domain behavior, then read the ADRs relevant to that work. Use its canonical terms and flag conflicts with accepted decisions explicitly.

## Where information belongs

| Information | Authoritative home | When to read or update it |
| --- | --- | --- |
| Domain terms | [CONTEXT.md](../../CONTEXT.md) | Defining or using Atlas vocabulary; keep definitions short and free of implementation details |
| Users, workload and field assumptions | [Operating model](../architecture/operating-model.md) | Evaluating product scope or a proposed workflow |
| Repository boundaries and responsibility assignments | [System outline](../architecture/system-outline.md) | Assigning ownership or planning a module; candidate subsystems remain proposals |
| Collaboration and interface ownership | [System design](../architecture/system-design.md) | Changing module interfaces, SDK responsibilities, access boundaries, storage ownership or generation |
| Accepted architectural tradeoffs | [ADRs](../adr/) | Changing behavior governed by a decision; retain the decision, rationale and necessary consequences |
| Differences from Modernization | [Comparison register](../architecture/modernization-differences.md) | Accepting a source-system behavior change; preserve evidence and stable row IDs |
| Historical evidence and alternatives | [Research index](../research/atlas-reassessment/README.md) | Evaluating a technology or revisiting a tradeoff |
| Implementation specifications and assigned work | [GitHub Issues](issue-tracker.md) | An experiment or implementation slice is requested |

ADRs govern the tradeoffs they record. Architecture documents own the current boundaries and assumptions not covered by an ADR, and link to ADRs for their detailed rules. Summaries and examples explain those rules; they do not establish competing versions. Research and the comparison register link to successor authority rather than defining it.

## Recording changes

Capture a resolved term in the glossary. Add an ADR sparingly, when a decision is hard to reverse, surprising without context and the result of a real tradeoff. Preserve superseded records and link to their replacements.

Keep each rule in its authoritative home. Elsewhere, use a short explanation and a link rather than copying the full contract. When moving a rule, preserve its meaning and update incoming links. Mark unresolved choices where they occur; do not promote a research recommendation by copying it into an accepted section.

Implementation specifications follow the issue-tracker convention. Research questions alone do not require tickets. Keep agent instructions focused on conditional reading pointers and the hard guardrails needed on every relevant change.
