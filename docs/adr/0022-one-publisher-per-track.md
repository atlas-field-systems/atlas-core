---
status: accepted
---

# Give each Track one publisher for observed data

Accepted on 28 September 2026 when the user approved the first documentation grilling round. Each Track has one publisher responsible for its observed data. Different publishers describing the same subject create separate Tracks. Core does not automatically combine their observations or choose which publisher is correct.

A Plugin may deliberately combine observations from several Tracks and publish a separate Track for the combined result. It is the publisher of that result. This keeps interpretation with the integration that understands the observations, at the cost of potentially showing several Tracks for one real subject until an integration combines them.

Entities records the Track's publisher and enforces that boundary on every path that can write its observed fields. Ordinary descriptive edits, such as an operator changing an alias, remain separate and follow the [concurrent-edit contract](../architecture/system-design.md#concurrent-descriptive-edits). A descriptive edit cannot replace publisher-owned observations. Broad operational reads and Plugin Task issuance remain supported; permission to read another publisher's Track does not grant authorship of its observations. This is an ownership rule, not a new component extension system or a separate observation service.

Protocol must distinguish observed fields from operator-managed fields. Publisher identity encoding, authentication/binding and report ordering remain contract work. The later grilling rounds settle continuity, observation age, corrections and the initial exclusion of publisher transfers below. Removing a Plugin does not itself delete its published Tracks under the [uninstall contract](0021-manage-plugin-operational-storage-through-reset.md#uninstall-and-reinstall).

## Publisher continuity

Accepted on 28 September 2026 in response to Q5. Within the same Dataset, the same authenticated publisher may supply fresh observations to its existing Tracks after Plugin uninstall and reinstall. Core retains enough publisher association with those Tracks to distinguish continuity from another source taking over. Reinstalling under the same display name alone is not proof of publisher identity; the authentication and local provisioning mechanism remain engineering work.

The [uninstall contract](0021-manage-plugin-operational-storage-through-reset.md#uninstall-and-reinstall) still clears Plugin-owned setup and private work, including usable credentials. Continuity does not restore revoked credentials, recover an old private queue or rerun an Operation. Reprovision access for the verified publisher through authorized local management. A different publisher creates its own Tracks. Reset's new Dataset does not inherit old observations or permit old submissions to be relabeled.

## Observation age

Accepted on 28 September 2026 in response to Q8. When a Track stops receiving observations, Core retains its last-known data and exposes the observation time or age. Silence alone does not delete it. Descriptive edits, Plugin restart or reinstall, and client resynchronization do not make old observations appear current. An authorized explicit deletion still obeys [required-reference protection](0023-protect-required-entity-references-during-tasks.md).

Unknown observation time stays explicitly unknown; Core receipt time can be exposed separately but cannot be presented as the time of observation. Exact timestamp fields and clock handling remain contract work. This decision selects no automatic Track expiry or universal stale-after interval.

## Track data used by Commands

Accepted on 28 September 2026 when the user approved Q12. Core imposes no universal age cutoff for executing Tasks against Track observations. Commands that require current observations define the acceptable age and behavior when data becomes too old. Commands intended to use last-known positions may continue. Their contract must address unknown observation time without treating receipt time as proof of freshness.

Core preserves the observation and exposes its age or unknown-time condition. The Asset applies the Command's rule; Core does not infer a Task failure, pause or physical stop from Track silence. Exact thresholds and stale-data responses belong to each Protocol-defined Command, with execution owned by the Asset OS. This does not add user-configurable global expiry or a Plugin-defined Command extension mechanism.

## Correcting current observations

Accepted on 28 September 2026 when the user approved Q13. The Track's authenticated publisher may correct its current observed value through ordinary updates. Preserve the actual observation time, including an explicitly unknown time. A correction's later submission or receipt does not make the observation fresh, and a correction to an older observation cannot overwrite a newer one. This permits recovery from a bad current value without rewriting the record of what was reported.

Retain previously recorded movement samples under the [append-only history contract](../architecture/system-design.md#movement-history). An accepted correction containing movement quantities adds a sample through ordinary ingestion; it does not replace the original sample. History-only backfill and manual historical sample editing remain deferred. Descriptive editors and other publishers cannot use a correction to bypass observed-field ownership. Exact report identity, ordering and correction correlation remain Protocol work; no separate correction endpoint or historical-edit workflow is introduced.

## Publisher transfers

Accepted on 28 September 2026 when the user approved Q14. Publisher transfer is outside the initial scope, including an operator-directed transfer. A different publisher creates a separate Track. Silence, uninstall, matching names or aging observations do not transfer authority over the existing Track. Verified continuity by the same publisher after reinstall remains supported under the rule above.

Existing Tasks keep their original Track references and are not automatically retargeted to the replacement publisher's Track. Changing the target requires a new Task under the immutable-input contract; it does not cancel or establish an outcome for the original Task. Required-reference deletion protection still applies. Deliberate Plugin fusion remains separate and publishes its own Track. Any future transfer workflow requires a successor decision rather than an exception to this ownership rule.

The [testing strategy](../testing-strategy.md#required-scenario-coverage) requires independent publishers, rejected cross-publisher updates and transfers, separate descriptive edits, an explicit Plugin-produced combined Track, authenticated same-publisher continuity, corrections that preserve age and history without replacing newer observations, retained silent Tracks, and Command-specific use of current versus last-known data. These are implementation requirements, not executed tests.
