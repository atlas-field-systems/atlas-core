# Structural schema integration

`schemas.bend` returns standard JSON Schema 2020-12 data as `Common.Json`.
It performs no validation. Unknown names return `JMissing`.
Every registered definition has a matching `title`.
The registry has 211 definitions, including 125 direct public schema exports.
`inputSections` and `readSections` expand into ten names each.
The 66 exchange request and response pairs belong to the exchange owner.

## Interface

- `schema(name: String) -> C.Json` returns one definition.
- `names() -> List<&2, String>` includes supporting definitions.
- `public_names() -> List<&2, String>` lists the direct schema exports in `src/index.ts`.
- `section_names() -> List<&2, String>` lists all ten wire sections.
- `shapes.closed(required, optional)` takes lists of `C.Member` property definitions.
- `shapes.ref`, `tag`, `literal`, `enum`, `any_of`, `one_of`, and `nullable` construct standard schema objects.
- `shapes.array`, `tuple`, `dictionary`, `integer`, `number`, `text`, `pattern`, and `nonblank` construct standard constraints.
- `shapes.named` attaches a title and registry key. `add`, `members`, `keys`, `strings`, and `nonempty` support construction.

There is no schema AST, schema compiler, typed domain materializer, or semantic predicate here.
Objects are closed except the UUID-keyed reserve-time dictionary.
References use `#/components/schemas/NAME`.
Numeric metadata uses `JNum.raw`, including the exact 309-digit binary64 maximum.
The 128-byte limit on submitted numeric tokens does not apply to this schema metadata.

## Semantic predicates to attach

Run referenced definitions' predicates recursively and the enclosing title's predicate after structural acceptance.
The names below describe required checks, not new schema keywords or exported Bend functions.
Titles absent from this table need only their structural constraints and recursively referenced checks.

| Titles | Required named checks |
| --- | --- |
| Every string location | `unicode_scalar_text` rejects lone surrogates and counts Unicode scalars without normalization. The JSON boundary also rejects duplicate decoded members. |
| `Float`, `Integer`, `PageSize`, `Latitude`, `Longitude`, `Nonnegative`, `Positive`, `Heading`, `Roll`, `FieldOfView`, `ZoomRatio`, `Percent`; numeric fields in `MessageLimits`, `NegotiatedLimits`, `ReadSnapshot`, `ReadChanges`, `SubscribeChanges` | `exact_numeric_domain` checks original decimal bounds and integrality before conversion, finite binary64 limits, ties-to-even conversion, nonzero underflow, and bounds after conversion. `numeric_token` enforces JSON spelling, 128 bytes, and exponent within -10000 through 10000. Inline numeric locations inherit the same keyword-driven checks. |
| `Timestamp` | `gregorian_timestamp` validates actual dates in years 0001 through 9999, clock fields, and no leap seconds. Comparisons use exact nanoseconds and preserve spelling. |
| `Attitude` | `attitude_singularity` requires null heading and roll at pitch +90 or -90 after conversion. |
| `Gimbal` | `gimbal_singularity` requires null bearing at elevation +90 or -90 after conversion. |
| `Power` | `reserve_ids_unique` rejects repeated reserve IDs, including differing payloads. |
| `LineString`, `Polygon` | `supported_geometry_path` rejects exact longitude steps greater than 180 and the presence of both longitude endpoints. `Polygon` also rejects edges along a pole between different longitudes. |
| `Polygon` | `polygon_topology` requires closure, nonzero exact area, nonzero edges, no adjacent backtracking or overlap, no crossings, and no nonadjacent touching. Preserve winding and precision. The consuming boundary reserves aggregate work before topology allocation and distinguishes geometry failure codes. |
| Every `InputSection.<section>` and `ReadSection.<section>` | `source_times_applicable` forbids overrides for absent optional quantities. Geometry's whole-shape key is permitted. |
| `InputSection.power`, `ReadSection.power` | `reserve_times_applicable` requires dictionary IDs to exist in the payload and forbids battery keys for fuel reserves. |
| `InputSection.telemetry`, `ReadSection.telemetry` | `telemetry_constituent_keys` requires airspeed presence to agree between value and constituents. Null quantities still require constituents. |
| Every `ReadSection.<section>` | `source_free_initial_value` permits null evidence only for exact initial Status, Capacity, and SubjectType values, with state_until_changed classification, null observed_at, and absent source_times. Telemetry already structurally requires non-null evidence. |
| `AssetReport` | `asset_report_content` requires a section or current contact proof and requires non-null generated_at with proof. `asset_constituent_origins` requires Asset origins while permitting retained older generations. |
| `ObservationReport` | `publisher_constituent_origins` requires each constituent's publisher origin to match the envelope publisher. |
| `Asset` | `asset_evidence_scope` checks Dataset, Entity, and Asset origin for every section and Asset origins for telemetry constituents. `report_sequences_match` checks equal sequences for reused scoped report IDs. Retained older process generations remain valid. |
| `Observation` | `observation_identity_scope` rejects overlap among Observation, Track, and optional source Asset IDs. `observation_evidence_scope` checks Dataset, Entity, and publisher for sections and constituents. Also run `report_sequences_match`. |
| `Track` | `track_identity_scope` rejects Track/source Observation/source Asset overlap. `track_evidence_scope` matches the original Observation and publisher against sources, including constituent origins. Also run `report_sequences_match`. |
| `ResultDeclarations` | `result_object_ids_unique` rejects repeated Object IDs even when flags differ. |
| `DeclarationBatch` | `declaration_flags_consistent` permits identical repeated declarations and rejects differing required flags for one Object ID. |
| `Task` | `resume_admission_interval` requires 0 < expires_at minus accepted_at <= 60 seconds, without comparing with now. Terminal cancellation nullability is already structural. |
| `TaskQueue` | `queue_confirmation_revision` requires confirmed revision <= current revision. |
| `TaskControl` | `control_request_revision` equates revision zero with null requested. `control_confirmation_revision` forbids zero and future confirmed revisions. `current_control_confirmation` matches current-revision task_id and pause/running effect. Older confirmations may remain. |
| `ExecutionPayload` | `resume_effect_interval` requires captured_at <= applied_at < instructions_valid_until on completed Resume effects. Task-command association and actual legal transitions require consuming context. |
| `Activity` | `deleted_operator_attribution` forbids operator_deleted true when operator_id is null. |
| `HistoryReading` | `history_time_status` equates unknown status with null observed_at. |
| `HistoryFirst` | `history_bounds_ordered` requires source_time_from < source_time_before when both exist. |
| `HistoryPage` | `history_identity_unique` checks full constituent scope. `history_readings_ordered` puts known times first, compares exact nanoseconds, then complete identity tuples, and orders unknown/uncertain readings by identity. |
| `AssignedTasks` | `assigned_capture_interval` requires exactly ten seconds of instruction validity. `assigned_tasks_context` requires matching asset_id, nonterminal Tasks, and strictly increasing Task IDs. |
| `BeginAssetContact` | `replacement_generation_changed` requires distinct generations in replace mode. |
| `ContactChallenge` | `challenge_interval` requires 1 ns <= expires_at minus issued_at <= 10 seconds. |
| `ReplaceAssetProcess` | `first_process_report` checks changed generation, matching Asset and report origin, current mode, and matching contact challenge proof. |
| `Put` | `put_identity_version` matches wrapper ID and version to its concrete resource image. |
| `Changes` | `change_resources_unique` rejects repeated resource kind and ID even when versions or images differ. |
| `SnapshotPage` | `snapshot_resources_unique` and `snapshot_resources_ordered` check kind and ID. `snapshot_negotiated_count` checks item count against limits.max_changes. Byte/value budgets apply to complete envelopes at the consuming boundary. |
| `ChangeBatchData`, `LiveChangeBatchData` | `batch_cursor_advances` requires previous_cursor != commit_cursor. |
| `ReplayPage` | `replay_cursor_chain` checks each previous cursor, rejects revisiting an earlier cursor after advancing, and permits unchanged progress cursors. `replay_through_cursor` matches the last message. `replay_complete_boundary` requires through_cursor == replay_boundary when next_page_token is null. |
| `ServerFrame` | `frame_dataset_scope` checks every nested Put image against frame.dataset_id in live batches, snapshots, and replay pages. |

`Counter`, `Sequence`, and `ObjectLength` already encode exact string ranges with standard patterns.
`Capabilities` uniqueness is structural because each command has one permitted singleton scheduling array.
`Associations` uniqueness is structural because each entry contains only kind and ID.
The structural section evidence definitions already fix the exact section name.
Input and read sections preserve omission versus null and never supply defaults.

Installed Protocol version, expected Dataset/request/subscription context, negotiated external budgets, HTTP relationships, authority, resource existence, and durable transitions remain consuming-boundary responsibilities.
This unit does not implement those checks.

## Verification

Run `BEND=/path/to/bend sh test/schema-data.sh` from the experiment directory.
The script requires the integrated `common.bend` and Bend 2.0.39.
It installs only stock Ajv2020 8.20.0 in ignored artifacts when needed.
It checks Bend, emits and runs JavaScript, compiles every schema, checks references and inventory, and exercises independent structural examples.
Ajv keeps strict types, tuples, numbers, and required rules enabled.
`strictSchema: false` permits the OpenAPI `components` container; a separate closed keyword walk checks every actual schema.
Original production schema definitions are never imported.
The fixture corpora, Bend interpreter, full OpenAPI bundle, native validation command, and consuming workflows belong to parent integration.
