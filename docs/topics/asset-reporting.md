# Asset reporting

This page owns what an Asset reports and how Core treats it: Operational status, Communication state, Contact and freshness, check-in, partial component updates and Asset report acceptance.

Identity, Enrollment and registration follow [Identity and access](identity-and-access.md). Task lifecycle, queues, Pause/Resume and reconnect reconciliation follow [Tasks](tasks.md). Movement samples follow [movement history](history.md#movement-history), and Track observations follow [Tracks](tracks-and-geofeatures.md#tracks).

## Components and initial values

Every Asset requires three components: `status` holds its Operational status, `communications` its Communication state and `heartbeat` its Contact. They belong to the Asset's Entity record and appear in ordinary reads and the SDK's synchronized operational picture. Changes to them are versioned Entity changes delivered through `/feed` and `/queries/changed-since`; there is no separate status stream.

[Asset registration](identity-and-access.md#asset-registration) creates the record with the values below and does not carry Operational status. The first check-in reports it.

| Component | Value before the first report |
| --- | --- |
| Operational status | `unknown` |
| Communication state | `offline` |
| Contact | `last_seen: null` |

Core does not invent a contact timestamp.

## Operational status

Operational status is the Asset's reported operational condition, separate from Task lifecycle states. Its values communicate state; they are not Core scheduling gates. Assets own queued and immediate Task execution, and Core does not use reported Operational status or Communication state to schedule their work.

| Status | Meaning |
| --- | --- |
| `unknown` | No usable operational report is available yet |
| `initializing` | The Asset is starting or preparing its capabilities |
| `ready` | The Asset is prepared to perform its advertised capabilities |
| `busy` | The Asset is executing work |
| `paused` | The Asset has handled an immediate Pause Command, suspended current queued work if any, and is waiting in its own idle behavior; queued work does not advance |
| `error` | A reported fault prevents normal operation; details explain the fault |
| `stopped` | The Asset has deliberately stopped operational activity |

Every Asset has an Operational status, even one that only reports observations. Being `ready` does not invent tasking capabilities the Asset has not advertised. Plugins are not Assets and do not report Operational status; their Operations and lifecycle follow [Plugins](plugins.md).

The status routes apply only to Asset Entities. A status report carries a complete status value, optional nullable reason and Protocol-defined details. Core accepts any listed current status from any previous Operational status when the report passes acceptance and ordering; it does not impose an execution transition graph on the Asset. Status supplied through the status route, check-in or an Entity report shares these rules. Unknown enums, invalid details and a missing status value reject the whole report.

### Transition examples

These examples explain reports, rather than restricting the transitions Core accepts.

| Situation | Example transition | Meaning |
| --- | --- | --- |
| Asset begins startup | `unknown` or `stopped` → `initializing` | Preparation is in progress |
| Preparation completes | `initializing` → `ready` | Advertised capabilities are available |
| Work starts | `ready` → `busy` | At least one operation is executing |
| Queue is drained | `busy` → `ready` | Asset reports that it is available again; finishing one Task need not imply an empty queue |
| Immediate Pause is applied | `busy` or `ready` → `paused` | Asset confirms suspension and its idle condition; the queued path is retained |
| Immediate Resume is applied | `paused` → `busy` or `ready` | Resume suspended work first; if none exists, release the waiting queue. Failed resumption follows the failure policy; report Task outcomes separately |
| A fault occurs | Any operational state → `error` | Report a reason; do not invent a Task outcome |
| Fault recovery | `error` → `initializing` or `ready` | Asset reports recovery |
| Deliberate stop | An active state → `stopped` | Asset reports stopping |

A reconnect can reveal a transition Core never observed. Core distinguishes a current state report from an instruction to perform a transition: reporting `stopped` is not a stop Command, and reporting `busy` is not Task acceptance.

### What Operational status does not establish

- A Task outcome. Core infers no Task outcome from a status report, including `error`. An Asset report and a Task report arrive separately, and one does not imply the other.
- Current availability. Core keeps the last reported Operational status and its report time visible; an old `ready` report does not prove the Asset is available now.
- Command support. A status value does not contain the Command Catalog; see [Command support](#command-support).
- Retirement. [Asset retirement](identity-and-access.md#asset-retirement) is a Core-owned administrative condition, not an Operational status.

### Report times

The status read includes `reported_at` (the report's original `generated_at`, or null), `received_at` (Core's receipt time for the accepted current status), and `changed_at` (Core time when the stored status value last changed). The initial three values are null. A newer report reaffirming the same status updates its report metadata but not `changed_at`; a duplicate updates neither. Telemetry-only reports do not update these fields. All receipt and change times are Core-owned. Contact freshness and the freshness of each reported quantity remain distinct.

## Communication state

Communication state is Core's assessment of its link with an Asset. It is required on every Asset and separate from Operational status.

| Communication state | Meaning |
| --- | --- |
| `high_bandwidth` | Communication is working with sufficient capacity for unrestricted Atlas communication |
| `healthy` | Communication is working as expected for a constrained link |
| `degraded` | Communication is available but impaired, regardless of connection type or nominal capacity |
| `offline` | Communication is unavailable |

High bandwidth is not tied to a specific connection technology. Connection type, such as Wi-Fi or Ethernet, is recorded separately. Healthy is relative to the link's expected performance: a constrained link is not degraded merely because it is slower than Wi-Fi. When communication deteriorates, degraded or offline takes precedence over high bandwidth, so a Wi-Fi connection can be degraded or offline.

### Derivation and link expectations

Core derives Communication state; no participant reports the state itself. Core uses the connection type, capacity class and link-quality observations reported by the Asset or its gateway, together with configured expectations for that link. A single timeout must not assume every link has Wi-Fi timing. The state is `offline` until the first fresh Contact. Core does not infer execution policy from Communication state.

The [Core configuration](dataset-lifecycle.md#core-configuration) keeps `contact_degraded_after_ms` and `contact_offline_after_ms` as adequate-IP defaults. A `contact_link_expectations` entry selected by the declared Protocol capacity class supplies `freshness_ms`, `degraded_after_ms` and `offline_after_ms`; all are positive durations and degraded is less than offline. These replace the timing assumptions for that class. A constrained class requires its own configured expectation before Core issues its contact proof; it does not inherit adequate-IP timing. Its authenticated reports can still be accepted without proving Contact. The default IP challenge window is 10,000 ms, separate from degradation after 3,000 ms and offline after 10,000 ms. Changing thresholds recomputes the derived state without creating Contact; newly issued challenges use the new freshness window and previously issued challenges retain their bounded expiry.

Under [ADR-0020](../adr/0020-limit-general-sdk-to-http-and-full-sync.md), a gateway reaches Core through the general SDK over an adequate IP link, and constrained radio communication runs between the gateway and its Assets.

## Contact and freshness

Contact is Core's record of the latest fresh accepted report from an Asset, held in the `heartbeat` component as `last_seen`. Core records the receipt time in [Core time](../adr/0025-use-core-time-as-the-installation-reference-clock.md); clients cannot supply it.

### What refreshes Contact

Every accepted fresh Asset-originated report refreshes Contact:

- check-in;
- component updates, including telemetry-only patches;
- Operational status updates;
- Task acknowledgements, starts, progress and outcomes;
- queue adoption and conflict reports.

A separate heartbeat packet is not required while other reports are arriving. An unchanged measurement in a newly generated report can still establish Contact when fresh. When a Task or queue report refreshes Contact, the Entity's heartbeat change commits and publishes atomically with the Task or queue change.

These never refresh Contact:

- Core's own derived changes;
- interface-originated Task creation or cancellation, and operator reorder requests;
- operator edits to Descriptive data, such as an alias;
- duplicate reports and historical backlog;
- a live gateway connection, which does not by itself establish Contact with an Asset behind it.

### Fresh, duplicate and historical reports

Core distinguishes fresh reports from the late arrival of delayed data. A report is fresh contact evidence only when the Asset's current process generated it within its freshness window, judged in Core time. Position in the report sequence never decides Contact: a previously unrecorded historical outcome delivered as the newest report after reconnection is recorded without making a disconnected Asset appear recently reachable. Core does not infer current reachability merely from a newly received old packet.

Delayed reports never overwrite newer component values. [Report acceptance](#asset-report-acceptance) applies this per affected state.

Continuous, near-real-time reporting is the expected operating model. The [workload profile](../architecture/operating-model.md#expected-workload) supplies sizing targets; a target rate is not proof of fresh Contact. Brief transport interruptions, retries and reordering use the evidence below. There is no planned long-disconnected store-and-forward workflow.

### Losing Contact

A disconnected Asset may still be physically executing a Task. Loss of Contact must not silently turn a Task into failed, completed or cancelled; [reconnect reconciliation](tasks.md#disconnection-and-reconnect-reconciliation) resolves it.

## Check-in

Check-in is an Asset's report of its current Entity data: Reported data such as Operational status, position and Command support. It establishes Contact when fresh, and Core records its receipt time. It does not deliver or reconcile Tasks; [reconnect reconciliation](tasks.md#disconnection-and-reconnect-reconciliation) combines it with Task catch-up and outcome reports.

Registration is followed by the first check-in, and the Asset checks in again as needed, directly or through its gateway. Check-in and component updates share Protocol-defined [partial-update](#partial-component-updates) validation, report identity and freshness rules, so later reports can contain only changed component fields.

### Command support

Assets advertise supported Protocol Commands on their Entity record. Command support is Reported data: only the Asset supplies it, at registration and check-in, rather than through a separate readiness session. It is distinct from Operational status. Dropping support for a Command does not remove outstanding Tasks that use it; [dropped Command support](tasks.md#dropped-command-support) defines how the Asset reports them.

## Partial component updates

Clients send partial component JSON through the existing Entity routes: the Entity patch and check-in. There is no separate registration, telemetry or per-component update endpoint. For example, an Asset can send only a changed heading. This illustrates the JSON structure, not a final SDK signature:

```json
{
  "components": {
    "telemetry": {
      "heading": 90
    }
  }
}
```

Existing position and other omitted fields remain unchanged. The merge rules are:

- Omitted fields remain unchanged.
- Supplied scalar fields replace previous values.
- Nested fields merge.
- Arrays replace completely.
- Explicit null removes an optional component or clears a nullable field.
- Removing a required component fails validation.
- A partial payload that creates an absent component must still satisfy that component's complete schema; it cannot create an invalid component.

Core validates the complete resulting resource against Protocol-defined component schemas and applicability, commits it atomically and emits the corresponding Entity change. The physical storage layout need not match the JSON envelope.

Operator-managed and other descriptive edits require the [concurrent-edit protection](../architecture/system-design.md#concurrent-descriptive-edits). Asset-originated reports use [report acceptance](#asset-report-acceptance) and ordering instead of that precondition.

### Mutation classes and atomic validation

An Entity patch contains exactly one mutation class: Descriptive edits, Asset Reported data, or Track Observed data. It cannot mix an Alias edit with an observation or telemetry report, even when the caller may author both. Derived and immutable fields are never writable. The [field ownership matrix](tracks-and-geofeatures.md#mutation-authority-matrix) identifies the classes. Creation keeps its own rules, including registration's permitted initial Command support.

Descriptive requests carry `expected_edit_revision`; Core maintains that revision separately from the Entity's synchronized resource revision. Only Descriptive changes advance the edit revision. Reports and Contact changes therefore neither invalidate a reviewed Alias edit nor permit that edit to overwrite reporting. Missing or stale preconditions reject an edit. Report requests carry `report_context` or a Track `observation_context`, not a descriptive precondition. Supplying evidence for a second mutation class does not make a mixed request valid.

Core validates field applicability, caller authority, class separation and the complete merged result before committing. Unsupported fields, immutable/Derived fields, invalid nested values, removal of a required component and a case-insensitive Alias collision reject the entire request. Errors identify offending JSON paths with `mixed_mutation_classes`, `forbidden_field`, `invalid_component`, `alias_conflict`, or `edit_conflict`; authorization failures expose no foreign resource data. Rejection writes no acceptance identity, component, Contact, sample or public change. Arrays replace as units. A movement position supplied for ingestion must contain both latitude and longitude; Core never obtains a missing coordinate from the merged Entity to create a sample.

## Report authority and relay

The Asset authors its Reported data. Interfaces send Tasks rather than editing the Asset directly, and an operator cannot submit Asset-reported components. Operators may edit Descriptive data, such as the alias, without passing through report acceptance; such edits never touch Contact. Core owns Derived data: Communication state, Contact, receipt timestamps and resource versions.

Core verifies the reporting Asset's identity on every reporting path under the [Asset caller rules](identity-and-access.md#assets).

A [radio gateway](identity-and-access.md#radio-gateways) relays reports only for its bound Assets. Through the translation it preserves each Asset's report origin, process authority, current work and required live data. A gateway restart does not by itself establish that an Asset process restarted or lost execution knowledge, and a gateway cannot invent execution evidence.

## Asset report acceptance

Every Asset-originated report passes through one acceptance contract before anything is applied: check-in, component and Operational status updates, Task lifecycle reports and queue adoption or conflict reports. Acceptance gives two independent answers. The disposition decides what to apply:

| Disposition | Meaning | Effect |
| --- | --- | --- |
| Accepted | A new report from the bound Asset's current process | Apply each reported fact that does not move its affected state backwards, judged per affected state: Task outcomes, component values and movement samples with their observation time. A newer recorded value is never overwritten |
| Duplicate | A report already accepted | No new effect; return current recorded state |
| Rejected | Wrong principal, obsolete process, or not an Asset report | No effect; explicit rejection |

Separately, contact evidence says whether an accepted report proves the Asset is reachable now, under the [freshness rule](#fresh-duplicate-and-historical-reports). Only then does acceptance refresh Contact.

Report deduplication, ordering of affected state and proof of fresh contact stay distinct. Later telemetry must not discard an unrecorded Task outcome solely because the outcome has an earlier sequence, and accepting historical work must not refresh Contact. An obsolete process is identified by the Core-issued process generation and authority transfer from [Asset recovery](tasks.md#recovery-after-an-unexpected-asset-restart). [Asset registration](identity-and-access.md#asset-registration) is not a report.

Core persists accepted-report identities and ordering boundaries across same-release Restart, atomically with affected component values, Contact and movement samples. Reset clears that state and rejects old-Dataset reports. Store canonical original report facts and acceptance results, not a complete packet log. [System design](../architecture/system-design.md#shared-asset-report-acceptance) describes how Entities and Tasks collaborate.

### Shared report context

Protocol defines one `report_context` used by check-in, Entity/status reporting, Task lifecycle and result declarations, and queue adoption/conflict reporting. `Atlas-Dataset-ID` and `Atlas-Protocol-Version` are request headers; they participate in report identity and signed facts without being duplicated in component schemas. Identifiers are opaque UUID strings; counters are unsigned 64-bit decimal strings. A context contains:

| Field | Contract |
| --- | --- |
| `asset_id` | Claimed origin; must match the authenticated Asset binding or the gateway's authorized origin binding |
| `process_generation` | Core-issued generation, starting at `"1"` in a Dataset; not a Dataset ID or a caller-selected process authority |
| `sequence` | Positive counter allocated once across all reporting routes by that process; never reused for another report or reset within the generation |
| `generated_at` | Original onboard report/fact time in Core time, or null when unknown; retries and recovery retain it rather than substituting transmission time |
| `clock_uncertainty_ms` | Nonnegative offset uncertainty, or null with unknown time; no unknown value defaults to zero |
| `evidence_kind` | `current` for a newly generated current report, `historical` for retained execution/observation evidence |
| `evidence_origin` | Original `process_generation`/`sequence` for recovered historical facts when known, otherwise null; never a claimed replacement authority |
| `retained_evidence_id` | Stable UUID retained by the Asset OS for historical facts whose original ordering is unknown; required in that case, null otherwise; preserved across retransmission and process replacement |
| `observation_times` | Optional timing by explicitly supplied movement quantity: `observed_at` and `clock_uncertainty_ms`; omitted/unknown observation time stays null, rather than inheriting send/receipt time |
| `contact_challenge` | Opaque Core challenge, or null; absence prevents fresh Contact but does not invalidate a legitimate report |
| `process_proof` | Ed25519 signature made by the current process over canonical report facts, including headers, context except this signature, operation kind, target ID and typed payload |

The report identity is `(dataset_id, asset_id, process_generation, sequence)`, independent of route. Core compares canonical validated facts, preserving omission versus null and array order while ignoring object-key order. Reuse on another route/target or with changed facts returns `report_identity_conflict`. Matching retries return `disposition: duplicate`, the original acceptance receipt and current resource state; they do not reapply facts or establish Contact. Authorization and current-generation checks precede duplicate replay, so old signatures or revoked credentials cannot regain access by retry.

Current evidence has null original/retained identity fields. Historical evidence carries either `evidence_origin` or `retained_evidence_id`, never both. An original ordering pair must use a positive sequence and a generation Core previously issued to this Asset in this Dataset, no greater than the current generation. The current process signature attests recovered facts; the original pair is correlation/order evidence, not permission to use an obsolete signing key.

The Asset client prepares identity and signed facts before submission and hands pending facts to its Asset OS when they must survive a restart. It never gives an unknown-outcome retry a new sequence. Signing-key ownership remains in the Asset or its trusted runtime; a gateway forwards originating signatures and cannot sign new execution evidence for an Asset. Use [RFC 8785 JSON canonicalization](https://www.rfc-editor.org/rfc/rfc8785) on the validated facts for signatures; retain omission versus null and array order, and reject duplicate object keys or nonfinite numbers. Ed25519 follows [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032), with keys and signatures encoded as unpadded base64url. These encodings are shared Protocol material, not independent route conventions.

### Ordering and independent effects

Ordering compares `(process_generation, sequence)` separately for each supplied Reported scalar/array, complete status record, Task's execution stream and queue confirmation stream. A recovered historical report uses its original `evidence_origin` for current component ordering; its newly assigned outer sequence is only its acceptance identity. Unknown historical origin cannot replace current component values, though valid execution evidence and explicit movement history can still be recorded. This prevents a replacement process from making old telemetry newer merely by signing it in a new generation. Position latitude and longitude form one movement quantity and must be supplied together. Other telemetry quantities, such as speed, altitude and heading, have independent boundaries. A report can update heading without changing position age or rejecting a later-arriving position report that is newer for position. Removing an optional reported field retains its ordering tombstone so an older report cannot restore it.

An accepted historical report may leave all current values unchanged. It still records its previously unknown valid Task outcome and appends explicitly supplied movement facts once. Movement deduplication uses the original fact identity and quantity, independently of its outer report identity: `(Dataset, Asset, original generation/sequence, quantity)`, or `(Dataset, Asset, retained_evidence_id, quantity)` when original ordering is unknown. Current reports use their own generation/sequence as the original identity. The trusted Asset OS allocates and retains an unknown-origin evidence ID before its first recovery submission and preserves it in every later re-signing. A new process or outer sequence does not create another sample for the same fact. Core compares canonical quantity values and original observation timing; changed facts under that key return `evidence_identity_conflict`, while equal facts have no second movement effect. Previously accepted original reports and later recovery submissions use the same deduplication key. Unknown-origin evidence can be captured but cannot replace current components or prove fresh Contact.

Task transitions also obey the [terminal/control rules](tasks.md#task-status-and-transitions), so ordering never authorizes a conflicting terminal outcome or manufactures completion. The pure transition module decides the Task effect before the shared transaction commits. A semantically invalid Task/result/queue report is rejected atomically; a valid older component value is an accepted no-op for that field, not a whole-report rejection.

Entity reads expose a Core-owned `reporting` map keyed by Protocol reporting unit, containing the applied `process_generation`, `sequence`, `reported_at`, `received_at` and `time_quality` (`known`, `unknown`, or `uncertain`), plus explicit movement `observed_at`/uncertainty when supplied. Current ordinary reports use their own ordering pair; recovered facts retain their original pair. Report generation, measurement observation and Core receipt time stay distinct. This metadata changes only with that unit's current value/report, not another field or Contact. It is resource metadata, not a client-defined component. The map is empty before the first report, including for initial Command support supplied through registration.

The SDK result contains `disposition`, `report_id` (the four identity fields), `received_at`, `applied_fields`, `task_effect`, `movement_sample_ids` and `contact_refreshed`, alongside the route's current resource result. `task_effect` is `changed`, `unchanged`, or `not_applicable`. Accepted no-op and duplicate are successful results; rejection uses the ordinary typed error with a rejection code. A transport timeout has unknown acceptance outcome and follows [safe retry](sdk.md#writes), never an invented rejection. This result is not a synchronization input.

### Contact proof and clock uncertainty

An authenticated `GET /health` can request a `contact_challenge` for its bound Asset and current or candidate next generation; a gateway can request one only for a bound Asset. The response supplies Core time and challenge expiry. Core authenticates the token, binding it to Dataset, Asset, generation and the current Core run. The default IP freshness window is 10,000 ms, with link-specific expectations configurable under the Communication-state policy. The Asset client refreshes its challenge while connected rather than requesting one for every report.

Contact refresh requires all of these facts: a newly accepted current-process report; `evidence_kind: current`; a valid matching challenge received before report generation; the complete generated-time uncertainty interval within that challenge's issued/expiry interval; and receipt before expiry. Token expiry uses Core's monotonic clock. A clock discontinuity invalidates outstanding challenges and requires another offset estimate; Restart invalidates the previous run's challenges. Neither a wall-clock adjustment nor a replay can revive freshness. Core records `last_seen` at acceptance receipt time, not at a client timestamp. A candidate first check-in may obtain a challenge for `expected_generation + 1`, but it must also establish that generation with the authority claim below.

Unknown or inconsistent timing means `contact_refreshed: false`; it does not erase valid historical execution evidence. `sent_at`, gateway forwarding time and HTTP connection liveness are not contact evidence. Recovering an old outcome into a new sequence retains `evidence_kind: historical` and its original fact time. A separate fresh check-in may establish current Contact without changing that historical outcome's age. A gateway supplies the Asset-originated signed challenge/time facts; its own fresh connection cannot refresh an Asset.

### Process authority establishment and replacement

Enrollment binds an installation-retained recovery public key to the Asset principal under [identity provisioning](identity-and-access.md#asset-process-authority). The corresponding private key belongs to the trusted Asset OS/deployment authority, not to an ordinary reporting process or gateway. The process prepares a new Ed25519 key and a stable `process_id` and `transfer_id` before requesting replacement; pending claims survive lost responses through caller-owned retention.

The existing check-in route accepts an `authority_claim` with `transfer_id`, `process_id`, `expected_generation` (`"0"` initially), `process_public_key` and `recovery_proof`. The process signature covers the Entity report without `authority_claim`; the recovery signature covers the claim except its proof and binds the first signed report's canonical digest, Dataset and Asset ID. There is no circular signature input. Core verifies deployment authorization, candidate key possession and the principal binding, then atomically compares the expected generation, establishes the next generation and accepts that first Entity report. This carries no Task delivery or scheduling decision and creates no execution-session resource or separate recovery endpoint.

Two different claims against the same expected generation cannot both succeed. The winner installs one key and generation; the loser returns `generation_conflict` without effects and must obtain a fresh authorized claim after inspecting the recorded result. Retrying the winning identical claim returns the original authority association and report result while that generation remains current. Changed reuse conflicts. After another replacement, replay returns `obsolete_process`, not a newly issued generation. An old hello, ordinary Asset credential, claimed process ID or old process signature is not replacement authorization.

An obsolete process's reports are rejected, including previously unknown terminal reports. The replacement process can submit the Asset OS's trustworthy retained execution evidence under its new authority with original evidence times; a newer telemetry sequence does not suppress it. Uncertain work stays subject to [explicit recovery](tasks.md#recovery-after-an-unexpected-asset-restart), rather than being automatically executed. A transfer proves report authority, not that the old process physically stopped. Restart retains authority, claims, ordering and acceptance; Reset clears Dataset authority and needs a fresh claim under surviving installation identity. Revocation rejects both new and replayed claims.

### Independent packet fixtures

Each row states expected behavior, not an executed test. Start with Dataset D, Asset A, generation 1, position sequence 10 at P10, pending Tasks T/U and `last_seen: null`. Fresh cases use a matching challenge and bounded current timestamp; historical cases do not. The rows form one sequence. Alias/authorization rows change none of the report boundaries. The gateway case supplies U's previously unrecorded historical progress, leaving it nonterminal for the later recovered outcome. Movement cases supply original observation timing explicitly, or state that it is unknown.

| Packet or race | Disposition | Entity and Task | History | Contact |
| --- | --- | --- | --- | --- |
| Position P12, sequence 12, fresh, receipt 100 | Accepted | Position becomes P12; T pending | One sample P12 | 100 |
| Identical 12 after lost response, receipt 101 | Duplicate | Unchanged | No sample | Remains 100 |
| Same 12 with P99 | Rejected identity conflict | Unchanged | No sample | Remains 100 |
| Historical position P11, sequence 11, origin (1,11) | Accepted | P12 retained; T pending | One P11 sample with original time | Remains 100 |
| Fresh heading, sequence 20, receipt 103 | Accepted | Heading changes; position remains P12 | No position/speed/altitude sample | 103 |
| Position P15, sequence 15, historical, origin (1,15) | Accepted | P15 becomes current position despite heading 20 | One P15 sample | Remains 103 |
| Previously unrecorded T completion, sequence 13, historical, origin (1,13) | Accepted | T Completed on the Asset report, independently of result uploads | No movement sample | Remains 103 |
| Current position 21 with unknown or skewed generated time and omitted observation timing | Accepted | Position applies by its sequence | One sample; observation time remains unknown | Remains 103 |
| Fresh position 22 at receipt 104; observation time 500, uncertainty 1 ms | Accepted | Position applies by sequence; observation time is uncertain | One sample retaining future 500 and receipt 104 | 104; report freshness does not make its observation fresh |
| Operator Alias edit with valid edit revision | Ordinary edit | Alias changes; reporting unchanged | No sample | Remains 104 |
| Position report with another Asset ID, or derived heartbeat field | Rejected | No state or acceptance identity | No sample | Remains 104 |
| Bound gateway forwards U's historical signed progress, sequence 14, origin (1,14) | Accepted once | Valid progress recorded; gateway times ignored | No movement sample | Remains 104 |
| Gateway supplies invented signature or relays unbound origin | Rejected | No state or acceptance identity | No sample | Unchanged |
| New candidates C1/C2 both expect generation 1; first reports contain only fresh status ready at receipt 110 | One accepted, one generation conflict | Only winner becomes generation 2; one ready report | No movement sample | 110 from winner |
| Winner repeats after lost transfer response | Duplicate claim/report | Same generation/key and current state | No duplicate | Unchanged |
| Old generation 1 terminal packet or old hello replay | Rejected obsolete process | No new outcome or authority | No sample | Unchanged |
| Generation 2 reports fresh heading sequence 20 at 120, then U's retained completion sequence 21/origin (1,16) | Both accepted | Heading applies and previously unknown U outcome is retained | No movement sample | 120; historical outcome adds no Contact |
| Generation 2 sequence 22 repackages the already recorded P11 with origin (1,11) | Accepted | Current position 22 retained despite new outer generation | No second sample for original (1,11)/position | Remains 120 |
| Generation 2 changes P11's value/time under original (1,11) | Rejected evidence identity conflict | Current position retained | No sample | No refresh |
| Generation 2 historical position has unknown original ordering and stable retained evidence ID H | Accepted | Current position retained | One supplied historical sample keyed H/position, with explicit timing | Remains 120 |
| Another outer sequence or replacement process repeats identical H/position | Accepted or duplicate by outer identity | Current position retained | No second H/position sample | No refresh |
| Historical position has neither original ordering nor a retained evidence ID | Rejected invalid evidence | No effects | No sample | No refresh |
| Restart, then repeat an accepted packet | Duplicate with retained identity | State retained | No sample | No refresh |
| Reset, then send D packet or claim | Rejected obsolete Dataset | New Dataset unchanged | No sample | No refresh |

For atomic-failure fixtures, fail the SQLite commit after acceptance/transition decisions and before persistence, then retry after Restart: the failed attempt has no acceptance identity, domain effect, sample, Contact or change record; the retry applies each exactly once. Exercise every reporting route, including Task result declarations, with the same independent context fixtures.

| Independent Entity-patch fixture | Expected result |
| --- | --- |
| Valid position plus stale Alias edit | `mixed_mutation_classes`; neither value, Contact nor sample changes |
| Separate valid position then stale Alias request | Position/report effects commit; Alias returns `edit_conflict` |
| Asset credential edits its own Alias with a valid edit revision | `forbidden_field`; no descriptive revision, report identity, sample or Contact effect |
| Bound gateway edits that Asset's Alias with a valid edit revision | `forbidden_field`; relay binding does not grant descriptive editing |
| Operator or managed Plugin edits Alias with a valid edit revision | Alias changes atomically; observations, report ordering, samples and Contact remain unchanged |
| Own-Asset report with another Asset's origin/proof | Authorization rejection of the whole report |
| Track Alias plus publisher observation | Mixed-class rejection even for the publisher; separate requests may succeed |
| Operator supplies another publisher's Track observation or any Asset status | `forbidden_field`; no report effects |
| Caller supplies Communication state, Contact or resource version | `forbidden_field`; no partial application |
| Nested valid heading-only patch | Heading changes; omitted position/altitude preserved |
| Explicit null removes required status, or partial absent component stays invalid | `invalid_component`; no report identity or effects |
| Alias differs from another Entity only by case | `alias_conflict`; no descriptive revision advances |

## Source reference

The [source reference](../atlas-modernization-reference.md#earlier-asset-reporting-design) records the earlier design and its pinned sources.

## Routes and SDK operations

- Check in: `POST /entities/{entity_id}/checkin` in the [Entities routes](../api-endpoints.md#entities), through the SDK's Check in [operation](sdk.md#operations-catalog) and [Asset startup](sdk.md#asset-startup).
- Update Asset components: `PATCH /entities/{entity_id}` in the [Entities routes](../api-endpoints.md#entities), through Update Asset components.
- Read and report Operational status: `GET` and `PATCH /entities/{entity_id}/status` in the [Asset status routes](../api-endpoints.md#asset-status), through Report Asset status.
- Task lifecycle and queue adoption reports: `PATCH /tasks/{task_id}/status` in the [Tasks routes](../api-endpoints.md#tasks) and `POST /entities/{entity_id}/task-order/confirm` in the [Entities routes](../api-endpoints.md#entities). They refresh Contact under this page.
- Task result declarations: `POST /tasks/{task_id}/results` in the [Tasks routes](../api-endpoints.md#tasks), with the same shared acceptance independently of terminal status and Object readiness.
- The SDK's [Asset client](sdk.md#asset-client) submits every Asset-originated report and owns its report identity, ordering and the Core-issued process generation.

## Open questions

- Communication state capacity/quality criteria and link-observation payload schemas beyond the timing expectations above.
- Concrete Protocol component schemas beyond the declared reporting units, generated signature/canonicalization bindings and measured freshness settings for future constrained links.
- Radio packet encoding and transport delivery; originating signature and authority semantics above remain required.

## Decisions

- [ADR-0004](../adr/0004-core-owns-commands-and-assets-execute-tasks.md): Core owns Commands and Assets execute Tasks.
- [ADR-0007](../adr/0007-reconcile-asset-tasks-after-disconnection.md): Task and queue reports, process generation and authority transfer, and no Task outcome inferred from lost Contact.
- [ADR-0015](../adr/0015-separate-start-stop-restart-and-reset.md): acceptance state survives Restart and is cleared by Reset.
- [ADR-0020](../adr/0020-limit-general-sdk-to-http-and-full-sync.md): IP-connected Assets and gateways report through the general SDK's Asset client; constrained links sit behind gateways.
- [ADR-0025](../adr/0025-use-core-time-as-the-installation-reference-clock.md): Contact freshness is judged in Core time.

## Test evidence

These rows of the [required scenario coverage](../testing-strategy.md#required-scenario-coverage) apply:

- Asset identity and contact: fresh versus duplicate and stale reports, queue reports and Contact, operator actions that never establish Contact, and alias edits that do not disturb reporting.
- Asset-process recovery: later telemetry before an unrecorded Task outcome, and historical traffic that does not establish fresh Contact.
- Reset and Restart: retained acceptance state, and duplicate or delayed reports that cannot refresh Contact or overwrite newer data.
- Every public SDK operation: absent, null and partial-field behavior.
- Task queues: no Core scheduling gate based on Communication state.

[Fault and bandwidth testing](../testing-strategy.md#fault-and-bandwidth-testing) adds shared acceptance through Entity and Task reporting against real SQLite, closing the reporting contract in the first Asset reporting workflow, and the accepted, duplicate and rejected dispositions through every reporting route. [Radio gateway testing](../testing-strategy.md#external-systems-and-future-radio-gateways) requires that a gateway's live connection never turns a delayed report into fresh Contact.
