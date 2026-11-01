# Asset messages

> Retained current design for review. [Planning status](../../../../README.md#planning-status).

One Asset view, with one message for updating its writable sections.
Creation includes enrollment and process facts. A telemetry-only tracker can
advertise no Commands.

## Messages

| Message | Expected user and purpose | Input | Observable result |
| --- | --- | --- | --- |
| `RegisterAsset` | Asset runtime or provisioning tool enrolls a camera, aircraft, or tracker | Initial Asset description, capability manifest, process generation, caller-prepared credential facts, and stable registration and request IDs | Registered identity and current Asset under [enrollment rules](../../support/identity.md#enrollment-and-credentials) |
| `ListAssets` | Operator app browses or searches available Assets | Bounded filters | Matching Asset views |
| `GetAsset` | Operator app or integration inspects a known Asset | Asset ID | Current Asset view |
| `GetAssetByAlias` | Integration resolves a configured alias to an Asset | Asset alias | Matching Asset view |
| `UpdateAsset` | Operator app, provisioning tool, or Asset runtime replaces complete writable Asset sections | Asset ID, complete writable sections, retry identity, and applicable [revision and source-evidence conditions](../structure.md#data-ownership) | Committed Asset view and evidence disposition, or an explicit refusal |
| `DeleteAsset` | Operator app removes an Asset that is no longer needed | Asset ID and retry identity | Removed Asset under [deletion rules](../../support/identity.md#deletion-and-revocation) |
| `GetAssetStatus` | Operator app displays reported status alongside Core-derived contact information | Asset ID | Current status and derived contact information |
| `GetAssetMovementHistory` | Operator app or analysis tool reviews where an Asset has been | Asset ID and [bounded history query](../history/queries.md) | Frozen pages of retained positions |
| `GetAssetObjects` | Operator app finds images or other files associated with an Asset | Asset ID and bounded query | Associated Object metadata |

`RegisterAsset` creates the Asset with enrollment effects. It does not establish contact.
Movement queries return [append-only positions](../history/positions.md) through HTTP in both SDK modes.
To inspect an Asset's detections, use [Observation reads](../observations/messages.md#reads-and-evidence)
filtered by their recorded source Asset attribution.

## Updating sections

An operator app can replace a description. A camera runtime can replace its gimbal
section. Both use `UpdateAsset`. Status is part of the Asset JSON. Core-derived
contact fields remain read-only under [Entity rules](../structure.md#data-ownership).

Supply the sections you intend to replace under the [update rules](../reporting/reports.md#shared-context).
Each section keeps its applicable revision, source evidence, and ordering rules.
The [component reference](../components/README.md) lists descriptions and reported data.
Contact uses `BeginAssetContact` and `ReplaceAssetProcess` under the exact
[challenge and replacement contract](contact.md). `UpdateAsset` carries current
check-in proof through the shared report envelope.

[Task messages](../../tasks/messages.md#assigned-work) define assigned work, queue ordering, and
adoption confirmations.

[Messaging index](../../shared/messages.md)

## Concrete request and result fields

Registration requires asset_id, registration_id, request_id, process_generation,
api_key_id, secret; optional alias, description, type, capabilities use Entity
authored values. Its data is `{asset, api_key}` with secret-free key metadata.
Update requires asset_id and request_id, optional alias, description, type,
capabilities, report, and expected_edit_revision. An authored field requires the
revision precondition. Alias and description allow null clearing. At least one
authored field or report is required. Report identity must match the Asset.
Update and process replacement data is `{asset, evidence_disposition?}`; a report
requires accepted or duplicate disposition. GetAssetStatus data is exactly
`{asset_id, status, communications, heartbeat}` using the Asset read components.
Single reads and deletes use asset_id; alias lookup uses alias. Object queries
add asset_id to the [list selection](../../shared/queries.md), or use only page_token.
