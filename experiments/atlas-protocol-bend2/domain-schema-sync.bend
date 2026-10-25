import Base
import ./common.bend as C
import ./shapes.bend as S
import ./domain-schema-resources.bend as Resources

def error_fields(codes: List<&2, String>) -> List<&2, C.Member>:
  [C.Member{"code", S.enum(codes)}, C.Member{"message", S.text(1024)}, C.Member{"request_id", S.ref("NewId")}]

def error_empty(codes: List<&2, String>) -> C.Json:
  S.closed(error_fields(codes), [C.Member{"details", S.closed([], [])}])

def statuses() -> List<&2, String>:
  ["400", "401", "404", "409", "410", "413", "422", "429", "500", "507"]

def error_references(names: List<&2, String>) -> List<&2, C.Json>:
  match names:
    case Nil{}:
      Nil{}
    case Con{h, t}:
      S.ref("Error." ++ h) <> error_references(t)

def http_errors(names: List<&2, String>) -> List<&2, C.Json>:
  match names:
    case Nil{}:
      Nil{}
    case Con{+h, t}:
      S.closed([C.Member{"kind", S.tag("error")},
        C.Member{"status", S.literal(C.JNum{h})},
        C.Member{"body", S.closed([C.Member{"dataset_id", S.ref("Uuid")},
        C.Member{"error", S.ref("Error." ++ h)}], [])}], []) <> http_errors(t)

def error_definitions() -> List<&2, C.Member>:
  [
    S.named("Error.400", error_empty(["invalid_request", "dataset_required"])),
    S.named("Error.401", error_empty(["unauthorized"])),
    S.named("Error.404", error_empty(["asset_not_found", "entity_not_found", "operator_not_found"])),
    S.named("Error.409", S.one_of([
      error_empty(["counter_exhausted", "allocation_conflict", "generation_mismatch", "challenge_context_mismatch", "challenge_consumed", "queue_changed", "cancellation_pending", "evidence_conflict", "cancellation_changed", "terminal_state_conflict", "control_not_confirmed", "report_identity_conflict", "section_sequence_conflict", "constituent_conflict", "identity_conflict", "edit_conflict", "object_held"]),
      S.closed(error_fields(["protocol_mismatch"]), [C.Member{"details", S.closed([C.Member{"protocol_version", S.ref("Opaque")}], [])}]),
      S.closed(error_fields(["dataset_mismatch"]), [C.Member{"details", S.closed([C.Member{"dataset_id", S.ref("Uuid")}], [])}])])),
    S.named("Error.410", S.one_of([
      error_empty(["allocation_expired", "challenge_expired", "operator_deleted"]),
      S.closed(S.members(error_fields(["cursor_expired"]), [C.Member{"details", S.closed([C.Member{"earliest_recoverable_cursor", S.ref("Opaque")}], [])}]), [])])),
    S.named("Error.413", error_empty(["payload_too_large"])),
    S.named("Error.422", error_empty(["invalid_geometry", "unsupported_geometry", "geometry_limit_exceeded", "unsupported_filter", "unsupported_command"])),
    S.named("Error.429", error_empty(["resource_limit", "contact_busy"])),
    S.named("Error.500", error_empty(["integrity_fault"])),
    S.named("Error.507", error_empty(["storage_limit"])),
    S.named("ErrorObject", S.one_of(error_references(statuses()))),
    S.named("HttpError", S.one_of(http_errors(statuses())))]

def put(kind: String, image: String) -> C.Json:
  S.closed([C.Member{"kind", S.tag("put")},
    C.Member{"resource_kind", S.tag(kind)},
    C.Member{"resource_id", S.ref("Uuid")},
    C.Member{"version", S.ref("Counter")},
    C.Member{"image", S.ref(image)}], [])

def batch_fields() -> List<&2, C.Member>:
  [C.Member{"previous_cursor", S.ref("Opaque")},
    C.Member{"commit_cursor", S.ref("Opaque")},
    C.Member{"changes", S.ref("Changes")}]

def progress_fields() -> List<&2, C.Member>:
  [C.Member{"previous_cursor", S.ref("Opaque")}, C.Member{"through_cursor", S.ref("Opaque")}]

def synchronization_definitions() -> List<&2, C.Member>:
  [
    S.named("ResourceKind", S.enum(["asset", "track", "geofeature", "task", "object"])),
    S.named("Put", S.one_of([put("asset", "Asset"), put("track", "Track"), put("geofeature", "Geofeature"), put("task", "Task"), put("object", "ObjectImage")])),
    S.named("Delete", S.closed([C.Member{"kind", S.tag("delete")},
      C.Member{"resource_kind", S.enum(["asset", "geofeature", "object"])},
      C.Member{"resource_id", S.ref("Uuid")},
      C.Member{"version", S.ref("Counter")}], [])),
    S.named("Change", S.one_of([S.ref("Put"), S.ref("Delete")])),
    S.named("Changes", S.array(S.ref("Change"), 1, 1000, True{})),
    S.named("ReadSnapshot", S.one_of([
      S.closed(S.members(Resources.negotiation_fields(), [C.Member{"allocation_context", S.ref("Opaque")},
        C.Member{"load_id", S.ref("NewId")},
        C.Member{"page_size", S.ref("PageSize")}]), []), S.ref("Continuation")])),
    S.named("SnapshotPage", S.closed([C.Member{"load_id", S.ref("Uuid")},
      C.Member{"capture_id", S.ref("Uuid")},
      C.Member{"baseline_cursor", S.ref("Opaque")},
      C.Member{"expires_at", S.ref("Timestamp")},
      C.Member{"limits", S.ref("NegotiatedLimits")},
      C.Member{"items", S.array(S.ref("Put"), 0, 1000, True{})},
      C.Member{"next_page_token", S.nullable(S.ref("Opaque"))},
      C.Member{"release_token", S.ref("Opaque")}], [])),
    S.named("ChangeBatchData", S.closed(batch_fields(), [])),
    S.named("ProgressData", S.closed(progress_fields(), [])),
    S.named("ReplayBatch", S.closed([C.Member{"type", S.tag("change_batch")},
      C.Member{"data", S.ref("ChangeBatchData")}], [])),
    S.named("ReplayProgress", S.closed([C.Member{"type", S.tag("progress")},
      C.Member{"data", S.ref("ProgressData")}], [])),
    S.named("ReplayMessage", S.one_of([S.ref("ReplayBatch"), S.ref("ReplayProgress")])),
    S.named("ReadChanges", S.one_of([S.closed(S.members(Resources.negotiation_fields(), [C.Member{"from_cursor", S.ref("Opaque")}]), []), S.ref("Continuation")])),
    S.named("ReplayPage", S.closed([C.Member{"replay_boundary", S.ref("Opaque")},
      C.Member{"messages", S.array(S.ref("ReplayMessage"), 0, 1000, False{})},
      C.Member{"through_cursor", S.ref("Opaque")},
      C.Member{"next_page_token", S.nullable(S.ref("Opaque"))}], [])),
    S.named("SubscribeChanges", S.closed(S.members(Resources.negotiation_fields(), [C.Member{"subscription_id", S.ref("NewId")},
      C.Member{"from_cursor", S.ref("Opaque")}]), [])),
    S.named("UnsubscribeChanges", S.closed([C.Member{"subscription_id", S.ref("Uuid")}], [])),
    S.named("Subscribed", S.closed([C.Member{"subscription_id", S.ref("Uuid")},
      C.Member{"handoff_cursor", S.ref("Opaque")},
      C.Member{"limits", S.ref("NegotiatedLimits")}], [])),
    S.named("Unsubscribed", S.closed([C.Member{"subscription_id", S.ref("Uuid")}], [])),
    S.named("LiveChangeBatchData", S.closed(S.members(batch_fields(), [C.Member{"subscription_id", S.ref("Uuid")}]), [])),
    S.named("LiveProgressData", S.closed(S.members(progress_fields(), [C.Member{"subscription_id", S.ref("Uuid")}]), [])),
    S.named("AuthenticatedData", S.closed([C.Member{"core_run_id", S.ref("Uuid")},
      C.Member{"limits", S.ref("NegotiatedLimits")}], [])),
    S.named("HandoffCompleteData", S.closed([C.Member{"subscription_id", S.ref("Uuid")},
      C.Member{"handoff_cursor", S.ref("Opaque")}], [])),
    S.named("GapData", S.closed([C.Member{"subscription_id", S.ref("Uuid")},
      C.Member{"reason", S.enum(["cursor_expired", "resource_limit", "limits_changed"])},
      C.Member{"earliest_recoverable_cursor", S.ref("Opaque")}], []))]

def frame_context(frame_type: String) -> List<&2, C.Member>:
  [C.Member{"type", S.tag(frame_type)},
    C.Member{"dataset_id", S.ref("Uuid")},
    C.Member{"protocol_version", S.ref("Opaque")}]

def control(frame_type: String, data: String) -> C.Json:
  S.closed(S.members(frame_context(frame_type), [C.Member{"request_id", S.ref("NewId")},
    C.Member{"data", S.ref(data)}]), [])

def event(frame_type: String, data: String) -> C.Json:
  S.closed(S.members(frame_context(frame_type), [C.Member{"data", S.ref(data)}]), [])

def frame_definitions() -> List<&2, C.Member>:
  [
    S.named("Authenticate", S.closed(S.members(frame_context("authenticate"), [C.Member{"request_id", S.ref("NewId")},
      C.Member{"api_key", S.ref("Secret")}]), [])),
    S.named("ClientFrame.read_snapshot", control("read_snapshot", "ReadSnapshot")),
    S.named("ClientFrame.read_changes", control("read_changes", "ReadChanges")),
    S.named("ClientFrame.release_snapshot", control("release_snapshot", "Release")),
    S.named("ClientFrame.subscribe_changes", control("subscribe_changes", "SubscribeChanges")),
    S.named("ClientFrame.unsubscribe_changes", control("unsubscribe_changes", "UnsubscribeChanges")),
    S.named("ClientFrame", S.one_of([S.ref("Authenticate"), S.ref("ClientFrame.read_snapshot"), S.ref("ClientFrame.read_changes"), S.ref("ClientFrame.release_snapshot"), S.ref("ClientFrame.subscribe_changes"), S.ref("ClientFrame.unsubscribe_changes")])),
    S.named("ServerFrame.authenticated", control("authenticated", "AuthenticatedData")),
    S.named("ServerFrame.read_snapshot_result", control("read_snapshot_result", "SnapshotPage")),
    S.named("ServerFrame.read_changes_result", control("read_changes_result", "ReplayPage")),
    S.named("ServerFrame.snapshot_released", control("snapshot_released", "Released")),
    S.named("ServerFrame.subscribed", control("subscribed", "Subscribed")),
    S.named("ServerFrame.unsubscribed", control("unsubscribed", "Unsubscribed")),
    S.named("ServerFrame.change_batch", event("change_batch", "LiveChangeBatchData")),
    S.named("ServerFrame.progress", event("progress", "LiveProgressData")),
    S.named("ServerFrame.handoff_complete", event("handoff_complete", "HandoffCompleteData")),
    S.named("ServerFrame.gap", event("gap", "GapData")),
    S.named("ServerFrame.error", S.closed(S.members(frame_context("error"), [C.Member{"error", S.ref("ErrorObject")}]), [C.Member{"request_id", S.ref("NewId")}])),
    S.named("ServerFrame", S.one_of([S.ref("ServerFrame.authenticated"), S.ref("ServerFrame.read_snapshot_result"), S.ref("ServerFrame.read_changes_result"), S.ref("ServerFrame.snapshot_released"), S.ref("ServerFrame.subscribed"), S.ref("ServerFrame.unsubscribed"), S.ref("ServerFrame.change_batch"), S.ref("ServerFrame.progress"), S.ref("ServerFrame.handoff_complete"), S.ref("ServerFrame.gap"), S.ref("ServerFrame.error")]))]

def definitions() -> List<&2, C.Member>:
  S.members(error_definitions(), S.members(synchronization_definitions(), frame_definitions()))
