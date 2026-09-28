---
status: accepted
---

# Retire Assets without inventing Task outcomes

Accepted on 27 September 2026 after the deep-module review. Administrative retirement must remain possible when an Asset is permanently unavailable and cannot confirm its outstanding work. This is a design decision, not implemented behavior. The exact HTTP binding, SDK signature and record fields remain engineering work.

## Context and rationale

The inherited deletion guard refuses to remove an Entity with nonterminal Tasks. In the inspected Modernization revision, cancellation could make a Task terminal without establishing a physical stop. The successor correctly requires assigned-Asset confirmation, but retaining deletion as the only decommissioning workflow leaves a lost Asset with unresolved work impossible to retire through that workflow. See the pinned [deletion guard](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/actions/entity_actions.go#L537-L548), [earlier cancellation semantics](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/commands-and-tasking.md), and the successor's [confirmed-cancellation contract](0007-reconcile-asset-tasks-after-disconnection.md#task-transitions).

Administrative authority over participation and evidence about physical execution are different facts. Keep their distinction inside the owning workflow instead of requiring the caller to revoke keys, block assignment and preserve records separately.

## Decision

Provide one explicit operator-requested retirement operation through the SDK and Core. It remains available when the Asset is disconnected or has nonterminal Tasks. It atomically records administrative retirement, blocks new Task assignments and credential provisioning for that identity, revokes all bound credentials, records the attributed action and publishes the Entity change. The existing [revocation cut-off](../architecture/system-design.md#credential-revocation) applies to requests and live feeds.

Retirement retains the Entity and its identity, Task assignments, histories, Object associations and required-result protection. It is neither a Task nor an Asset-reported operational status, and it does not add an Entity kind or Task lifecycle state. Expose the administrative condition separately from last reported operational state and execution uncertainty. It is not a generic component patch or a way for an operator to impersonate Asset reporting. Existing operator authority permits retirement; Asset, Plugin and gateway identities do not acquire this administrative capability.

Retirement itself never marks a Task completed, failed or cancelled, confirms a pending cancellation, resumes a queue or claims that physical execution stopped. Preserve terminal outcomes and unresolved execution facts under ADR-0007. An already-accepted completion report may still resolve under [ADR-0008](0008-complete-scan-tasks-when-required-results-are-available.md) when its required Objects arrive through an authorized upload; that is the existing evidence-based completion rule, not an outcome inferred from retirement. Retirement does not release Object holds.

Retirement also does not release [required Entity-reference protection](0023-protect-required-entity-references-during-tasks.md). An unresolved Task can keep a required Track or Geofeature protected after its assigned Asset is retired or disconnected; only a terminal Task outcome releases that Entity guard. Required Object holds remain protected until Reset under [ADR-0009](0009-expose-objects-only-when-ready.md), independently of that terminal release.

Keep ordinary Entity deletion and its nonterminal-Task guard unchanged. Retirement is the way to withdraw participation without deleting the execution context. This supersedes the earlier claim that Asset deletion alone suffices for decommissioning; it does not authorize force deletion or forced terminal outcomes. No installation Reset is needed to retire one Asset, and unrelated Assets continue operating.

## One workflow owner

Entities owns retirement admission and commit coordination behind one domain operation, using the existing concrete [write commit](../architecture/system-design.md#write-commits). Identity and access owns the retained authorization decision, credential revocation and its enforcement; Tasks preserves execution semantics and checks retirement when accepting new assignments; Synchronization distributes the committed Entity representation and enforces connection cut-off. Collaborators keep their private data and domain decisions.

The transport adapter and SDK submit the one operation and expose its result. Neither they nor application code assemble a sequence of lower-level calls. This adds no retirement service, generic workflow engine, transaction framework or public API-versus-picture split. The [unified SDK modes](../sdk-data-access.md#agreed-modes) and [commit-first write policy](0018-confirm-writes-when-core-commits.md) still apply: returning retirement success confirms Core's commit, not physical stopping or immediate local-picture convergence.

## Concurrency, retries and retained authority

Serialize retirement with assignment, provisioning, registration, deletion, report acceptance and Object publication authorization. Assignment-first retains the accepted Task and still allows retirement; retirement-first rejects the new assignment. An authorized report committed first remains evidence. Retirement-first prevents a later request under the revoked Asset authority from changing recorded state. A competing provisioning or enrollment request cannot leave a usable credential after retirement commits. Use the shared authorization and transaction boundaries rather than a handler-only check.

Retirement requires an existing, nonretired Asset. A new request identity targeting an already-retired Asset returns an explicit already-retired error without changing state, recording a successful retry claim or adding activity. Concurrent fresh retirement requests therefore produce one retirement and one already-retired rejection. Check an existing matching retry claim before this admission rule, so a retry of the successful request still returns its recorded result.

Serialize ordinary deletion and retirement in the same commit boundary. Retirement-first leaves its installation-scoped denial intact even if an allowed deletion subsequently removes the Entity. Deletion-first makes a fresh retirement request return not found without creating a denial, successful claim or activity; a retained identity reservation is not an existing Asset. The nonterminal-Task deletion guard remains unchanged.

An Asset-authenticated upload must recheck its authority inside the short Object publication transaction, serialized with retirement. Publication-first preserves the ready Object and any evidence-based completion it permits. Retirement-first rejects publication under the revoked credential, creates no ready Object or successful upload identity, and cleans up the abandoned attempt under [ADR-0009](0009-expose-objects-only-when-ready.md#publication-and-recovery-ordering). File streaming or durable private content alone does not establish publication. An unaffected authorized principal may retry the whole upload under the existing upload identity/content rules; this does not restore Asset authority or invent execution evidence.

An authorized matching retry in the same Dataset returns the recorded retired result without repeating the action, adding another activity entry or reactivating access. If ordinary deletion has since removed the Entity, return the explicit deleted-result outcome instead. Rejected requests have no partial effect. Dataset changes reject obsolete submissions rather than turning them into retirement requests against a new Dataset. Use the shared [retry identity contract](../architecture/system-design.md#retry-identity), including its Dataset-scoped retirement claim, original request facts and First, Replay, Conflict and Ended outcomes. Concrete retry and response encodings remain schema work.

The retained Entity condition survives same-release Restart. Keep the decommissioned authorization decision with the installation-scoped Asset binding, so ordinary Reset clears the old Dataset but does not reauthorize that identity or permit automatic re-enrollment. This follows [ADR-0015's rule that revocation is permanent until Hard Reset](0015-separate-start-stop-restart-and-reset.md#retained-asset-identity-after-reset): after Reset, reject registration for the retired Asset ID even when the same bound principal proves its identity and supplies enrollment authorization, the new Dataset and a fresh request identity. Open enrollment does not change this. That rejection creates no Entity or usable credential. Hard Reset retains its existing destructive scope. A delayed report, hello, upload retry or surviving credential must not reactivate the Asset. Reactivation and admission of new execution evidence from a recovered retired device require a separate explicit policy; this decision supplies neither an automatic recovery path nor an operator-forced outcome.

## Required implementation evidence

Extend the real SDK–Core workflows under the [testing strategy](../testing-strategy.md); these are requirements, not executed tests:

| Scenario | Required outcome |
| --- | --- |
| Permanently disconnected Asset with outstanding work | One retirement request succeeds without Reset; participation ends while unresolved Tasks, identity, history and protected results remain inspectable |
| Fresh request for an already-retired Asset | Explicit already-retired error, including concurrent requests with different identities; one retirement action, no extra successful claim or activity; a matching retry of the successful request still replays |
| Deletion race | Retirement-first preserves the denial after allowed deletion; deletion-first rejects fresh retirement as not found without a denial or activity |
| In-flight upload publication | Publication-first retains its committed result; retirement-first rejects revoked-authority publication and cleans abandoned content without releasing holds; an unaffected authorized principal can retry under ordinary upload rules |
| Assignment race | Assignment-first keeps its Task and retirement succeeds; retirement-first rejects assignment; neither ordering fabricates execution facts |
| Reports, enrollment and provisioning races | Preserve effects committed before retirement; no revoked-authority report or usable replacement credential bypasses the committed retirement |
| Lost response, concurrent retry and Restart | One retired result and attributed action; no duplicated effects or reactivation; unrelated Assets remain available |
| Conflicting and ended retries | Reusing a retirement identity with another target or changed original parameters conflicts; retry after allowed Entity deletion returns deleted-result without resurrection |
| Fresh registration after Reset | Reject the retired Asset ID even with proof of the same principal, current enrollment authorization, a new Dataset and a new registration identity; create no Entity or credential |
| Open feeds and SDK modes | Enforce the revocation cut-off; authorized observers receive the Entity change through the ordinary synchronization path; commit-first return does not mutate a local picture |
| Results and Dataset boundaries | Existing required-result holds survive; required Track/Geofeature references remain protected while their Tasks are unfinished; valid pre-retirement completion evidence can resolve when results arrive; Reset rejects obsolete requests without reauthorizing the retired identity |

These cases supplement rather than replace ordinary deletion tests. Do not demonstrate progress by weakening the deletion guard or by manufacturing a terminal Task state.
