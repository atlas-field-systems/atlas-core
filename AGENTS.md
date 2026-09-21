## Agent skills

- Before exploring or changing domain behavior, read `CONTEXT.md` and the relevant ADRs using `docs/agents/domain.md`.
- When creating or updating issues, follow `docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md`.

## Architecture and lifecycle

Before changing lifecycle, storage, logs or client synchronization, read `docs/adr/0015-separate-start-stop-restart-and-reset.md`. It defines Restart retention, Reset cleanup and the field-use boundary. Backup/restore and version-to-version operational-data migrations are excluded.

Before changing Protocol, generators, module interfaces, storage ownership or shared infrastructure, read `docs/architecture/system-design.md` and its linked decisions. Build dedicated Atlas responsibilities with ordinary interfaces and private data access; share utilities for concrete needs.

When accepting or implementing a behavior or design change from Atlas Modernization, update `docs/architecture/modernization-differences.md` with baseline evidence and a link to the successor decision. Distinguish confirmed differences, carried-forward behavior and proposals.

## Generation guardrails

- Author shared contract facts in Protocol and regenerate their representations. Generated files are disposable: never hand-edit or post-process them. Keep business implementations in separate files behind generated interfaces.
- Prefer supported generator output and a small configuration. Avoid endpoint-specific templates, duplicate wrapper APIs and patches that recreate the maintenance removed by generation. If a required case does not fit, simplify the contract/tool choice or keep that binding handwritten; explain the tradeoff before expanding generator machinery.
- Test the promises independently of the generator using wire examples, public behavior and focused integration tests. Require deterministic regeneration; generated snapshots alone do not establish correctness. See `docs/architecture/system-design.md#generation-and-testing` for the validation scope.
