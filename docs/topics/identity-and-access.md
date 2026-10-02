# Identity and access

This page owns who can call Atlas Core and what each caller may do: Enrollment and Asset registration, retained Asset identity across Reset, credentials and their revocation, and how Asset deletion and retirement withdraw access.

## Callers and permissions

Every authenticated SDK client, including an Asset, Plugin or gateway, may read all operational data through the public API. That covers full-picture snapshots, feed delivery and replay as well as individual resource, Object and Operation reads. Each client authenticates these reads and synchronization connections with its own caller credentials; Asset, Plugin and gateway identities do not require an operator administrative API key. There are no per-Asset or per-Plugin read filters. Clients still choose basic API access or opt-in synchronization; permission to see everything does not require downloading everything. Health and documentation routes also require authentication.

Authentication resolves a stable principal kind (operator client, Asset, managed Plugin or gateway) and, for an Asset, its bound Asset ID. There are no operator roles, permission tiers or view-only accounts. All authenticated operators have full control within the execution-report, [Track-publisher](tracks-and-geofeatures.md#one-publisher-per-track) and local-administration boundaries below. Operator profiles are names and settings, not permission roles. The proposed additional caller-scoped Operation retry and upload-handle ownership rules are not adopted; submission identity keeps its existing Dataset scope.

SDK method availability does not grant permission, and a route's expected caller does not either. Core enforces authorization at the API boundary. Plugin installation and configuration and Core and Plugin process lifecycle are [local CLI/TUI controls](plugins.md#local-administration), absent from the public API and SDK.

### Operator clients

Operator administrative clients may manage the documented configuration and credentials; Asset, Plugin and gateway identities cannot. Administrative credentials remain distinct from Asset reporting identity. Only operator authority can [retire an Asset](#asset-retirement).

### Assets

Each Asset has its own authenticated identity, bound to its Asset ID through [Enrollment](#enrollment). Asset credentials cannot act as another Asset or administer Core. Core checks that reported Entity state comes from that Asset and that an execution report comes from the Asset assigned to the Task. A valid key or a claimed Asset ID in a request is not sufficient. The check applies on every path that can record Asset state or execution, including check-in, component and status updates, Task lifecycle reports and any generic resource mutation path. [Shared Asset report acceptance](../architecture/system-design.md#shared-asset-report-acceptance) performs the binding check for reports.

### Plugins

Core provides each managed Plugin with a Plugin identity; operators do not provision or rotate individual Plugin API keys. Plugins use ordinary SDK operational APIs across sources, including creating and cancelling Tasks with existing Commands. They cannot impersonate an Asset's execution reports. A Plugin identity cannot manage Atlas credentials, change Core configuration, control Core lifecycle, or install or manage Plugins. Credential administration remains separate from Plugin operational access.

Plugins are trusted code with broad operational access, not isolated tenants. These API rules do not promise host-process sandboxing. A trusted Plugin may receive provider credentials for its own integration. A credential broker or Source Gateway is optional; Atlas does not promise that provider secrets are always hidden from Plugins. Datastream delivery is not a selected successor capability.

### Radio gateways

Each radio gateway has its own gateway identity, provisioned through Core. It may read like any authenticated client and may relay reports and assigned work only for the Assets bound to it, preserving the authenticated originating Asset. It has no administrative rights, cannot act as an unbound Asset, and stops relaying for an Asset that is retired or deleted. A gateway connection or a short claimed Asset ID alone is not proof of the originating Asset. Making gateways Assets in their own right is a future proposal, not an accepted direction.

## Enrollment

Each Asset receives its own authenticated identity automatically during Enrollment, without a manual per-Asset key-management workflow. Deployment tooling supplies enrollment authorization, and the SDK's [Asset client](sdk.md#asset-client) performs registration and identity provisioning automatically, without an approval click for each new Asset. The Asset URL or a claimed ID alone does not authorize Enrollment. Enrollment authorization is needed only for first Enrollment; after Reset an Asset [re-registers](#retained-asset-identity-after-reset) with its surviving credential. Keep Enrollment simple.

### Open enrollment

Open enrollment is a local testing setting, off by default and switched only through the CLI/TUI. While it is on, any connecting Asset is enrolled without deployment authorization but still receives its own identity, so report authority and impersonation protection are unchanged. It applies to Assets only and never overrides revocation or retirement. The setting belongs to installation setup, surviving Restart and Reset until Hard Reset. Core health reports it, the Command Interface shows a persistent warning while it is on, and switching it is recorded in [activity history](history.md#activity-history). Core records whether each Asset identity was enrolled under Open enrollment. Switching it off does not revoke Assets enrolled under it; the CLI/TUI marks them so an operator can revoke them deliberately.

## Asset registration

Asset registration creates the Asset's Entity in the current Dataset under its enrolled identity. It uses ordinary Entity creation, not a dedicated registration endpoint. Registration is not a report and not a replacement upsert. It carries only Descriptive data and Command support; other Reported data, such as Operational status and position, arrives with the first check-in. Registration does not create empty component placeholders, and supplying optional initial data does not exempt the record from required-component validation. [Asset reporting](asset-reporting.md#components-and-initial-values) defines the values before the first report.

Each Asset has a stable ID that survives restarts. Reconnecting resumes the existing record without overwriting its state with startup defaults.

### Registration retries

Registration retries reuse the Asset ID and the same Dataset-scoped registration request identity, so a lost response does not create another Asset. The Asset client prepares the registration identity and hands it to the Asset OS or deployment layer to retain before submission, so a lost response followed by an Asset process restart can still retry with it. Registration uses the shared [retry identity](../architecture/system-design.md#retry-identity) mechanism.

Core commits the registration request identity, stable Asset ID, authenticated enrollment-principal binding, canonical initial request facts and resulting Entity/credential association atomically with Entity creation and identity provisioning. It stores enough private facts to compare a retry with the original request, not with the Asset's later mutable state. First Enrollment creates one Asset and one provisioned identity even under concurrent identical requests; conflicting request reuse or an unauthorized caller fails.

A matching authorized retry returns the original registration association and the current Asset representation without reapplying startup defaults, rolling back later reports or provisioning a second credential. Recovering access to that same identity requires the enrollment proof; the request ID alone is not a secret or authorization. Registration retry records are retained across Restart until Reset, including after Entity deletion. A retry for a deleted Asset reports deletion without resurrection; a replacement requires a new ID. Registration retries cannot reactivate revoked credentials or bypass revoked enrollment authorization. Reset invalidates the old Dataset and its registrations and does not authorize replaying an old registration into a new Dataset.

## Retained Asset identity after Reset

An Asset ID bound to a retained authenticated principal remains reserved to that principal at installation scope, independently of Dataset-scoped Entity reservations. The binding is installation setup, retained with the credentials across Restart and ordinary Reset; ordinary Reset clears the Asset's operational Entity and registration records. Creating any Entity under that ID checks the retained binding; a replacement principal, Track or Geofeature cannot claim it. Commit the binding check with registration and serialize it against credential provisioning and revocation.

After Reset, an Asset that still holds a usable credential for its bound identity re-registers automatically under the same Asset ID in the fresh Dataset, with a new registration request and without new enrollment authorization. Re-registration proves the surviving identity and reuses its principal without restoring old operational state. Reading the new Dataset ID is not proof of Asset identity and does not authorize re-registration or relabeling an old report. If the Asset has lost its credential, the CLI/TUI can [re-provision one](#lost-asset-credentials); otherwise use a new Asset ID through authorized Enrollment rather than reassigning the retained ID.

Revocation is permanent until Hard Reset. When [deletion](#asset-deletion-and-access) or [retirement](#asset-retirement) revokes an Asset's identity, ordinary Reset does not reactivate it, and no proof, enrollment authorization or Open enrollment can bring that Asset ID back. A replacement device enrolls under a new Asset ID. Bindings are retained even for revoked identities, so credential revocation or ordinary Reset cannot free an ID for another principal. Hard Reset clears bindings and all credentials together.

## Credentials

### API keys

API keys are operator administrative credentials, not Asset reporting identities. Local deployment setup provisions the first key outside HTTP and stores it for the operator; later keys use the [API-key routes](../api-endpoints.md#api-keys). Recovery after loss or revocation of every key is also a local setup responsibility. No browser administration session is selected.

Administrative clients prepare an API key locally before requesting creation. The SDK uses a cryptographically secure generator for a secret containing at least 32 random bytes, allocates a stable creation/key identity, and hands the prepared credential to the caller for secure retention before submission. It does not generate a replacement secret on a transport retry. Keep prepared secrets out of diagnostic logs, activity records and ordinary resource caches; caller-side secure storage is explicit, not an SDK operational-picture persistence feature. Non-SDK administrative clients follow the same generation and retention requirements.

Creation accepts the prepared identity, secret and descriptive metadata under an existing administrative credential over an authenticated encrypted transport. Core validates the key format, stores only a verifier plus canonical request facts, and returns metadata without a secret. This replaces the earlier server-generated, one-time secret response: because the caller already has the secret, losing Core's response cannot lose the key. Key secrets are never recoverable through list or read APIs.

Commit the creation identity and credential together, scoped to the installation and bound to the authenticated administrative principal. Concurrent matching retries return the same key metadata; a changed secret or changed initial metadata under the same identity fails explicitly. Compare against original facts, not editable current metadata. A revoked key remains revoked on retry and returns an explicit revoked outcome. Creation records are retained across Restart, ordinary Reset and revocation until Hard Reset. A retry still requires current administrative authorization and the current Dataset precondition where applicable. The SDK must not silently relabel a pre-Reset request; ordinary Reset's retained credentials do not bypass the Dataset boundary.

### Lost Asset credentials

Losing a credential is not revocation. The local CLI/TUI can re-provision a credential for the same Asset identity, separately from revocation, revoking only the lost credential. It also lists retained and revoked Asset IDs, which have no visible Entity after Reset.

### Credential revocation

Revocation applies to ongoing access as well as new HTTP requests. When revocation commits, Core rejects further requests with that credential, stops authorizing further event delivery on every live feed connection using it, and terminates those connections. Reconnects and recovery calls with that credential fail. Serialize the relevant authorization check with revocation, or use equivalent cancellation, so already-queued events cannot be sent under revoked authority. Data already transmitted or copied into a client's picture cannot be recalled. Revocation and Dataset boundaries must survive any transport optimization.

The SDK treats the resulting authorization failure as requiring replacement credentials rather than retrying forever with a revoked key. This introduces no client-side role rules and does not pretend to erase previously delivered data.

## Asset deletion and access

An allowed Asset deletion also decommissions its authenticated access. Core atomically commits Entity deletion, its retained identity reservation, revocation of every credential bound to that Asset and the deletion change. Serialize deletion against credential provisioning, registration retries, new Task assignment and reporting, so none can leave a usable credential or newly assigned Task for a deleted Asset. The existing nonterminal-Task guard remains: rejecting deletion leaves both the Entity and its credentials unchanged. Track and Geofeature deletion does not revoke unrelated identities.

The [revocation cut-off](#credential-revocation) applies to those credentials' reads, writes and feeds from the deletion commit. The revocation is [retained until Hard Reset](#retained-asset-identity-after-reset); Reset does not reactivate the removed device, and registration retries cannot resurrect its deleted identity or revive revoked credentials. Historical Task, Object and movement associations keep their existing retention rules. [Asset deletion coordination](../architecture/system-design.md#asset-deletion-coordination) describes how the modules collaborate. Deletion is not the only way to withdraw participation: [retirement](#asset-retirement) remains possible while Task outcomes are unresolved.

## Asset retirement

Asset retirement is one operator-requested operation through the SDK and Core. It remains available when the Asset is disconnected or has nonterminal Tasks, needs no installation Reset, and leaves unrelated Assets operating. Existing operator authority permits it; Asset, Plugin and gateway identities cannot retire Assets. It requires an existing, nonretired Asset.

Retirement atomically records the administrative condition, blocks new Task assignments and credential provisioning for that identity, revokes all bound credentials, records the attributed action in [activity history](history.md#activity-history) and publishes the Entity change. The [revocation cut-off](#credential-revocation) applies to requests and live feeds.

Retirement retains the Entity and its identity, Task assignments, execution facts, histories, Object associations and required-result protection. It is neither a Task nor an Asset-reported operational status, and it adds no Entity kind or Task lifecycle state. Core exposes the administrative condition with the Entity, separately from the last reported operational status and execution uncertainty. The condition is Core-owned: it is not writable through generic reported-component patches and gives an operator no way to impersonate Asset reporting.

Retirement never marks a Task completed, failed or cancelled, confirms a pending cancellation, resumes a queue or claims that physical execution stopped. Terminal outcomes and unresolved execution facts stay under [Tasks](tasks.md#task-status-and-transitions). An already-accepted completion report may still resolve under [scan completion](tasks.md#scan-completion) when its required Objects arrive through an authorized upload; that is the existing evidence-based completion rule, not an outcome inferred from retirement. Retirement does not release Object holds or [required Entity-reference protection](tracks-and-geofeatures.md#required-entity-references): an unresolved Task can keep a required Track or Geofeature protected after its assigned Asset is retired, and only a terminal Task outcome releases that guard. Required Object holds remain until Reset under [Required-result protection](objects.md#required-result-protection), independently of that terminal release.

Ordinary Entity deletion and its nonterminal-Task guard are unchanged. Do not implement retirement by weakening `DELETE /entities/{entity_id}`, by forcing deletion or terminal outcomes, or by composing public credential, Task and Entity mutations in callers. The SDK submits one request to Core in every mode and returns its committed result; callers do not coordinate revocation, assignment blocking or record preservation. Success confirms Core's commit under [ADR-0018](../adr/0018-confirm-writes-when-core-commits.md), not physical stopping. The response does not update a local picture; the Entity change arrives through ordinary synchronization.

### Retirement races

Serialize retirement with assignment, provisioning, registration, deletion, report acceptance and Object publication authorization. Use the shared authorization and transaction boundaries rather than a handler-only check.

- Assignment: assignment-first retains the accepted Task and still allows retirement; retirement-first rejects the new assignment.
- Reports: an authorized report committed first remains evidence. Retirement-first prevents a later request under the revoked Asset authority from changing recorded state.
- Provisioning and Enrollment: a competing request cannot leave a usable credential after retirement commits.
- Deletion: ordinary deletion and retirement serialize in the same commit boundary. Retirement-first leaves its installation-scoped denial intact even if an allowed deletion then removes the Entity. Deletion-first makes a fresh retirement request return not found without creating a denial, successful claim or activity; a retained identity reservation is not an existing Asset.
- Uploads: an Asset-authenticated upload rechecks its authority inside the short Object publication transaction. Publication-first preserves the ready Object and any evidence-based completion it permits. Retirement-first rejects publication under the revoked credential, creates no ready Object or successful upload identity, and cleans up the abandoned attempt under [publication and recovery](objects.md#publication-and-recovery). File streaming or durable private content alone does not establish publication. An unaffected authorized principal may retry the whole upload under the existing upload identity and content rules; this does not restore Asset authority or invent execution evidence.

### Retirement retries

Retirement uses the shared [retry identity](../architecture/system-design.md#retry-identity) contract, including its Dataset-scoped retirement claim, original request facts and First, Replay, Conflict and Ended outcomes. Check an existing matching retry claim before the nonretired-Asset admission rule, so a retry of the successful request still returns its recorded result. A new request identity targeting an already-retired Asset returns an explicit already-retired error without changing state, recording a successful retry claim or adding activity. Concurrent fresh retirement requests therefore produce one retirement and one already-retired rejection.

An authorized matching retry in the same Dataset returns the recorded retired result without repeating the action, adding another activity entry or reactivating access. If ordinary deletion has since removed the Entity, it returns the explicit deleted-result outcome instead. Rejected requests have no partial effect. Dataset changes reject obsolete submissions rather than turning them into retirement requests against a new Dataset; the SDK discards them on Reset.

### Retired identity after Reset

The retirement condition survives same-release Restart. Core keeps the decommissioned authorization decision with the installation-scoped [Asset binding](#retained-asset-identity-after-reset), so ordinary Reset clears the old Dataset but does not reauthorize that identity or permit automatic re-enrollment. After Reset, Core rejects registration for the retired Asset ID even when the same bound principal proves its identity and supplies enrollment authorization, the new Dataset and a fresh request identity. Open enrollment does not change this. The rejection creates no Entity or usable credential. Hard Reset keeps its existing destructive scope. A delayed report, hello, upload retry or surviving credential must not reactivate the Asset. Reactivating a recovered retired device, or admitting new execution evidence from it, requires a separate explicit policy; there is no automatic recovery path or operator-forced outcome.

## Routes and SDK operations

- Register Asset: `POST /entities` in the [Entities routes](../api-endpoints.md#entities), through the [Asset client](sdk.md#asset-client) and [Asset startup](sdk.md#asset-startup).
- Delete Asset: `DELETE /entities/{entity_id}` in the [Entities routes](../api-endpoints.md#entities).
- Retire Asset: accepted [SDK operation](sdk.md#operations-catalog); its [HTTP route](../api-endpoints.md#remaining-contract-details) is not yet selected.
- API keys: list, create and revoke in the [API-key routes](../api-endpoints.md#api-keys).
- Local CLI/TUI actions: switch Open enrollment, re-provision a lost Asset credential, revoke credentials where applicable and list retained and revoked Asset IDs, under [local administration](../architecture/system-design.md#local-administration).

## Open questions

- The Enrollment bootstrap credential, proof and delivery, and the gateway relay proof and delegation. Credential formats, setup mechanics and route bindings are implementation choices.
- Registration identity encoding and credential proof and delivery fields.
- API-key wire encoding, verifier scheme and the exact setup commands for the first key and for recovery.
- Connection-close and error encoding for revocation, which is Protocol work.
- The retirement HTTP binding, SDK signature, record fields, and retry and response encodings.
- Operator profile fields and lifecycle.

## Decisions

- [ADR-0015](../adr/0015-separate-start-stop-restart-and-reset.md): what Restart, Reset and Hard Reset retain, including installation setup and credentials.
- [ADR-0019](../adr/0019-retire-assets-without-inventing-task-outcomes.md): retire Assets without inventing Task outcomes.
- [ADR-0020](../adr/0020-limit-general-sdk-to-http-and-full-sync.md): IP-connected Assets and radio gateways use the general SDK; gateways have their own identities.
- [ADR-0022](../adr/0022-one-publisher-per-track.md): Track publisher authorship, separate from broad operational access.
- [ADR-0023](../adr/0023-protect-required-entity-references-during-tasks.md): required Entity references stay protected when the assigned Asset is retired.
- [Activity history](history.md#activity-history) records credential changes and retirement; ADR-0003 is superseded by ADR-0015.

## Test evidence

These rows of the [required scenario coverage](../testing-strategy.md#required-scenario-coverage) apply:

- Asset identity and contact: Enrollment, registration retries, cross-Asset rejection, revocation, gateway limits, Open enrollment and re-provisioning.
- Asset retirement: every retirement workflow, race and retry.
- Asset deletion: credential revocation with deletion and its races.
- API-key creation: prepared secrets, retries and revocation.
- Reset and Restart: retained bindings, automatic re-registration and revoked identities.
- Hard Reset and retained setup: credentials retained by ordinary Reset and cleared by Hard Reset.
