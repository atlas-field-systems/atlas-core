## Agent skills

### Issue tracker

Issues are tracked in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical triage labels are used. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single-context domain-doc layout. See `docs/agents/domain.md`.

## Runtime data

Start, Stop and Restart preserve operational data and logs. Reset clears Atlas-owned operational records, Object content, activity history, transfer state and diagnostic logs while preserving installed Plugin selections, credentials, configuration, software and Plugin artifacts. Field use is set up Core, connect Assets, then run the mission with Core continuously available. Restart and Reset are primarily development actions outside missions; active mission continuity across Core restart is outside scope. Read `docs/adr/0015-separate-start-stop-restart-and-reset.md` before changing lifecycle, storage, logs or client synchronization. Retaining records does not authorize automatic rerun of work. Backup and restore functionality is excluded. Updating Core to a new release performs Reset; ordinary same-release restarts preserve state. Do not add version-to-version operational-data migrations.

## Architecture differences

When accepting or implementing a behavior or design change from Atlas Modernization, update `docs/architecture/modernization-differences.md` with the baseline evidence and successor decision. Keep each confirmed difference in its table; distinguish carried-forward behavior and unresolved proposals.

## Generation and module design

Before changing Protocol, generators, module interfaces, storage ownership or shared infrastructure, read `docs/architecture/system-design.md` and its linked decisions.

- Author shared contract facts in Protocol and regenerate their representations. Generated files are disposable: never hand-edit or post-process them. Keep business implementations in separate files behind generated interfaces.
- Prefer supported generator output and a small configuration. Avoid endpoint-specific templates, duplicate wrapper APIs and patches that recreate the maintenance removed by generation. If a required case does not fit, simplify the contract/tool choice or keep that binding handwritten; explain the tradeoff before expanding generator machinery.
- Build dedicated Atlas responsibilities with ordinary module interfaces and private data access. Share utilities for concrete needs; do not design a reusable framework or module replacement system.
- Test the promises independently of the generator: cross-language wire examples, public module behavior, operational consistency, Stop/Start and Restart retention, Reset cleanup and supported compatibility. Generated snapshots alone do not establish correctness. Require deterministic regeneration and focused integration tests.
- External operational API consumers use the SDK. Local CLI/TUI administration uses internal management interfaces; Plugin installation/configuration and process lifecycle controls are excluded from the public API and SDK. Basic API access must not require full-picture synchronization. Keep physical Object storage private and execution scheduling on the Asset OS.
- Measure simplicity by independently maintained decisions and effort to change Atlas behavior. Prefer one working implementation and remove superseded code after verification.
