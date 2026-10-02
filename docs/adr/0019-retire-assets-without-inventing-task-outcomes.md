---
status: accepted
---

# Retire Assets without inventing Task outcomes

Accepted on 27 September 2026 after the deep-module review. Administrative retirement must remain possible when an Asset is permanently unavailable and cannot confirm its outstanding work. This is a design decision, not implemented behavior.

Current rules: [Identity and access](../topics/identity-and-access.md#asset-retirement).

## Context and rationale

The inherited deletion guard refuses to remove an Entity with nonterminal Tasks. In the inspected Modernization revision, cancellation could make a Task terminal without establishing a physical stop. The successor correctly requires assigned-Asset confirmation, but retaining deletion as the only decommissioning workflow leaves a lost Asset with unresolved work impossible to retire through that workflow. See the pinned [deletion guard](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/actions/entity_actions.go#L537-L548), [earlier cancellation semantics](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/commands-and-tasking.md), and the successor's [confirmed-cancellation contract](../topics/tasks.md#cancellation-requests).

Administrative authority over participation and evidence about physical execution are different facts. Keep their distinction inside the owning workflow instead of requiring the caller to revoke keys, block assignment and preserve records separately.

## Decision

Provide one explicit operator-requested retirement operation through the SDK and Core. It remains available when the Asset is disconnected or has nonterminal Tasks. In one commit it withdraws the Asset's participation: it blocks new Task assignments and credential provisioning, revokes bound access, records the attributed action and publishes the Entity change. It retains the Entity and its identity, Task assignments, histories, Object associations and protections.

Retirement is an administrative condition, separate from Asset-reported operational status and the Task lifecycle. It never establishes a Task outcome or claims that physical execution stopped. Its denial is kept with the installation-scoped Asset binding, so ordinary Reset does not reauthorize a retired identity.

Keep ordinary Entity deletion and its nonterminal-Task guard unchanged. Retirement is the way to withdraw participation without deleting the execution context. This supersedes the earlier claim that Asset deletion alone suffices for decommissioning; it does not authorize force deletion or forced terminal outcomes.

## Alternatives rejected

- Weakening the deletion guard or manufacturing a terminal Task state would let a lost Asset be removed by fabricating execution evidence.
- Requiring callers to revoke keys, block assignment and preserve records separately would push the distinction between administrative authority and execution evidence onto every caller.
- A retirement service, generic workflow engine, transaction framework or public API-versus-picture split adds machinery that one domain operation does not need.

## Consequences

Entities owns retirement admission and commit coordination behind one domain operation, using the existing concrete [write commit](../architecture/system-design.md#write-commits). Identity and access owns the retained authorization decision, credential revocation and its enforcement; Tasks preserves execution semantics and checks retirement when accepting new assignments; Synchronization distributes the committed Entity representation and enforces connection cut-off. Collaborators keep their private data and domain decisions. The transport adapter and SDK submit the one operation and expose its result.

Retirement must be serialized with the assignment, provisioning, registration, deletion, report and upload paths it competes with, and retried under the shared [retry identity](../architecture/system-design.md#retry-identity) contract. The [unified SDK modes](../topics/sdk.md#modes) and [commit-first write policy](0018-confirm-writes-when-core-commits.md) still apply. Recovering a retired device needs a separate explicit policy; this decision supplies neither an automatic recovery path nor an operator-forced outcome. The exact HTTP binding, SDK signature and record fields remain engineering work.

The [testing strategy](../testing-strategy.md#required-scenario-coverage) lists the required workflow evidence. It supplements ordinary deletion tests; progress must not be demonstrated by weakening the deletion guard or by manufacturing a terminal Task state.
