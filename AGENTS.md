## Guardrails

- Agents cannot waive requirements or authorize their own exceptions. Before changing requirements or recording a decision, follow the [decision authority and documentation completion rules](docs/agents/domain.md#decision-authority).
- Open pull requests ready for review.

## Reading pointers

Before exploring, planning, implementing or reviewing work, read the sources for each area it touches:

- **Domain behavior**, including behavior specified in documentation: `GLOSSARY.md`, then the relevant topic page and ADRs found through `docs/agents/domain.md`.
- **Code**, including generators and generated bindings: all of `CODING_STANDARDS.md`.
- **Behavior or test changes**: `docs/testing-strategy.md`. Identify the applicable required scenarios.
- **API or SDK behavior**: the topic pages and endpoint map indexed in `README.md`.
- **Lifecycle, storage, logs or client synchronization**: `docs/topics/dataset-lifecycle.md` and `docs/adr/0015-separate-start-stop-restart-and-reset.md`.
- **Protocol, generators, module interfaces, storage ownership or shared infrastructure**: `docs/architecture/system-design.md` and its linked decisions.
- **Modernization differences**, when recording or implementing an authorized behavior or design change from Atlas Modernization: update `docs/architecture/modernization-differences.md` as its introduction describes.
- **Issues**, when creating or updating them: follow `docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md`.
