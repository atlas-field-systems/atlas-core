# Specification evidence and implementation sequence

This page maps accepted contracts to implementation slices and required evidence. It does not establish new behavior or claim an implemented Core. The user keeps product implementation on hold until the existing specification tickets are resolved and closed. The isolated [Protocol experiment](../research/atlas-reassessment/13-protocol-toolchain-proof.md) supplies the executable evidence requested by #69 without starting product implementation.

## Proposed sequence and completion boundaries

| Slice | Scope and prerequisite specifications | Required completion evidence |
| --- | --- | --- |
| S0: Protocol/toolchain | Shared authored schema profile, locks and validation boundaries; #69 | Deterministic clean regeneration, independent valid/invalid fixtures, generated Go handler and TypeScript client with actual SQLite/files; the linked experiment records its tested limits |
| S1: Asset-to-Core Move To | TLS/bootstrap and Dataset/version boundary; enrollment, registration, report identity/process authority, basic ordered delivery, cancellation and actual outcomes; #63/#66/#71/#78/#79/#81/#82 | Real SDK/Core/direct-Protocol parity with simulated Asset, lost responses, offline issuance/cancellation, historical versus fresh reports, initial defaults, movement capture, no arrival or upload gate |
| S2: Independent Object transfer | File-first durable publication, replayable producer, identity/digest, quota, deletion and protected hold seam; #70/#72 | Actual SQLite/filesystem kill barriers, interrupted/lost-response upload, concurrency/revocation/Reset races, exact downloaded bytes, download/delete ordering and no exposed partial Object |
| S3: Independent Elevation Plugin | Manifest/capability validation, private dispatch ledger, local host lifetime and offline fixture; #64/#68/#76/#78/#79/#80 | Separately built Plugin container, accepted work survives caller loss, dispatch acknowledgement lost without re-execution, known elevation/reference, cancellation/stop/fault and retained Operation lookup |
| S4: Both SDK modes and recovery | Complete-picture commit framing, initial-load/replay/live handoff, query/feed bounds, unknown outcomes; #65/#66/#71/#77 | Existing S1–S3 operational workflows in HTTP and Full synchronization modes plus independent direct Protocol fixtures; fragments, page races, late responses, deletions, expiry, Reset and zero hidden read fallback |
| S5: Administrative/history completion | Operator/config/credentials/activity APIs, retirement, deletion and test-enrollment cleanup; #63/#67/#68/#71/#76/#79/#80/#82 | Real SDK and local-management workflows preserving identity/denials, revocation cutting off open feeds, protected work retained and attributed actions without secret disclosure |
| S6: Broader tasking and observations | Queue edits, immediate/Pause/Resume, scan declarations, live geometry, Track publishers/corrections/freshness; #63/#66/#73/#74/#75/#76/#78/#81 | Independently authored packet tables through actual SDK/Core, immutable outcomes, reported active/suspended work, saved/applied geometry, declaration/upload races, per-quantity age and retained history |
| S7: Full lifecycle and workload evidence | Installation-only format evolution, supervised Stop/Restart/Reset/Hard Reset, private Plugin cleanup, configuration and limits; #67/#68/#70/#72/#79/#80 | Real Linux management/Docker/storage/TLS fault injection after CLI exit, interruption at every action phase, retained identity through update, measured workload/resource/refusal results and no silently lost accepted work |
| S8: External field/extension validation | Real Asset OS/hardware and an independently maintained removable Plugin; later radio gateway only when supplied | Real physical Command with contact loss/cancellation/process uncertainty; external Plugin installation/removal; radio transport and RF evidence when that integration exists |

S1–S3 are incremental workflow slices, not a release that waives Full synchronization parity. The initial Core-contract MVP is complete only when its applicable S4 coverage and the MVP Stop/Start/Restart/Reset checks pass. Implement the necessary lifecycle/bootstrap seams with those workflows; S7 extends them to the full interruption/update and measured-load matrix. Each new feature ships its required fault evidence, rather than postponing correctness until S7.

## Public API and SDK inventory

The [endpoint map](../api-endpoints.md) currently specifies 53 method/path pairs. This inventory groups all 53; it links current authority instead of copying each contract. Every corresponding method in the [SDK operations catalog](../topics/sdk.md#operations-catalog) has the same owner. Administrative/history/content methods remain explicit HTTP operations in either SDK mode; operational picture reads use the selected mode's source.

| Accepted route group | Count | Owning slice and SDK operation coverage | Authority |
| --- | --- | --- | --- |
| Entity list/create/get/alias/patch/delete | 6 | S1 Asset paths; S6 Track/Geofeature variants; Entity CRUD/helpers in both modes | [Entities](../topics/tracks-and-geofeatures.md), [registration](../topics/identity-and-access.md#asset-registration) |
| Entity movement-history and associated-Object reads | 2 | S1 movement capture/read, S2 Object associations, S6 corrections; explicit history/content metadata reads | [History](../topics/history.md), [Objects](../topics/objects.md) |
| Asset check-in and status get/patch | 3 | S1 Asset client/startup/status helpers | [Asset reporting](../topics/asset-reporting.md) |
| Assigned Tasks, order edit and confirmation | 3 | S1 default assigned work; S4 coherent reads; S6 queue operations | [Queue representation](../topics/tasks.md#queue-representation-and-coherent-reads) |
| Asset retirement | 1 | S5 `POST /entities/{entity_id}/retire`, retirement helper and retries | [Retirement](../topics/identity-and-access.md#asset-retirement) |
| Task list/create/get/status | 4 | S1 Move To lifecycle; S6 immediate/control/scan variants; Task helpers | [Tasks](../topics/tasks.md) |
| Task result declaration | 1 | S6 Asset client append-only `POST /tasks/{task_id}/results` | [Results](../topics/tasks.md#result-declarations-and-execution-fixtures) |
| Task associated-Object read | 1 | S2 ready associated Objects; S6 late declared output | [Objects](../topics/objects.md#routes-and-sdk-operations) |
| Object list/upload/get/metadata patch/delete/download/view | 7 | S2 all Object methods and replayable producer; S6 protected result declarations | [Object transfer](../topics/objects.md#durability-and-publication-fixtures) |
| Core config get/patch and resource diagnostics | 3 | S5 supported administrative SDK methods; S7 validation/application/overload | [Configuration](../topics/dataset-lifecycle.md#core-configuration) |
| Activity read | 1 | S1 issuance/cancellation attribution; S5 complete historical-read method | [Activity history](../topics/history.md#activity-history) |
| API-key list/create/revoke | 3 | S1 first-key bootstrap; S5 public management helpers | [API keys](../topics/identity-and-access.md#api-keys) |
| Operator list/create/get/patch/delete | 5 | S5 profile/settings methods with retained attribution | [Operators](../topics/identity-and-access.md#operator-clients) |
| Plugin list/get | 2 | S3 discovery; S5 historical removed identity | [Plugins](../topics/plugins.md#plugin-capabilities-and-discovery) |
| Plugin Operation submit/list/get/cancel | 4 | S3 capability invocation and retained outcomes; S6 broader consumers | [Operation dispatch](../topics/plugins.md#private-operation-dispatch-and-reconciliation) |
| Full load, changed-since and WebSocket feed | 3 | S4 full picture, Core/local changed-since, status/query/feed helpers | [Synchronization](../topics/sdk.md#synchronization-wire-and-application-boundary) |
| Health/readiness/docs/OpenAPI | 4 | S0 authored schema; S1 authenticated discovery/Core time/Asset challenge; S4 reconnect; S5 diagnostics | [Setup](../topics/dataset-lifecycle.md#offline-tls-and-first-time-setup), [Contact proof](../topics/asset-reporting.md#contact-proof-and-clock-uncertainty) |

Local Command Catalog lookup is a package function, not an extra HTTP route, and belongs to S0/S1. Connection, readiness, query, local subscription/history and Dataset-rebuild SDK methods belong to S4. The Asset client wraps registration, reports, assigned work, result uploads, queue adoption and reconnect/process recovery in S1/S6 without implementing the Asset OS.

## Local actions and retained state

| Accepted local operation | Owning slice | Evidence and authority |
| --- | --- | --- |
| First-time setup, trust/key provisioning and lost Asset credential replacement | S1/S5 | Offline TLS/identity fixtures, secret-safe diagnosis, same identity without credential revival; [setup](../topics/dataset-lifecycle.md#offline-tls-and-first-time-setup) |
| Start/Stop/Restart | S1–S3 baseline, S7 full faults | Core/Plugin lifetime and explicit incomplete shutdown; [supervision](../topics/dataset-lifecycle.md#host-supervision-and-private-coordination) |
| Reset/Hard Reset and update-with-Reset | S1–S3 Reset seam, S7 full cleanup/update | New Dataset, completed/pending action distinction, installation-only conversion, all owned cleanup and unrelated resource preservation; [lifecycle](../topics/dataset-lifecycle.md) |
| Plugin install/update/remove/enable/disable/start/stop/restart/configure | S3, S7 full faults | Active-work policy, independent process lifecycle, private working/setup separation, retained Operations and publisher proof; [Plugin administration](../topics/plugins.md#local-administration) |
| Open enrollment switch and selected test identity cleanup | S5 | Retained provenance/warnings/denials, races and retry; [cleanup](../topics/identity-and-access.md#cleanup-after-testing) |
| Core deferred config apply and invalid-setting repair | S7 | Desired/active revisions, startup gate, no automatic fallback/wipe; [configuration](../topics/dataset-lifecycle.md#core-configuration) |

## Required-scenario homes

Every row of the [required scenario table](../testing-strategy.md#required-scenario-coverage) has a feature-triggered home below. These are future completion obligations; the isolated toolchain experiment does not pass them.

| Required scenario group | Owning slice |
| --- | --- |
| Every public SDK operation | S1–S7 for the corresponding inventory owner; direct Protocol parity and both-mode assertions with each operational feature |
| Open enrollment cleanup | S5 |
| Asset identity and contact | S1, extended by S5/S6 |
| Asset retirement | S5 |
| Asset deletion | S1 guard, S5 full races/revocation |
| API-key creation | S1 bootstrap, S5 public retry/revocation |
| Task lifecycle | S1, extended by S6 |
| Required Entity references | S6 |
| Track observation ownership | S6 |
| Track observation corrections | S6 |
| Live Geofeature geometry | S6 |
| Scan geometry and result completion | S6 |
| Track freshness during execution | S6 |
| Immediate Commands and Pause | S6 |
| Task queues | S1 default order, S4 read coherence, S6 edits/control |
| SDK modes | S4 and every later operational feature |
| Synchronization | S4 and every later synchronized resource |
| Asset-process recovery | S1/S6; S8 physical evidence |
| Reset and Restart | MVP seams in S1–S3/S4; full faults in S7 |
| Hard Reset and retained setup | S7 |
| Objects and histories | S1 movement, S2 Objects, S5 activity, S6 Track/result cases |
| Plugin Operations | S3 |
| Plugin operational storage | S3 installation separation, S7 interruption/cleanup matrix |
| Resource limits | S2 upload reserve, S4 buffers/picture guards, S7 measured combined workload |

Cross-cutting validation focus remains mandatory with its triggering feature: shared commits/retries/Dataset boundaries, compatible/unsupported contracts, actor authority/revocation, clock uncertainty, movement/activity deduplication, secret redaction and background-work lifetime. Independent transition-model tests supplement, rather than replace, real SQLite/files/HTTP/Plugin integration. Meaningful failures, reproducible schedules and supported versions must be recorded before claiming completion.

## Specification ticket evidence

All of these tickets request specifications, with runtime verification later except the executable experiment explicitly required by #69. This mapping is evidence for review; it does not change their GitHub state or mark application tests passed.

| Ticket | Concrete current specification/evidence | Future workflow owner |
| --- | --- | --- |
| [#63](https://github.com/atlas-field-systems/atlas-core/issues/63) | [Report context, authority, freshness and packet tables](../topics/asset-reporting.md#shared-report-context) | S1/S6 |
| [#64](https://github.com/atlas-field-systems/atlas-core/issues/64) | [Private dispatch, ledger and failure table](../topics/plugins.md#private-operation-dispatch-and-reconciliation) | S3 |
| [#65](https://github.com/atlas-field-systems/atlas-core/issues/65) | [Commit frames and worked load/replay interleaving](../topics/sdk.md#synchronization-wire-and-application-boundary) | S4 |
| [#66](https://github.com/atlas-field-systems/atlas-core/issues/66) | [Empty/requested/confirmed queue and coherent pages](../topics/tasks.md#queue-representation-and-coherent-reads) | S1/S4/S6 |
| [#67](https://github.com/atlas-field-systems/atlas-core/issues/67) | [Retained formats, drift refusal and explicit update](../topics/dataset-lifecycle.md#retained-formats-and-explicit-release-update) | S7 |
| [#68](https://github.com/atlas-field-systems/atlas-core/issues/68) | [Host owner, durable phases, state diagram and interruption fixtures](../topics/dataset-lifecycle.md#host-supervision-and-private-coordination) | S3/S7 |
| [#69](https://github.com/atlas-field-systems/atlas-core/issues/69) | [Pinned executable Protocol proof](../research/atlas-reassessment/13-protocol-toolchain-proof.md) | S0, coverage extended with every production contract |
| [#70](https://github.com/atlas-field-systems/atlas-core/issues/70) | [Workload targets, bounds, overload and measurements](operating-model.md#expected-workload) | S7 |
| [#71](https://github.com/atlas-field-systems/atlas-core/issues/71) | [Outcome categories and operation retry matrix](../topics/sdk.md#mutation-outcomes-and-retries) | S1–S7 |
| [#72](https://github.com/atlas-field-systems/atlas-core/issues/72) | [Durability primitives, source replay and deletion fixtures](../topics/objects.md#durability-and-publication-fixtures) | S2/S7 |
| [#73](https://github.com/atlas-field-systems/atlas-core/issues/73) | [Asset-owned queue advance and upload/control packet table](../topics/tasks.md#result-declarations-and-execution-fixtures) | S6 |
| [#74](https://github.com/atlas-field-systems/atlas-core/issues/74) | [Append-only independent declarations and geometry evidence](../topics/tasks.md#result-declarations-and-execution-fixtures), [ADR-0026](../adr/0026-record-asset-completion-independently-of-result-availability.md) | S6 |
| [#75](https://github.com/atlas-field-systems/atlas-core/issues/75) | [Per-quantity times, corrections and observation fixtures](../topics/tracks-and-geofeatures.md#observation-identities-ordering-and-time) | S6 |
| [#76](https://github.com/atlas-field-systems/atlas-core/issues/76) | [Publisher continuity](../topics/identity-and-access.md#publisher-continuity), [historical installation/Operation identity](../topics/plugins.md#installation-and-historical-identity) | S3/S6 |
| [#77](https://github.com/atlas-field-systems/atlas-core/issues/77) | [Queries/cursors, local subscriptions and expected answer tables](../topics/sdk.md#query-and-status-contract) | S4 |
| [#78](https://github.com/atlas-field-systems/atlas-core/issues/78) | [Shared spatial facts and independent offline MVP fixtures](../topics/spatial-data.md) | S1/S3 |
| [#79](https://github.com/atlas-field-systems/atlas-core/issues/79) | [Offline trust/bootstrap and connection fixtures](../topics/dataset-lifecycle.md#offline-tls-and-first-time-setup) | S1/S3/S7 |
| [#80](https://github.com/atlas-field-systems/atlas-core/issues/80) | [Supported fields, desired/active timing and recovery](../topics/dataset-lifecycle.md#core-configuration) | S5/S7 |
| [#81](https://github.com/atlas-field-systems/atlas-core/issues/81) | [Mutation matrix](../topics/tracks-and-geofeatures.md#mutation-authority-matrix), [atomic class validation](../topics/asset-reporting.md#mutation-classes-and-atomic-validation) and [Descriptive edit permissions](../topics/identity-and-access.md#assets) | S1/S6 |
| [#82](https://github.com/atlas-field-systems/atlas-core/issues/82) | [Initial temporal facts and independent registration fixtures](../topics/identity-and-access.md#initial-data-and-temporal-facts) | S1 |
| [#84](https://github.com/atlas-field-systems/atlas-core/issues/84) | This endpoint/SDK/local-action inventory and scenario-to-slice matrix | All slices |

Task grouping, publisher transfers, per-Asset hybrid synchronization, resumable transfers and production Plugin/device algorithms retain their documented deferred/proposed status. Radio transport, physical Asset recovery and independently maintained extension validation are external dependencies, not hidden MVP promises. Workload targets, power-loss guarantees and field readiness still require the specific future evidence described by their owners.
