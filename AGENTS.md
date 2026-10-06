## Working together

- Agents cannot waive requirements or authorize their own exceptions. Before changing requirements or recording a decision, follow the [decision authority and documentation completion rules](docs/agents/domain.md#decision-authority).
- Open pull requests ready for review.

## Agent skills

- Before exploring, planning, implementing or reviewing domain behavior, read `GLOSSARY.md` and the relevant ADRs using `docs/agents/domain.md`. This includes behavior specified in documentation.
- Before designing, implementing or reviewing code, including generators and generated bindings, read all of `CODING_STANDARDS.md`.
- When creating or updating issues, follow `docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md`.

## Architecture and lifecycle

Before planning, implementing or reviewing changes to lifecycle, storage, logs or client synchronization, read `docs/topics/dataset-lifecycle.md` and `docs/adr/0015-separate-start-stop-restart-and-reset.md`. They define Restart retention, Reset cleanup and the field-use boundary. Backup/restore and version-to-version operational-data migrations are excluded.

Before planning, implementing or reviewing changes to Protocol, generators, module interfaces, storage ownership or shared infrastructure, read `docs/architecture/system-design.md` and its linked decisions.

Before planning, implementing or reviewing behavior changes, read `docs/testing-strategy.md` and identify the applicable required scenarios. Read it before planning, adding, changing or reviewing tests too. Before planning, implementing or reviewing API and SDK behavior, use the topic pages and endpoint map indexed in `README.md`.

When recording or implementing an authorized behavior or design change from Atlas Modernization, update `docs/architecture/modernization-differences.md` with baseline evidence and a link to the successor decision. Distinguish confirmed differences, carried-forward behavior and proposals.
