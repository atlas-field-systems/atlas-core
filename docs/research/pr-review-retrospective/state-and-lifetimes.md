# State and lifetimes

Proposal only. Priority: high. These procedures apply existing ownership, commit and recovery requirements.

## Evidence

| Finding | Consequence | Source |
| --- | --- | --- |
| Cancellation was checked before retaining the ID of a created Task | A committed effect escaped cleanup bookkeeping | [Modernization #224](https://github.com/the-Drunken-coder/Atlas-Modernization/pull/224#discussion_r3818482349) |
| A late cancellation request overrode successful update completion | Reported cancellation contradicted the actual effect | [Modernization #428](https://github.com/the-Drunken-coder/Atlas-Modernization/pull/428#discussion_r4014075021), [confirmed response](https://github.com/the-Drunken-coder/Atlas-Modernization/pull/428#discussion_r4016475361) |
| A cleanup decision preceded the lock and survived a competing Start | Stop reported success while new resources remained alive | [meshtastic-lab #1](https://github.com/the-Drunken-coder/meshtastic-lab/pull/1#discussion_r3922219292), [confirmed response](https://github.com/the-Drunken-coder/meshtastic-lab/pull/1#discussion_r3922273136) |
| One failed parallel start triggered cleanup before sibling starts settled | Remaining creators reopened resources after cleanup | [meshtastic-lab #1](https://github.com/the-Drunken-coder/meshtastic-lab/pull/1#discussion_r3921403275), [confirmed response](https://github.com/the-Drunken-coder/meshtastic-lab/pull/1#discussion_r3921540653) |
| Cleanup recovery checked liveness separately from deletion and writers | A newly live file could be removed | [Modernization #196](https://github.com/the-Drunken-coder/Atlas-Modernization/pull/196#discussion_r3707294163), [real-storage regression response](https://github.com/the-Drunken-coder/Atlas-Modernization/pull/196#discussion_r3707571985) |
| Fixture readiness awaited outside the cleanup guard | Startup failure leaked the process and its private storage | [Atlas Core #93](https://github.com/atlas-field-systems/atlas-core/pull/93#discussion_r4172153077) |
| An artifact lock was released while descendants could still write | A second run could collide with surviving work | [private_017 #37, comment 4129876842](evidence/result-summary.json), [private_017 #37, comment 4129968031](evidence/result-summary.json) |
| Cleanup threw from a finalizer | A secondary failure replaced the original workflow error | [Atlas Core #101](https://github.com/atlas-field-systems/atlas-core/pull/101#discussion_r4175233368) |

## Existing coverage

[Structure and interfaces](../../agents/code-conventions.md#structure-and-interfaces) already requires explicit transaction and lifetime ownership. [State/error conventions](../../agents/code-conventions.md#state-errors-and-background-work) requires honest outcomes and recovery. The review paragraph already requires a surviving cleanup owner, and the recurring-defect section requires preserving both failures.

[Write commits](../../architecture/system-design.md#write-commits), [retry identity](../../architecture/system-design.md#retry-identity), [Dataset lifecycle](../../topics/dataset-lifecycle.md) and [SDK mutation outcomes](../../topics/sdk.md#mutation-outcomes-and-retries) define the Atlas behavior. Historical fixes are not alternate implementations of those contracts.

## Proposed text

Add this clarification to the state section:

> Revalidate the facts required for a mutation after callbacks, asynchronous waits or lock acquisition can invalidate them. Record irreversible effects before honoring later cancellation. Report outcomes from authoritative results; a cancellation request alone does not prove an effect was prevented.

Move the lifetime portion of the dense review paragraph into the proposed `docs/agents/background-work.md`, with two conditional procedures.

For stateful or cancellable operations:

1. Identify the admission decision, irreversible point and authoritative result. Check failures before and after that point.
2. Identify callbacks and waits that can invalidate authority, Dataset, revision or ownership facts. Verify the final decision uses current facts under the existing serialization mechanism.
3. Exercise both relevant orders of competing writes and cleanup, including a request that passed preflight before waiting.
4. Walk the operation's documented retry identity and original facts through the relevant first, replay, conflict and ended cases. Link to its owning contract rather than inventing a common identity tuple.
5. Pause a relevant completion, stop or replace its owner, then allow completion. Preserve actual committed evidence while preventing obsolete work from publishing new state or starting new work.

For background resources:

1. Name the owner before acquiring the resource. Include startup/readiness failure in its cleanup responsibility.
2. Name the owner that survives caller, worker and observer exit. Check nested fixtures and descendants when those resources can outlive their creator.
3. Settle or cancel and await pending creators before removing their resources.
4. Keep cleanup decisions valid through destruction. Establish that the target still belongs to the operation under the supported storage/lifecycle boundary.
5. Attempt each independent cleanup even when another fails. Preserve dependency gates: if a writer cannot be stopped and verified, leave its storage cleanup incomplete. Preserve the original failure together with cleanup failures.
6. Verify observable termination and owned-resource removal before reporting cleanup success. Exercise the actual process, storage or transport boundary implicated by the defect.

## Adoption criteria

The procedures require judgment, not a mandatory generation-token pattern, global coordinator or filesystem mechanism. Select the smallest mechanism consistent with the accepted owner and workload.

Atlas Plugin Operations intentionally survive invoking-client disconnection. [ADR-0018](../../adr/0018-confirm-writes-when-core-commits.md) keeps write responses out of the Local operational picture. The procedure must preserve both facts; copying historical cancellation or response-cache fixes would change current requirements.

Keep required recovery scenarios in the testing strategy. Pair review of cleanup calls that can fail with the narrower [unsafe-finalizer check](automated-checks.md#unsafe-finalizers).
