## Agent skills

### Issue tracker

Issues are tracked in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical triage labels are used. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single-context domain-doc layout. See `docs/agents/domain.md`.

## Runtime data

Every Core start begins a clean run: restart wipes operational state, including Object content and activity history. Preserve installed Plugin selections, credentials and configuration as startup setup. Read `docs/adr/0013-start-each-core-run-with-empty-data.md` before changing startup, storage or client synchronization. Initialize the current schema from empty storage; do not add data migrations, cross-run retention, backup/restore or a preserve-data restart mode. Core is assumed not to restart while Assets operate. Cross-restart continuation is outside scope; do not add a run-identity/recovery protocol for it without a changed requirement.

## Architecture differences

When accepting or implementing a behavior or design change from Atlas Modernization, update `docs/architecture/modernization-differences.md` with the baseline evidence and successor decision. Keep each confirmed difference in its table; distinguish carried-forward behavior and unresolved proposals.

## Generation and module design

Before changing Protocol, generators, module interfaces, storage ownership or shared infrastructure, read `docs/architecture/system-design.md` and its linked decisions.

- Author shared contract facts in Protocol and regenerate their representations. Generated files are disposable: never hand-edit or post-process them. Keep business implementations in separate files behind generated interfaces.
- Prefer supported generator output and a small configuration. Avoid endpoint-specific templates, duplicate wrapper APIs and patches that recreate the maintenance removed by generation. If a required case does not fit, simplify the contract/tool choice or keep that binding handwritten; explain the tradeoff before expanding generator machinery.
- Build dedicated Atlas responsibilities with ordinary module interfaces and private data access. Share utilities for concrete needs; do not design a reusable framework or module replacement system.
- Test the promises independently of the generator: cross-language wire examples, public module behavior, within-run consistency, clean restart and supported compatibility. Generated snapshots alone do not establish correctness. Require deterministic regeneration and focused integration tests.
- All external consumers should use the SDK; basic API access must not require full-picture synchronization. Keep physical Object storage private and execution scheduling on the Asset OS.
- Measure simplicity by independently maintained decisions and effort to change Atlas behavior. Prefer one working implementation and remove superseded code after verification.
