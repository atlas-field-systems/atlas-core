# Domain documentation

Atlas uses one root [CONTEXT.md](../../CONTEXT.md), one [topic page](../topics/README.md) per area of behavior and shared [ADRs](../adr/README.md). Read the glossary before exploring or changing domain behavior, then the topic page and the ADRs relevant to that work. Use its canonical terms and flag conflicts with accepted decisions explicitly.

## Where information belongs

| Information | Authoritative home | When to read or update it |
| --- | --- | --- |
| Domain terms | [CONTEXT.md](../../CONTEXT.md) | Defining or using Atlas vocabulary; keep definitions short and free of implementation details |
| Users, workload and field assumptions | [Operating model](../architecture/operating-model.md) | Evaluating product scope or a proposed workflow |
| Current behavior rules, their routes and SDK operations, and open questions for one area | [Topic pages](../topics/README.md) | Planning, implementing or reviewing behavior in that area; each rule lives on exactly one page |
| Repository boundaries and responsibility assignments | [System outline](../architecture/system-outline.md) | Assigning ownership or planning a module; candidate subsystems remain proposals |
| Cross-cutting mechanisms and module collaboration | [System design](../architecture/system-design.md) | Changing write commits, retry identity, change publication, Dataset opening, module interfaces or generation |
| Public routes and their effects | [Endpoint map](../api-endpoints.md) | Adding or changing a route; behavior rules link to their topic page |
| Component inventory and proposed storage mapping | [Component catalog](../data-components.md) | Adding a component or planning storage |
| Required test evidence | [Testing strategy](../testing-strategy.md) | Planning, adding or reviewing tests for a behavior |
| Accepted architectural tradeoffs | [ADRs](../adr/README.md) | Changing behavior governed by a decision; retain the context, decision, rationale and consequences, and link to the topic page for detailed rules |
| Differences from Modernization | [Comparison register](../architecture/modernization-differences.md) | Accepting a source-system behavior change; preserve evidence and stable row IDs |
| Dated decision history and user authorizations | [Decision log](../planning-reconciliation.md) | Recording a user decision; history only, never the authority for a current rule |
| Historical evidence and alternatives | [Research index](../research/atlas-reassessment/README.md) | Evaluating a technology or revisiting a tradeoff |
| Implementation specifications and assigned work | [GitHub Issues](issue-tracker.md) | An experiment or implementation slice is requested |

ADRs govern the tradeoffs they record. Topic pages own the current rules that implement them. Architecture documents own cross-cutting mechanisms and the boundaries not covered by a topic page. Summaries and examples explain those rules; they do not establish competing versions. Research and the comparison register link to successor authority rather than defining it.

## Decision authority

The user chooses observable behavior; engineering selects internal mechanisms that preserve it. Applicable requirements remain binding until the user authorizes a change. Review suggestions, implementation difficulty and an agent's tradeoff explanation do not authorize a deviation. An agent cannot establish acceptance by editing the requirement, its tests or the record of a decision to match its implementation.

Use existing user authorization without asking again. If a proposed change to an accepted requirement is outside that authorization, identify the affected requirement, the proposed change and its consequences, and obtain the user's decision before making the dependent change. Continue independent work within the authorized scope. Record the authorization with the decision in its authoritative home; proposals remain proposals until accepted.

## Topic pages

A topic page states the current rules for one area: what Atlas does, the routes and SDK operations that expose it, and what remains open. It starts with one line naming what it owns and links to its ADRs for rationale and to the testing strategy for evidence. It does not carry dates, review narrative or superseded rules; the decision log and the ADRs keep that history. Mark proposals and open questions where they occur. Other documents summarize a topic's rule in at most one sentence and link to the page.

## Recording changes

Capture a resolved term in the glossary. Add an ADR sparingly, when a decision is hard to reverse, surprising without context and the result of a real tradeoff. Preserve superseded records and link to their replacements.

Keep each rule in its authoritative home. Elsewhere, use a short explanation and a link rather than copying the full contract. When moving a rule, preserve its meaning and update incoming links. Mark unresolved choices where they occur; do not promote a research recommendation by copying it into an accepted section.

Implementation specifications follow the issue-tracker convention. Research questions alone do not require tickets. Keep agent instructions focused on conditional reading pointers and the hard guardrails needed on every relevant change.

## Documentation completion

Before completing a decision or policy change, check affected glossary entries, architecture documents, API and SDK plans, testing requirements, agent instructions and references against the authoritative change. Update contradictions and broken references within the authorized scope. Identify unresolved conflicts explicitly; a change with unresolved contradictions is not complete. Verify that summaries and historical records point to current authority without turning proposals into accepted requirements.

Report which consistency and reference checks were performed and any missing evidence. Documentation-only work must pass these checks; it does not require an unimplemented application test suite.
