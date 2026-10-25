import Base
import ./common.bend as C
import ./shapes.bend as S

def entity_fields(kind: String) -> List<&2, C.Member>:
  [C.Member{"dataset_id", S.ref("Uuid")},
    C.Member{"id", S.ref("Uuid")},
    C.Member{"version", S.ref("Counter")},
    C.Member{"edit_revision", S.ref("Counter")},
    C.Member{"entity_type", S.tag(kind)}]

def descriptive_fields(description: String) -> List<&2, C.Member>:
  [C.Member{"alias", S.ref("Alias")}, C.Member{"description", S.ref(description)}]

def reported_fields() -> List<&2, C.Member>:
  [C.Member{"telemetry", S.ref("ReadSection.telemetry")}, C.Member{"attitude", S.ref("ReadSection.attitude")}]

def subject_fields() -> List<&2, C.Member>:
  S.members(descriptive_fields("Description"), S.members(reported_fields(), [C.Member{"geometry", S.ref("ReadSection.geometry")}]))

def entity_definitions() -> List<&2, C.Member>:
  [
    S.named("PublisherSubject", S.closed([C.Member{"id", S.nonblank(128)},
      C.Member{"lifetime_id", S.ref("Uuid")}], [])),
    S.named("Communications", S.closed([C.Member{"health", S.ref("Health")},
      C.Member{"capacity", S.ref("ReadSection.communications")}], [])),
    S.named("TrackSource", S.closed([C.Member{"observation_id", S.ref("Uuid")},
      C.Member{"publisher_id", S.ref("Uuid")}], [C.Member{"source_asset_id", S.ref("Uuid")}])),
    S.named("Asset", S.closed(S.members(entity_fields("asset"), [
      C.Member{"type", S.ref("AssetType")},
        C.Member{"capabilities", S.ref("Capabilities")},
        C.Member{"process_generation", S.ref("Uuid")},
        C.Member{"status", S.ref("ReadSection.status")},
        C.Member{"communications", S.ref("Communications")},
        C.Member{"heartbeat", S.ref("Heartbeat")},
        C.Member{"task_queue", S.ref("TaskQueue")},
        C.Member{"task_control", S.ref("TaskControl")}]),
      S.members(descriptive_fields("AssetDescription"), S.members(reported_fields(), [C.Member{"power", S.ref("ReadSection.power")},
        C.Member{"camera", S.ref("ReadSection.camera")},
        C.Member{"camera_optics", S.ref("ReadSection.camera_optics")},
        C.Member{"gimbal", S.ref("ReadSection.gimbal")}])))),
    S.named("Observation", S.closed(S.members(entity_fields("observation"), [C.Member{"publisher_id", S.ref("Uuid")},
      C.Member{"track_id", S.ref("Uuid")},
      C.Member{"type", S.ref("ReadSection.type")}]),
      S.members(subject_fields(), [C.Member{"source_asset_id", S.ref("Uuid")},
        C.Member{"publisher_subject", S.ref("PublisherSubject") }]))),
    S.named("Track", S.closed(S.members(entity_fields("track"), [C.Member{"sources", S.array(S.ref("TrackSource"), 1, 1, True{})},
      C.Member{"type", S.ref("ReadSection.type")}]), subject_fields())),
    S.named("Geofeature", S.closed(S.members(entity_fields("geofeature"), [C.Member{"type", S.ref("GeofeatureType")},
      C.Member{"geometry", S.ref("Geometry")},
      C.Member{"geometry_revision", S.ref("Counter")}]), descriptive_fields("Description")))]

def storage_fields() -> List<&2, C.Member>:
  [C.Member{"byte_length", S.ref("ObjectLength")},
    C.Member{"sha256", S.ref("Sha256")},
    C.Member{"content_type", S.ref("ContentType")}]

def object_definitions() -> List<&2, C.Member>:
  [
    S.named("ContentType", S.pattern(255, "^[!#$%&'*+.^_`|~0-9A-Za-z-]+/[!#$%&'*+.^_`|~0-9A-Za-z-]+$(?![\\s\\S])")),
    S.named("Sha256", S.add(S.pattern(64, "^[0-9a-f]{64}$(?![\\s\\S])"), [C.Member{"minLength", C.JNum{"64"}}])),
    S.named("ObjectLength", S.pattern(10, "^(?:0|[1-9][0-9]{0,8}|1[0-9]{9}|2000000000)$(?![\\s\\S])")),
    S.named("Association", S.closed([C.Member{"kind", S.enum(["asset", "observation", "track", "geofeature", "task"])},
      C.Member{"id", S.ref("Uuid")}], [])),
    S.named("Associations", S.array(S.ref("Association"), 0, 128, True{})),
    S.named("ObjectMetadata", S.closed([C.Member{"associations", S.ref("Associations")}], [C.Member{"name", S.nonblank(128)},
      C.Member{"description", S.text(4096)}])),
    S.named("UploadDescriptor", S.closed(S.members(storage_fields(), [C.Member{"request_id", S.ref("NewId")},
      C.Member{"object_id", S.ref("NewId")},
      C.Member{"metadata", S.ref("ObjectMetadata")}]), [])),
    S.named("ObjectImage", S.closed(S.members(storage_fields(), [C.Member{"dataset_id", S.ref("Uuid")},
      C.Member{"object_id", S.ref("Uuid")},
      C.Member{"version", S.ref("Counter")},
      C.Member{"edit_revision", S.ref("Counter")},
      C.Member{"created_at", S.ref("Timestamp")},
      C.Member{"metadata", S.ref("ObjectMetadata")}]), [])),
    S.named("ObjectEdits", S.nonempty(S.closed([], [C.Member{"name", S.nullable(S.nonblank(128))},
      C.Member{"description", S.nullable(S.text(4096))},
      C.Member{"associations", S.ref("Associations")}]))),
    S.named("ContentDescriptor", S.closed(S.members(storage_fields(), [C.Member{"object_id", S.ref("Uuid")},
      C.Member{"disposition", S.enum(["inline", "attachment"])}]), []))]

def negotiation_fields() -> List<&2, C.Member>:
  [C.Member{"max_message_bytes", S.integer(0, 4194304)},
    C.Member{"max_json_values", S.integer(0, 262144)},
    C.Member{"max_changes", S.integer(0, 1000)}]

def administration_definitions() -> List<&2, C.Member>:
  [
    S.named("Operator", S.closed([C.Member{"operator_id", S.ref("Uuid")},
      C.Member{"name", S.nonblank(256)},
      C.Member{"edit_revision", S.ref("Counter")}], [C.Member{"description", S.text(4096)}])),
    S.named("ApiKey", S.closed([C.Member{"api_key_id", S.ref("Uuid")},
      C.Member{"operator_id", S.nullable(S.ref("Uuid"))},
      C.Member{"created_at", S.ref("Timestamp")},
      C.Member{"revoked_at", S.ref("Time")}], [])),
    S.named("ResourceUsage", S.closed([C.Member{"kind", S.nonblank(128)},
      C.Member{"used", S.ref("Counter")},
      C.Member{"capacity", S.ref("Counter")}], [])),
    S.named("Activity", S.closed([C.Member{"activity_id", S.ref("Uuid")},
      C.Member{"at", S.ref("Timestamp")},
      C.Member{"category", S.nonblank(128)},
      C.Member{"message", S.text(4096)},
      C.Member{"api_key_id", S.nullable(S.ref("Uuid"))},
      C.Member{"operator_id", S.nullable(S.ref("Uuid"))},
      C.Member{"operator_deleted", S.typed("boolean")}], [])),
    S.named("MessageLimits", S.closed(S.members(negotiation_fields(), [C.Member{"max_request_bytes", S.integer(0, 1048576)},
      C.Member{"max_request_json_values", S.integer(0, 65536)},
      C.Member{"max_control_bytes", S.integer(0, 16384)},
      C.Member{"max_control_json_values", S.integer(0, 4096)},
      C.Member{"max_json_depth", S.integer(0, 32)},
      C.Member{"max_object_bytes", S.integer(0, 2000000000)}]), [])),
    S.named("NegotiatedLimits", S.closed(negotiation_fields(), [])),
    S.named("TemporaryLimits", S.closed([
      C.Member{"max_snapshot_captures", S.ref("Integer")},
        C.Member{"max_snapshot_captures_per_key", S.ref("Integer")},
        C.Member{"max_snapshot_bytes", S.ref("Counter")},
        C.Member{"max_total_snapshot_bytes", S.ref("Counter")},
        C.Member{"max_history_views", S.ref("Integer")},
        C.Member{"max_history_views_per_key", S.ref("Integer")},
        C.Member{"max_history_references_per_view", S.ref("Integer")},
        C.Member{"max_total_history_references", S.ref("Integer")},
        C.Member{"max_history_bytes", S.ref("Counter")},
        C.Member{"max_contact_challenges", S.ref("Integer")},
        C.Member{"max_allocation_receipts", S.ref("Integer")}], [])),
    S.named("HealthData", S.closed([C.Member{"healthy", S.typed("boolean")},
      C.Member{"protocol_version", S.ref("Opaque")},
      C.Member{"core_run_id", S.ref("Uuid")},
      C.Member{"limits", S.ref("MessageLimits")},
      C.Member{"temporary_limits", S.ref("TemporaryLimits")},
      C.Member{"allocation_context", S.ref("Opaque")},
      C.Member{"allocation_expires_at", S.ref("Timestamp")}], [])),
    S.named("Readiness", S.closed([C.Member{"ready", S.typed("boolean")}], []))]

def history_fields(origin: String) -> List<&2, C.Member>:
  [C.Member{"source_entity_id", S.ref("Uuid")},
    C.Member{"quantity", S.tag("position")},
    C.Member{"value", S.nullable(S.ref("Position"))},
    C.Member{"observed_at", S.ref("Time")},
    C.Member{"time_status", S.ref("TimeStatus")},
    C.Member{"source_evidence", S.closed([C.Member{"origin", S.ref(origin)},
    C.Member{"reading_id", S.ref("NewId")}], [])}]

def history_definitions() -> List<&2, C.Member>:
  [
    S.named("TimeStatus", S.enum(["known", "unknown", "uncertain"])),
    S.named("HistoryReading", S.one_of([
      S.closed(S.members(history_fields("AssetOrigin"), [C.Member{"source_entity_kind", S.tag("asset")},
        C.Member{"track_ids", S.array(S.ref("Uuid"), 0, 0, False{})}]), []),
      S.closed(S.members(history_fields("PublisherOrigin"), [C.Member{"source_entity_kind", S.tag("observation")},
        C.Member{"track_ids", S.array(S.ref("Uuid"), 0, 1000, True{})}]), [])])),
    S.named("HistoryFirst", S.closed([C.Member{"entity_id", S.ref("Uuid")},
      C.Member{"query_id", S.ref("NewId")},
      C.Member{"allocation_context", S.ref("Opaque")}], [C.Member{"time_groups", S.array(S.ref("TimeStatus"), 0, 3, True{})},
      C.Member{"source_time_from", S.ref("Timestamp")},
      C.Member{"source_time_before", S.ref("Timestamp")},
      C.Member{"page_size", S.ref("PageSize")}])),
    S.named("Continuation", S.closed([C.Member{"page_token", S.ref("Opaque")}], [])),
    S.named("HistoryQuery", S.one_of([S.ref("HistoryFirst"), S.ref("Continuation")])),
    S.named("HistoryPage", S.closed([C.Member{"query_id", S.ref("Uuid")},
      C.Member{"view_id", S.ref("Uuid")},
      C.Member{"source", S.tag("core")},
      C.Member{"baseline_cursor", S.ref("Opaque")},
      C.Member{"expires_at", S.ref("Timestamp")},
      C.Member{"release_token", S.ref("Opaque")},
      C.Member{"readings", S.array(S.ref("HistoryReading"), 0, 1000, False{})},
      C.Member{"next_page_token", S.nullable(S.ref("Opaque"))}], [])),
    S.named("Release", S.closed([C.Member{"release_token", S.ref("Opaque")}], [])),
    S.named("Released", S.closed([C.Member{"released", S.literal(C.JBool{True{}})}], []))]

def contact_definitions() -> List<&2, C.Member>:
  [
    S.named("AssignedTasks", S.closed([C.Member{"asset_id", S.ref("Uuid")},
      C.Member{"process_generation", S.ref("Uuid")},
      C.Member{"read_id", S.ref("Uuid")},
      C.Member{"core_run_id", S.ref("Uuid")},
      C.Member{"captured_at", S.ref("Timestamp")},
      C.Member{"instructions_valid_until", S.ref("Timestamp")},
      C.Member{"task_queue", S.ref("TaskQueue")},
      C.Member{"task_control", S.ref("TaskControl")},
      C.Member{"tasks", S.array(S.ref("Task"), 0, 1000, False{})},
      C.Member{"next_page_token", S.nullable(S.ref("Opaque"))}], [])),
    S.named("BeginAssetContact", S.one_of([
      S.closed([C.Member{"request_id", S.ref("NewId")},
        C.Member{"allocation_context", S.ref("Opaque")},
        C.Member{"asset_id", S.ref("Uuid")},
        C.Member{"process_generation", S.ref("Uuid")},
        C.Member{"mode", S.tag("current")}], []),
      S.closed([C.Member{"request_id", S.ref("NewId")},
        C.Member{"allocation_context", S.ref("Opaque")},
        C.Member{"asset_id", S.ref("Uuid")},
        C.Member{"process_generation", S.ref("NewId")},
        C.Member{"mode", S.tag("replace")},
        C.Member{"expected_process_generation", S.ref("Uuid")}], [])])),
    S.named("ContactChallenge", S.one_of([
      S.closed([C.Member{"challenge_id", S.ref("Uuid")},
        C.Member{"asset_id", S.ref("Uuid")},
        C.Member{"process_generation", S.ref("Uuid")},
        C.Member{"core_run_id", S.ref("Uuid")},
        C.Member{"issued_at", S.ref("Timestamp")},
        C.Member{"expires_at", S.ref("Timestamp")},
        C.Member{"mode", S.tag("current")}], []),
      S.closed([C.Member{"challenge_id", S.ref("Uuid")},
        C.Member{"asset_id", S.ref("Uuid")},
        C.Member{"process_generation", S.ref("Uuid")},
        C.Member{"core_run_id", S.ref("Uuid")},
        C.Member{"issued_at", S.ref("Timestamp")},
        C.Member{"expires_at", S.ref("Timestamp")},
        C.Member{"mode", S.tag("replace")},
        C.Member{"expected_process_generation", S.ref("Uuid")}], [])])),
    S.named("ReplaceAssetProcess", S.closed([C.Member{"request_id", S.ref("NewId")},
      C.Member{"asset_id", S.ref("Uuid")},
      C.Member{"expected_process_generation", S.ref("Uuid")},
      C.Member{"process_generation", S.ref("NewId")},
      C.Member{"challenge_id", S.ref("Uuid")},
      C.Member{"first_report", S.ref("AssetReport")}], []))]

def definitions() -> List<&2, C.Member>:
  S.members(entity_definitions(), S.members(object_definitions(), S.members(administration_definitions(), S.members(history_definitions(), contact_definitions()))))
