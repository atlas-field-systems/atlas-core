Agents cannot waive requirements or authorize their own exceptions. Before changing requirements or recording a decision, follow the [decision authority and documentation completion rules](docs/agents/domain.md#decision-authority).

Answer exploratory questions without changing files. Treat clear requests for action as authorization to complete the work. Open pull requests only when explicitly requested, ready for review. Merge only when explicitly authorized.

Before implementing a substantial new visual direction, present distinct static mocks and wait for the user's choice. Once approved, implement it without reopening routine layout, copy or consistency decisions.

Before exploring, planning, implementing or reviewing work, read the sources for every branch it touches:

- **Behavior, design or documentation**, including behavior specified in documentation: `GLOSSARY.md`, then the sources that the table in `docs/agents/domain.md` assigns to the work.
- **Code**, including generators and generated bindings: all of `CODING_STANDARDS.md`.
- **Behavior or test changes**: `docs/testing-strategy.md`. Identify the applicable required scenarios.
- **Issues**, when creating or updating them: `docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md`.
