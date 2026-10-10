# Identity and access

This page owns who can call Atlas Core and what each caller may do: Enrollment and Asset registration, retained Asset identity across Reset, credentials and their revocation, and how Asset deletion and retirement withdraw access.

## Callers and permissions

Every authenticated SDK client, including an Asset, Plugin or gateway, may read all operational data through the public API. That covers full-picture snapshots, feed delivery and replay as well as individual resource, Object and Operation reads. Each client authenticates these reads and synchronization connections with its own caller credentials; Asset, Plugin and gateway identities do not require an operator administrative API key. There are no per-Asset or per-Plugin read filters. Clients still choose basic API access or opt-in synchronization; permission to see everything does not require downloading everything. Health and documentation routes also require authentication.

Authentication resolves a stable principal kind (operator client, Asset, managed Plugin or gateway) and, for an Asset, its bound Asset ID. There are no operator roles, permission tiers or view-only accounts. All authenticated operators have full control within the execution-report, [Track-publisher](tracks-and-geofeatures.md#one-publisher-per-track) and local-administration boundaries below. Operator profiles are names and settings, not permission roles. The proposed additional caller-scoped Operation retry and upload-handle ownership rules are not adopted; submission identity keeps its existing Dataset scope.

SDK method availability does not grant permission, and a route's expected caller does not either. Core enforces authorization at the API boundary. All Core configuration inspection and editing, including live tuning, are [local CLI/TUI controls](dataset-lifecycle.md#core-configuration), absent from the public API and SDK. Plugin installation and configuration and Core and Plugin process lifecycle are also [local controls](plugins.md#local-administration). Remote health and readiness remain available without exposing the full configuration.

### Operator clients

Operator administrative clients may manage the documented credentials and Asset retirement through the public API. They cannot inspect or edit Core configuration there; those actions require local administration. Administrative credentials remain distinct from Asset reporting identity. Only operator authority can [retire an Asset](#asset-retirement).

### Assets

Each Asset has its own retained identity, bound to its Asset ID through [Enrollment](#enrollment). A direct IP Asset authenticates with its own credential, which cannot act as another Asset or administer Core. For a gateway-backed Asset, Core authenticates the gateway and checks its explicit authorization for that downstream Asset under [Radio gateways](#radio-gateways); it does not require an originating Asset's Core-format signature. Core checks the reported Asset binding and that execution evidence belongs to the Asset assigned to the Task. A valid key or a claimed Asset ID alone is not sufficient. The check applies on every path that can record Asset state or execution, including check-in, component and status updates, Task lifecycle reports and any generic resource mutation path. [Shared Asset report acceptance](../architecture/system-design.md#shared-asset-report-acceptance) performs the binding check for reports.

Only operator clients and managed Plugins may edit an existing Entity's Descriptive fields, including Alias, subtype, descriptive media associations and Geofeature geometry. Asset and gateway credentials cannot make those edits, even to their own or bound Asset, and receive `forbidden_field` without any edit, report or Contact effect. Initial Asset registration may still supply its permitted Descriptive fields; a matching registration retry returns the current Entity without changing them. Reported/Observed authorship and read access retain their separate rules.

### Plugins

Core provides each managed Plugin with a Plugin identity; operators do not provision or rotate individual Plugin API keys. Plugins use ordinary SDK operational APIs across sources, including creating and cancelling Tasks with existing Commands. They cannot impersonate an Asset's execution reports. A Plugin identity cannot manage Atlas credentials, change Core configuration, control Core lifecycle, or install or manage Plugins. Credential administration remains separate from Plugin operational access.

Plugins are trusted code with broad operational access, not isolated tenants. These API rules do not promise host-process sandboxing. A trusted Plugin may receive provider credentials for its own integration. A credential broker or Source Gateway is optional; Atlas does not promise that provider secrets are always hidden from Plugins. Datastream delivery is not a selected successor capability.

### Radio gateways

Each radio gateway has its own gateway identity, provisioned through Core, and explicit bindings to its downstream Assets. It may read like any authenticated client. Core trusts an authenticated gateway to translate, reconstruct and submit Core-facing reports for its bound Assets and checks that binding on every reporting path. Core does not independently verify a downstream Asset's Core-format signature on this path. The constrained radio grammar need not carry Core report envelopes or signatures; the gateway integration is responsible for obtaining and interpreting the Asset evidence.

The gateway may deliver assigned work only for its bound Assets. Each downstream Asset keeps its own ID, Task assignments and outcomes. A gateway has no administrative rights, cannot act as an unbound Asset and stops submitting reports or assigned work for a retired, deleted or revoked Asset. Binding authority does not authorize invented execution outcomes or make the gateway's live connection evidence of downstream Contact. The [reporting rules](asset-reporting.md#report-authority-and-relay) preserve process generations, ordering, retries and Dataset boundaries through translation. Gateway restart is a communication interruption, not evidence of downstream process replacement.

Gateways are relay integrations and are not taskable Assets in the current scope. Whether a future gateway also receives its own Tasks remains open; this decision neither prohibits that model nor assumes it would require no Core changes.

## Publisher continuity

Track publishers use an opaque `publisher_id` distinct from an authenticated `principal_id` and, for managed Plugins, installation `plugin_id` and immutable release identity. Core resolves publisher authority from the authenticated binding; a submitted publisher ID is not permission.

For a caller already permitted to create Tracks that has no managed publisher binding, Core assigns and reserves one publisher ID to its retained principal atomically with its first Track creation. The request cannot nominate another publisher. Subsequent creations and observations use that binding. A replacement credential for the same retained principal preserves its publisher; a different principal receives a different publisher and creates separate Tracks. The reservation survives Restart and ordinary Reset until Hard Reset, without preserving Dataset observations or reviving revoked credentials. This adds no caller role and does not broaden Asset or gateway writes.

For a managed Plugin, authenticated local management records a new publisher identity, its trusted package provenance and its current Plugin/principal association on first provisioning. Different logical publishers receive different IDs even when their package or display name matches. Managed Plugin reinstall uses the separate proof below because the replacement installation has a new principal.

Core retains publisher identity reservations and their nonsecret management provenance as Core-owned installation facts until Hard Reset; live Track attribution and observation identities belong to the Dataset and end at Reset. Uninstall removes usable Plugin credentials and the active binding, retaining historical IDs and attribution without preserving Plugin-owned configuration or private work. A Plugin update keeps its installation and publisher identity. A reinstall allocates new installation and principal IDs and can bind them to the retained publisher only through the local procedure below. Ordinary Reset cannot revive the old principal or relabel an old observation; any new report targets the new Dataset.

Local management submits `publisher_id`, the new `plugin_id`/`principal_id`, verified `package_id` and `expected_binding_revision` through Core's authenticated private management interface. Core checks the installation-owner authority supplied by that interface, the retained publisher/package provenance, the new installed Plugin's principal and the expected binding revision, then commits a fresh active binding. Matching display names or a public API credential alone are insufficient. A package/source asserting a different publisher cannot modify the retained provenance to claim continuity; it receives a new publisher and new Tracks. This is same-publisher provisioning, not a transfer endpoint. A new compatible release of the same verified package may continue the publisher; its image/version identity remains separately attributable.

There is one active writer association for a managed publisher. A concurrent bind against an obsolete revision conflicts. Identical retries of the same private management action replay its result without another credential or binding. Uninstall/rebind serialize with observation acceptance and credential revocation: observation-first preserves its committed facts; uninstall-first prevents the old principal's writes and feeds. New credentials are generated for the new principal. Old revoked credentials and their retry claims remain revoked even after continuity succeeds. Reads of retained Plugin Operations use their original installation identity under [Plugin historical identity](plugins.md#installation-and-historical-identity), rather than this publisher binding.

| Independent continuity fixture | Expected result |
| --- | --- |
| Permitted non-Plugin principal R creates its first Track | One publisher P reserved to R and committed with the Track; request cannot claim another publisher |
| Replace R's credential while retaining principal R, then update its Track | P retained; fresh credential can publish; revoked old credential cannot |
| Different principal Q uses R's display name or supplies P | New publisher for Q or authorization rejection; no takeover of R's Track |
| Uninstall installation I1/principal R1 publishing as P | Private Plugin setup removed, R1 revoked, P/X attribution and Dataset history retained |
| Reinstall verified same publisher as I2/R2, local proof and expected binding revision valid | Fresh binding R2 to P; existing Track X can receive newer observations; no work rerun |
| Reinstall under same visible name without the local binding proof | Fresh publisher or explicit binding refusal; no authority over X |
| Another package/publisher Q supplies P's ID | Binding/observation rejection; P and X unchanged |
| R1 retries an old report after R2 is bound | Revoked-authority rejection; no current value, sample or Contact effect |
| Reuse I1's name for I2, then read I1's retained Operation | Original Operation remains under I1; name reuse does not reassociate it |
| Existing Task references X while a replacement publisher creates Y | Task still references X; no automatic retargeting or outcome |
| Reset followed by delayed old-P observation | Old Dataset rejected; stable identity alone restores no observation |

## Enrollment

Each Asset receives its own retained identity automatically during Enrollment, without a manual per-Asset key-management workflow. Deployment tooling supplies enrollment authorization, and the SDK's [Asset client](sdk.md#asset-client) performs registration and identity provisioning automatically, without an approval click for each new Asset. A direct IP Asset receives its own Core credential. A gateway-backed Asset receives a distinct retained binding under the authenticated gateway's authorized downstream association; the radio Asset need not hold a Core credential or Core-format signing key. The gateway's credential alone does not authorize first Enrollment of any claimed ID; deployment authorization must permit that binding.

The Asset URL or a claimed ID alone does not authorize Enrollment. Enrollment authorization is needed only for first Enrollment; after Reset an Asset [re-registers](#retained-asset-identity-after-reset) through its surviving direct credential or authorized gateway binding. Concrete gateway enrollment proof and delegation fields remain engineering work. Keep Enrollment simple.

### Direct IP bootstrap encoding

S1 implements this encoding for direct IP Assets. Deployment tooling (`atlas-manage authorize-enrollment`) signs an `EnrollmentAuthorization` with the installation's retained Ed25519 enrollment authority. The signed facts are the RFC 8785 canonical JSON of `installation_id`, canonical `asset_id`, `recovery_public_key` and the domain separator `atlas_signature: "atlas-enrollment-v1"`. The token is the unpadded base64url encoding of the canonical authorization, including its `signature`. It travels only in the `Atlas-Enrollment` request header and is accepted only for `GET /health` discovery and the first `POST /entities`. That registration carries `enrollment.credential`, the Asset's prepared 32-byte random credential in base64url; Core stores only its verifier. A retained registration descriptor keeps its authorization, so every retry authenticates as first prepared. Later requests use the Asset's own bearer credential, and re-registration after Reset uses that credential with a new registration identity and no enrollment member.

### Asset process authority

For direct IP Assets, Enrollment also binds an Ed25519 `recovery_public_key` supplied under deployment authorization to the retained Asset principal. The Asset OS/deployment authority prepares and retains its private key before the request; Core stores only the public key. This key authorizes [process replacement](asset-reporting.md#process-authority-establishment-and-replacement) and is distinct from ordinary Asset request credentials and per-process report-signing keys. It is not handed to a gateway or an obsolete reporting process. Registration identity alone does not prove its ownership or authorize replacement.

Recovery authority is retained with the Asset binding across Restart and ordinary Reset, but current Dataset generations and process/report identities are cleared on Reset. A revoked Asset cannot obtain new authority claims. Authorized local re-provisioning can replace lost recovery authority for an otherwise active bound identity; it cannot reassign the Asset ID to another principal or reactivate retirement/deletion denials. Any existing process authority is invalidated when its recovery binding changes, and another claim uses the current binding. The Dataset's generation counter remains reserved, so re-provisioning cannot reuse an old generation or make its signatures current again. Hard Reset clears keys and bindings together.

Gateway-backed Assets retain the Core-issued generation and obsolete-process rejection guarantees through the [gateway establishment and replacement path](asset-reporting.md#process-authority-establishment-and-replacement). Core relies on the authenticated bound gateway and the downstream process evidence it attests; it does not require the direct IP recovery-key mechanism over the radio link. A gateway reconnect or restart does not establish a new downstream process. Gateway-specific authority-transfer proof and wire fields remain open.

### Open enrollment

Open enrollment is a local testing setting, off by default and switched only through the CLI/TUI. While it is on, any connecting Asset is enrolled without deployment authorization but still receives its own identity, so report authority and impersonation protection are unchanged. It applies to Assets only and never overrides revocation or retirement. The setting belongs to installation setup, surviving Restart and Reset until Hard Reset. Switching it is recorded in [activity history](history.md#activity-history).

Core records immutable Open enrollment provenance with each identity's installation-scoped binding. That provenance survives Restart and ordinary Reset, including when no Asset Entity remains. Switching Open enrollment off does not revoke those identities. Core health reports both the setting and the count of unrevoked identities enrolled under it. The Command Interface shows a persistent warning while the setting is on or that count is nonzero, explaining that disabling enrollment leaves existing access in place.

#### Cleanup after testing

This cleanup action is an accepted contract; implementation remains future work.

The CLI/TUI lists identities enrolled under Open enrollment, including retained IDs without a current Asset Entity, and provides an explicit local cleanup action. Core must be running with its Dataset open. The operator confirms the exact selected Asset IDs and is told that revocation lasts until Hard Reset. The confirmed selection carries the Asset IDs and their bound installation principals; it never expands to identities enrolled afterward. Cleanup is separate from switching Open enrollment off, and local management serializes its execution with lifecycle actions under [local lifecycle coordination](../architecture/system-design.md#local-lifecycle-coordination).

For each selected target, Core revalidates the exact confirmed binding, its enrollment provenance and current Entity state and commits the outcome in a separate [write commit](../architecture/system-design.md#write-commits), serialized with registration, credential provisioning and replacement, deletion and retirement. A changed or removed binding, or a target not enrolled under Open enrollment, is rejected without effect; reusing an Asset ID after Hard Reset cannot make an old selection authorize revoking the new identity. If its Asset Entity exists, cleanup uses [Asset retirement](#asset-retirement), preserving unresolved Tasks and execution evidence. If no Entity exists, cleanup revokes all credentials and denies the retained installation binding without creating an Entity or a retirement claim. Both paths prevent automatic re-registration and credential re-provisioning for the revoked identity until Hard Reset. Cleanup never invents a Task outcome or claims that physical execution stopped.

Cleanup reports a result for each selected ID. An already-revoked identity is reported without another mutation or activity entry. This confirmed-binding check also makes lost-response retries idempotent, without a separate cleanup retry claim; any retirement claim belongs to the existing retirement workflow. An interruption or failure leaves completed revocations in force and identifies unfinished targets for deliberate retry; it does not report the whole selection complete while any selected identity remains unrevoked. Each new revocation records the attributed action under [local activity history](history.md#local-actions); retirement uses its existing activity record.

The health count is derived from unrevoked installation bindings with Open enrollment provenance, independently of current Entity presence. [Replacing a lost credential](#lost-asset-credentials) does not change provenance or revoke the identity, so that identity remains counted. Cleanup, deletion or retirement removes a revoked identity from the count; ordinary Reset does not. The warning clears only when Open enrollment is off and the count is zero. It is advisory and does not make Core unready.

## Asset registration

Asset registration creates the Asset's Entity in the current Dataset under its enrolled identity. It uses ordinary Entity creation, not a dedicated registration endpoint. Registration is not a report and not a replacement upsert. It carries only Descriptive data and Command support; other Reported data, such as Operational status and position, arrives with the first check-in. Registration does not create empty component placeholders, and supplying optional initial data does not exempt the record from required-component validation. [Asset reporting](asset-reporting.md#components-and-initial-values) defines the values before the first report.

Each Asset has a stable ID that survives restarts. Reconnecting resumes the existing record without overwriting its state with startup defaults.

### Initial data and temporal facts

Registration accepts the stable ID/type, optional Alias/subtype and applicable Descriptive fields, plus the initial `command_manifest`. An absent Alias becomes null and absent Command support becomes an empty list; no Command is supported until advertised. Operational status, telemetry, health and other Reported components are rejected at registration, as are Derived Contact/Communication state, retirement, queue, receipt times and caller-supplied versions. Those values require the first report or their Core-owned workflows. Invalid initial data rejects creation and first-enrollment provisioning together, rather than leaving a usable identity without its accepted registration.

Core sets the resource's `created_at` and initial `updated_at` to the successful registration commit's Core-authored timestamp, its edit revision to `"1"`, and its synchronized resource version to that commit's version. Status is `unknown`, Communication state `offline`, and Contact `last_seen: null` under [initial values](asset-reporting.md#components-and-initial-values). Status report/receipt/change times are null and the `reporting` metadata map is empty. Optional reported components are absent, not zero-filled. The registration receipt time is not an observation time or proof of Contact, including for initial Command support. Registration makes no Movement sample and establishes no execution generation by itself.

The first check-in establishes process authority as needed and reports current Reported data under [shared acceptance](asset-reporting.md#shared-report-context). Its observation/generation times remain distinct from Core receipt time. Only a valid fresh-contact proof updates Contact. There is no implicit first check-in in the creation transaction; an SDK startup helper may perform the subsequent call explicitly and must expose any failure after successful registration.

### Registration retries

Registration retries reuse the Asset ID and the same Dataset-scoped registration request identity, so a lost response does not create another Asset. The Asset client prepares the registration identity and hands it to the Asset OS or deployment layer to retain before submission, so a lost response followed by an Asset process restart can still retry with it. Registration uses the shared [retry identity](../architecture/system-design.md#retry-identity) mechanism.

Core commits the registration request identity, stable Asset ID, authenticated enrollment-principal binding, canonical initial request facts and resulting Entity/identity association and any credential provisioning atomically with Entity creation. It stores enough private facts to compare a retry with the original request, not with the Asset's later mutable state. First Enrollment creates one Asset and one provisioned identity even under concurrent identical requests; conflicting request reuse or an unauthorized caller fails.

A matching authorized retry returns the original registration association and the current Asset representation without reapplying startup defaults, rolling back later reports or provisioning a second credential. Recovering access to that same identity requires the applicable enrollment or gateway-binding proof; the request ID alone is not a secret or authorization. Registration retry records are retained across Restart until Reset, including after Entity deletion. A retry for a deleted Asset reports deletion without resurrection; a replacement requires a new ID. Registration retries cannot reactivate revoked credentials or bypass revoked enrollment authorization. Reset invalidates the old Dataset and its registrations and does not authorize replaying an old registration into a new Dataset.

### Registration equality and independent fixtures

Compare retry identity against canonical original registration facts: Dataset, Asset ID/type, authenticated principal/enrollment association, Descriptive inputs, initial Command support and, on the direct IP path, recovery-public-key binding. Gateway-backed registration includes its authorized downstream binding rather than requiring an originating Asset recovery key. Apply the explicitly declared creation defaults (absent Alias to null and absent Command support to an empty list) before this comparison. Preserve omission/null distinctions in any other field whose schema distinguishes them. Authentication secrets are not returned or compared through the public Entity representation. Later Alias, Command support, telemetry, Contact and status changes are not retry facts. A successful retry returns the original association and current Entity, not an old snapshot, and does not change any timestamp or version.

These fixtures are specification evidence for [#82](https://github.com/atlas-field-systems/atlas-core/issues/82), not executed tests. Start without Asset A in Dataset D; Core-authored receipt/commit times below are fixed independent inputs under [deployment clocks](../adr/0029-use-deployment-clocks-and-preserve-event-times.md), without SDK offset estimation. These first-report cases exercise the direct IP authority claim and matching contact challenge described by [Asset reporting](asset-reporting.md#process-authority-establishment-and-replacement). Gateway-backed registration retains the same Entity, temporal, retry and revocation behavior through its authorized binding; its proof fields remain open.

| Workflow | Expected Entity and identity | Expected time, Contact and movement |
| --- | --- | --- |
| Register A/Alias Alpha at Core commit time 100 with omitted optional components/support | One bound identity/Entity; support empty; status unknown; communications offline; no telemetry | created/updated 100; report times null; last_seen null; no samples |
| Supply initial position or status during first registration | Atomic validation rejection; no Entity, successful retry claim or usable first-enrollment identity | No timestamps, Contact or samples |
| Supply Derived heartbeat/communication state or initial receipt time | Atomic forbidden-field rejection | No Contact or samples |
| Lose successful registration response and retry matching facts at 101 | Original association and current Entity; no extra credential or Entity | All original times unchanged; last_seen null; no samples |
| First fresh check-in generated 195, receipt 200, status ready and position P1 with `observation_times.position.observed_at: 195` and bounded uncertainty | Same A, generation 1; current status/position applied | reported_at 195; received/changed 200 where applicable; last_seen 200; one P1 sample at observation 195/receipt 200 |
| Repeat registration after that check-in | Return current ready/P1 Entity; do not reapply initial unknown/empty values | Contact remains 200; no extra sample or timestamp/version change |
| Same registration ID with changed initial Alias/support/key | Identity conflict against original facts, not current state | No effects |
| Registration committed, then first check-in fails | Registration remains successful and inspectable; first-report error is separate | Unknown/offline/null Contact retained; no sample |
| Reset to D2, then A re-registers at 300 using surviving credential/new request ID | Same principal/A binding; fresh Entity without old report state or enrollment approval | created/updated 300; unknown/offline/null report and Contact times; no old sample |
| Retry D's registration/report against D2 | Obsolete-Dataset rejection without relabeling | D2 unchanged |
| A deleted/retired or its identity revoked, then retry/register after Reset | Deleted-result or revoked/retired rejection under the applicable workflow; no resurrection | No new Contact or samples |

## Retained Asset identity after Reset

An Asset ID bound to a retained authenticated principal remains reserved to that principal at installation scope, independently of Dataset-scoped Entity reservations. The binding is installation setup, retained with the credentials across Restart and ordinary Reset; ordinary Reset clears the Asset's operational Entity and registration records. Creating any Entity under that ID checks the retained binding; a replacement principal, Track or Geofeature cannot claim it. Commit the binding check with registration and serialize it against credential provisioning and revocation.

After Reset, an Asset with a surviving usable direct credential or authorized gateway binding re-registers automatically under the same Asset ID in the fresh Dataset, with a new registration request and without new enrollment authorization. Re-registration proves the surviving identity through that direct credential or gateway authorization and reuses its retained binding without restoring old operational state. Reading the new Dataset ID is not proof of Asset identity and does not authorize re-registration or relabeling an old report. If the Asset has lost its credential, the CLI/TUI can [re-provision one](#lost-asset-credentials); otherwise use a new Asset ID through authorized Enrollment rather than reassigning the retained ID.

Revocation is permanent until Hard Reset. When [deletion](#asset-deletion-and-access), [retirement](#asset-retirement) or [Open enrollment cleanup](#cleanup-after-testing) revokes an Asset's identity, ordinary Reset does not reactivate it, and no proof, enrollment authorization or Open enrollment can bring that Asset ID back. A replacement device enrolls under a new Asset ID. Bindings are retained even for revoked identities, so credential revocation or ordinary Reset cannot free an ID for another principal. Hard Reset clears bindings and all credentials together.

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

Retirement never marks a Task completed, failed or cancelled, confirms a pending cancellation, resumes a queue or claims that physical execution stopped. Terminal outcomes and unresolved execution facts stay under [Tasks](tasks.md#task-status-and-transitions). An accepted completion report has already established the terminal outcome independently of file readiness; an authorized later upload preserves its result without changing that outcome. Retirement does not release Object holds or [required Entity-reference protection](tracks-and-geofeatures.md#required-entity-references): an unresolved Task can keep a required Track or Geofeature protected after its assigned Asset is retired, and only a terminal Task outcome releases that guard. Required Object holds remain until Reset under [Required-result protection](objects.md#required-result-protection), independently of that terminal release.

Ordinary Entity deletion and its nonterminal-Task guard are unchanged. Do not implement retirement by weakening `DELETE /entities/{entity_id}`, by forcing deletion or terminal outcomes, or by composing public credential, Task and Entity mutations in callers. The SDK submits one request to Core in every mode and returns its committed result; callers do not coordinate revocation, assignment blocking or record preservation. Success confirms Core's commit under [ADR-0018](../adr/0018-confirm-writes-when-core-commits.md), not physical stopping. The response does not update a local picture; the Entity change arrives through ordinary synchronization.

### Retirement races

Serialize retirement with assignment, provisioning, registration, deletion, report acceptance and Object publication authorization. Use the shared authorization and transaction boundaries rather than a handler-only check.

- Assignment: assignment-first retains the accepted Task and still allows retirement; retirement-first rejects the new assignment.
- Reports: an authorized report committed first remains evidence. Retirement-first prevents a later request under the revoked Asset authority from changing recorded state.
- Provisioning and Enrollment: a competing request cannot leave a usable credential after retirement commits.
- Deletion: ordinary deletion and retirement serialize in the same commit boundary. Retirement-first leaves its installation-scoped denial intact even if an allowed deletion then removes the Entity. Deletion-first makes a fresh retirement request return not found without creating a denial, successful claim or activity; a retained identity reservation is not an existing Asset.
- Uploads: an Asset-authenticated upload rechecks its authority inside the short Object publication transaction. Publication-first preserves the ready Object without establishing or changing a Task outcome. Retirement-first rejects publication under the revoked credential, creates no ready Object or successful upload identity, and cleans up the abandoned attempt under [publication and recovery](objects.md#publication-and-recovery). File streaming or durable private content alone does not establish publication. An unaffected authorized principal may retry the whole upload under the existing upload identity and content rules; this does not restore Asset authority or invent execution evidence.

### Retirement retries

Retirement uses the shared [retry identity](../architecture/system-design.md#retry-identity) contract, including its Dataset-scoped retirement claim, original request facts and First, Replay, Conflict and Ended outcomes. Check an existing matching retry claim before the nonretired-Asset admission rule, so a retry of the successful request still returns its recorded result. A new request identity targeting an already-retired Asset returns an explicit already-retired error without changing state, recording a successful retry claim or adding activity. Concurrent fresh retirement requests therefore produce one retirement and one already-retired rejection.

An authorized matching retry in the same Dataset returns the recorded retired result without repeating the action, adding another activity entry or reactivating access. If ordinary deletion has since removed the Entity, it returns the explicit deleted-result outcome instead. Rejected requests have no partial effect. Dataset changes reject obsolete submissions rather than turning them into retirement requests against a new Dataset; the SDK discards them on Reset.

### Retired identity after Reset

The retirement condition survives same-release Restart. Core keeps the decommissioned authorization decision with the installation-scoped [Asset binding](#retained-asset-identity-after-reset), so ordinary Reset clears the old Dataset but does not reauthorize that identity or permit automatic re-enrollment. After Reset, Core rejects registration for the retired Asset ID even when the same bound principal proves its identity and supplies enrollment authorization, the new Dataset and a fresh request identity. Open enrollment does not change this. The rejection creates no Entity or usable credential. Hard Reset keeps its existing destructive scope. A delayed report, hello, upload retry or surviving credential must not reactivate the Asset. Reactivating a recovered retired device, or admitting new execution evidence from it, requires a separate explicit policy; there is no automatic recovery path or operator-forced outcome.

## Routes and SDK operations

- Register Asset: `POST /entities` in the [Entities routes](../api-endpoints.md#entities), through the [Asset client](sdk.md#asset-client) and [Asset startup](sdk.md#asset-startup).
- Delete Asset: `DELETE /entities/{entity_id}` in the [Entities routes](../api-endpoints.md#entities).
- Retire Asset: `POST /entities/{entity_id}/retire` in the [Entities routes](../api-endpoints.md#entities), through the [SDK operation](sdk.md#operations-catalog).
- API keys: list, create and revoke in the [API-key routes](../api-endpoints.md#api-keys).
- Local CLI/TUI actions: inspect and edit all Core configuration, switch Open enrollment, the planned [cleanup of selected test identities](#cleanup-after-testing), re-provision a lost Asset credential, revoke credentials where applicable and list retained and revoked Asset IDs, under [local administration](../architecture/system-design.md#local-administration). Test-identity cleanup has no public HTTP route or SDK method.

## Open questions

- The Enrollment bootstrap credential, proof and delivery, and the trusted gateway binding, attestation and delegation fields. Credential formats, setup mechanics and route bindings are implementation choices; the gateway path does not require originating Core-format Asset signatures.
- Future taskability of gateways, including any Core contract changes needed for a gateway that also has an Asset identity.
- Registration identity encoding and credential proof and delivery fields.
- API-key wire encoding, verifier scheme and the exact setup commands for the first key and for recovery.
- Connection-close and error encoding for revocation, which is Protocol work.
- Retirement record fields and retry/response encodings beyond its selected HTTP binding.
- Operator profile fields and lifecycle.

## Decisions

- [ADR-0015](../adr/0015-separate-start-stop-restart-and-reset.md): what Restart, Reset and Hard Reset retain, including installation setup and credentials.
- [ADR-0019](../adr/0019-retire-assets-without-inventing-task-outcomes.md): retire Assets without inventing Task outcomes.
- [ADR-0020](../adr/0020-limit-general-sdk-to-http-and-full-sync.md): IP-connected Assets and radio gateways use the general SDK; gateways have their own identities.
- [ADR-0028](../adr/0028-trust-gateways-to-author-bound-asset-reports.md): authenticated gateways author reports for explicitly bound downstream Assets; future gateway taskability stays open.
- [ADR-0027](../adr/0027-administer-core-configuration-locally.md): all Core configuration inspection and editing is local.
- [ADR-0022](../adr/0022-one-publisher-per-track.md): Track publisher authorship, separate from broad operational access.
- [ADR-0023](../adr/0023-protect-required-entity-references-during-tasks.md): required Entity references stay protected when the assigned Asset is retired.
- [Activity history](history.md#activity-history) records credential changes and retirement; ADR-0003 is superseded by ADR-0015.

## Test evidence

These rows of the [required scenario coverage](../testing-strategy.md#required-scenario-coverage) apply:

- Asset identity and contact: Enrollment, registration retries, cross-Asset rejection, revocation, gateway limits, Open enrollment and re-provisioning.
- Open enrollment cleanup: retained warnings, confirmed selection, retirement or binding revocation, races, partial completion and retries.
- Asset retirement: every retirement workflow, race and retry.
- Asset deletion: credential revocation with deletion and its races.
- API-key creation: prepared secrets, retries and revocation.
- Reset and Restart: retained bindings, automatic re-registration and revoked identities.
- Hard Reset and retained setup: credentials retained by ordinary Reset and cleared by Hard Reset.
