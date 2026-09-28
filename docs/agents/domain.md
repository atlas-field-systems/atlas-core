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

## Decision authority

The user chooses observable behavior; engineering selects internal mechanisms that preserve it. Applicable requirements remain binding until the user authorizes a change. Review suggestions, implementation difficulty and an agent's tradeoff explanation do not authorize a deviation. An agent cannot establish acceptance by editing the requirement, its tests or the record of a decision to match its implementation.

Use existing user authorization without asking again. If a proposed change to an accepted requirement is outside that authorization, identify the affected requirement, the proposed change and its consequences, and obtain the user's decision before making the dependent change. Continue independent work within the authorized scope. Record the authorization with the decision in its authoritative home; proposals remain proposals until accepted.

## Recording changes

Capture a resolved term in the glossary. Add an ADR sparingly, when a decision is hard to reverse, surprising without context and the result of a real tradeoff. Preserve superseded records and link to their replacements.

Keep each rule in its authoritative home. Elsewhere, use a short explanation and a link rather than copying the full contract. When moving a rule, preserve its meaning and update incoming links. Mark unresolved choices where they occur; do not promote a research recommendation by copying it into an accepted section.

Implementation specifications follow the issue-tracker convention. Research questions alone do not require tickets. Keep agent instructions focused on conditional reading pointers and the hard guardrails needed on every relevant change.

## Documentation completion

Before completing a decision or policy change, check affected glossary entries, architecture documents, API and SDK plans, testing requirements, agent instructions and references against the authoritative change. Update contradictions and broken references within the authorized scope. Identify unresolved conflicts explicitly; a change with unresolved contradictions is not complete. Verify that summaries and historical records point to current authority without turning proposals into accepted requirements.

Report which consistency and reference checks were performed and any missing evidence. Documentation-only work must pass these checks; it does not require an unimplemented application test suite.
