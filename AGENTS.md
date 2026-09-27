## Agent skills

- Before exploring or changing domain behavior, read `CONTEXT.md` and the relevant ADRs using `docs/agents/domain.md`.
- Before writing code, read the relevant sections of `docs/agents/code-conventions.md` and inspect existing implementations in the area. During review, check every applicable convention and the originating issue or specification separately.
- When creating or updating issues, follow `docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md`.

## Architecture and lifecycle

Before changing lifecycle, storage, logs or client synchronization, read `docs/adr/0015-separate-start-stop-restart-and-reset.md`. It defines Restart retention, Reset cleanup and the field-use boundary. Backup/restore and version-to-version operational-data migrations are excluded.

Before changing Protocol, generators, module interfaces, storage ownership or shared infrastructure, read `docs/architecture/system-design.md` and its linked decisions.

Before planning, adding, changing or reviewing tests, read the workflow-first policy and applicable coverage in `docs/testing-strategy.md`. Before implementation or review of API and SDK behavior, use the API and SDK plans indexed in `README.md`.

When accepting or implementing a behavior or design change from Atlas Modernization, update `docs/architecture/modernization-differences.md` with baseline evidence and a link to the successor decision. Distinguish confirmed differences, carried-forward behavior and proposals.

## Generated files

Author shared contract facts in Protocol and regenerate their representations. Never hand-edit or post-process generated files. Read the generation conventions before changing generators or bindings.
