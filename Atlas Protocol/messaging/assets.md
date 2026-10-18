# Asset messages

One Asset view, with one message for updating its writable sections.
Creation includes enrollment and process facts. A telemetry-only tracker can
advertise no Commands.

## Messages

| Proposed message | Expected user and purpose | Input | Observable result |
| --- | --- | --- | --- |
| `RegisterAsset` | Asset runtime or provisioning tool enrolls a camera, aircraft, or tracker | Initial Asset description, capability manifest, process generation, caller-prepared credential facts, and stable registration and request IDs | Registered identity and current Asset under [enrollment rules](../identity.md#enrollment-and-credentials) |
| `ListAssets` | Operator app browses or searches available Assets | Bounded filters | Matching Asset views |
| `GetAsset` | Operator app or integration inspects a known Asset | Asset ID | Current Asset view |
| `GetAssetByAlias` | Integration resolves a configured alias to an Asset | Asset alias | Matching Asset view |
| `UpdateAsset` | Operator app, provisioning tool, or Asset runtime replaces complete writable Asset sections | Asset ID, complete writable sections, retry identity, and applicable [revision and source-evidence conditions](../entities.md#data-ownership) | Committed Asset view and evidence disposition, or an explicit refusal |
| `DeleteAsset` | Operator app removes an Asset that is no longer needed | Asset ID and retry identity | Removed Asset under [deletion rules](../identity.md#deletion-and-revocation) |
| `GetAssetStatus` | Operator app displays reported status alongside Core-derived contact information | Asset ID | Current status and derived contact information |
| `GetAssetMovementHistory` | Operator app or analysis tool reviews Asset location evidence | Asset ID and bounded query or continuation token | Frozen pages with a release token under [location query rules](../location-history.md#bounded-history-queries), explicit restart, or resource-limit refusal |
| `ReleaseAssetHistoryView` | Application ends an Asset location query | View release token and Dataset context | Idempotent release acknowledgment; later continuation returns restart |
| `GetAssetObjects` | Operator app finds images or other files associated with an Asset | Asset ID and bounded query | Associated Object metadata |

`RegisterAsset` creates the Asset with enrollment effects. It does not establish contact.
Current HTTP Asset views remain expanded. The history operation has the same query
contract in both SDK modes under [location history](../location-history.md).

## Updating sections

An operator app can replace a description. A camera runtime can replace its gimbal
section. Both use `UpdateAsset`. Status is part of the Asset JSON. Core-derived
contact fields remain read-only under [Entity rules](../entities.md#data-ownership).

Supply the sections you intend to replace under the [update rules](../reports.md#shared-context).
Each section keeps its applicable revision, source evidence, and ordering rules.
The [component reference](../components/README.md) lists descriptions and reported data.
Concrete contact-challenge and process-replacement messages remain unspecified.

[Task messages](tasks.md#assigned-work) define assigned work, queue ordering, and
adoption confirmations.

[Messaging index](../messaging.md)
