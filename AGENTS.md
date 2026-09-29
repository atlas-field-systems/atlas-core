## Working together

- Answer exploratory questions without changing files. Treat clear requests for action as authorization to do the work, and complete authorized work without repeatedly asking permission.
- Agents cannot waive requirements or authorize their own exceptions. Before changing requirements or recording a decision, follow the [decision authority and documentation completion rules](docs/agents/domain.md#decision-authority).
- Open a pull request only when explicitly requested, and open it ready for review. Merge only when explicitly authorized.
- Before implementing a substantial new visual direction, present distinct static mocks and wait for the user's choice. Once approved, implement that direction without reopening it for routine layout, copy or consistency fixes.

## Agent skills

- Before exploring, planning, implementing or reviewing domain behavior, read `CONTEXT.md` and the relevant ADRs using `docs/agents/domain.md`. This includes behavior specified in documentation.
- Before designing, implementing or reviewing code, read all of `docs/agents/code-conventions.md` and inspect existing implementations in the area. During review, check every applicable convention and the originating issue or specification separately.
- When creating or updating issues, follow `docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md`.

## Architecture and lifecycle

Before planning, implementing or reviewing changes to lifecycle, storage, logs or client synchronization, read `docs/topics/dataset-lifecycle.md` and `docs/adr/0015-separate-start-stop-restart-and-reset.md`. They define Restart retention, Reset cleanup and the field-use boundary. Backup/restore and version-to-version operational-data migrations are excluded.

Before planning, implementing or reviewing changes to Protocol, generators, module interfaces, storage ownership or shared infrastructure, read `docs/architecture/system-design.md` and its linked decisions.

Before planning, implementing or reviewing behavior changes, read `docs/testing-strategy.md` and identify the applicable required scenarios. Read it before planning, adding, changing or reviewing tests too. Before planning, implementing or reviewing API and SDK behavior, use the API and SDK plans indexed in `README.md`.

When recording or implementing an authorized behavior or design change from Atlas Modernization, update `docs/architecture/modernization-differences.md` with baseline evidence and a link to the successor decision. Distinguish confirmed differences, carried-forward behavior and proposals.

## Generated files

Author shared contract facts in Protocol and regenerate their representations. Never hand-edit or post-process generated files. Before planning, implementing or reviewing generator or binding changes, read [Protocol and generation](docs/agents/code-conventions.md#protocol-and-generation).
