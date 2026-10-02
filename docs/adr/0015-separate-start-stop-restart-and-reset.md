---
status: accepted
---

# Separate Start, Stop, Restart, Reset and Hard Reset

Restart and Reset are primarily development actions. Reset is the usual way to begin fresh; Restart preserves data and diagnostic logs for further development and inspection. Under the [field operating model](../architecture/operating-model.md#field-workflow), Core remains available throughout the Mission, and Restart, Reset and release updates happen outside it. [ADR-0013](0013-start-each-core-run-with-empty-data.md) previously confined data to one Core run.

Current rules: [Dataset lifecycle](../topics/dataset-lifecycle.md).

## Decision

Provide distinct Start, Stop, Restart, Reset and Hard Reset actions. Start, Stop and Restart preserve operational data and logs. Reset clears the Dataset and Atlas-managed diagnostic logs and starts Core with a new Dataset while retaining installation setup, including Operator profiles. Hard Reset is a separate local CLI/TUI action that removes all Atlas-managed state and returns the installation to first-time setup.

Each Dataset has an identifier that Restart retains and Reset changes. Core rejects old-Dataset writes and work submissions while health, authentication and current-Dataset discovery remain available. Reset is Start with a fresh Dataset, recorded by a host directive so an interrupted Reset completes without serving partially cleared state or clearing twice. Before serving retained state, Core classifies unfinished work from the previous Core run without inferring outcomes or rerunning it. Ordinary Start refuses a Dataset written by another Core release, and a new-release update includes Reset. Managed Plugins operate only while Core is running.

Active Mission continuity across a whole-Core restart is excluded. Backup and restore functionality and version-to-version operational-data migrations are excluded. [ADR-0021](0021-manage-plugin-operational-storage-through-reset.md) includes each Plugin's working directory in operational state.

Decision history:

- 21 September 2026: the user revised the lifecycle so that Start, Stop and Restart preserve operational data and logs and Reset clears them. The Dataset boundary was accepted the same day.
- 22 September 2026: the upload simplification replaced the earlier retention of partial transfer bytes and progress until Reset; completed operational data remains retained.
- 23 September 2026: the user accepted a distinct Hard Reset action; ordinary Reset continues to preserve installation setup and Operator profiles. The same day clarified that managed Plugins operate only while Core is running, while independent Plugin start, stop and update with Core running stays supported.
- 26 September 2026: clarified that Reset is Start with a fresh Dataset under a host-recorded directive.
- 28 September 2026: the [Plugin storage decision](0021-manage-plugin-operational-storage-through-reset.md) required completed Plugin work-directory cleanup before fresh opening. The user made re-registration after Reset automatic for an Asset holding a surviving credential, and made revocation by deletion or retirement permanent until Hard Reset.

## Rationale and alternatives

- Retention is bounded by Reset rather than the Core process lifetime, superseding ADR-0013's empty data for each Core run.
- Restart keeps data and diagnostic logs for further development and inspection; Reset remains the usual fresh start.
- An unexpected Core failure is outside the continuity guarantee; the availability assumption does not require fault tolerance or automatic recovery.
- Recording the Reset identity with the fresh Dataset lets an interruption at any point complete the Reset without serving a partially cleared Dataset or clearing it twice.
- Refusing a writing-release mismatch means Start never silently wipes, migrates or reinterprets retained data.

## Consequences

- Retained records preserve evidence and do not authorize automatic resumption or rerun; Asset execution remains the Asset OS's responsibility.
- The SDK must detect a Dataset change and discard old state rather than replay old writes into the new Dataset.
- Hard Reset does not stop physical Assets or recall copies held by external clients; field use still requires the operator to manage those Assets separately.
- Distribution and update packaging, exact wire placement of the Dataset identity, exact CLI spelling, TUI layout and private coordination remain implementation work.

## Retained Asset identity after Reset

Asset ID bindings, credentials and revocations after Reset are specified in [Identity and access](../topics/identity-and-access.md#retained-asset-identity-after-reset).
