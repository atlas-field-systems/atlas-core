import Base
import ./common.bend as C
import ./shapes.bend as S
import ./domain-schema-components.bend as Components

def task_fields() -> List<&2, C.Member>:
  [C.Member{"dataset_id", S.ref("Uuid")},
    C.Member{"task_id", S.ref("Uuid")},
    C.Member{"request_id", S.ref("NewId")},
    C.Member{"asset_id", S.ref("Uuid")},
    C.Member{"version", S.ref("Counter")},
    C.Member{"accepted_at", S.ref("Timestamp")},
    C.Member{"submission_sequence", S.ref("Sequence")},
    C.Member{"result_declarations", S.ref("ResultDeclarations")}]

def task_variants(+command: List<&2, C.Member>) -> List<&2, C.Json>:
  [S.closed(S.members(command, S.members(task_fields(), [C.Member{"execution_state", S.ref("NonterminalState")},
    C.Member{"cancellation_request_id", S.nullable(S.ref("NewId"))}])), []),
   S.closed(S.members(command, S.members(task_fields(), [C.Member{"execution_state", S.enum(["completed", "failed", "cancelled"])},
     C.Member{"cancellation_request_id", S.typed("null")}])), [])]

def evidence(payload: C.Json) -> C.Json:
  S.closed([C.Member{"dataset_id", S.ref("Uuid")},
    C.Member{"asset_id", S.ref("Uuid")},
    C.Member{"origin", S.ref("AssetOrigin")},
    C.Member{"report_id", S.ref("NewId")},
    C.Member{"sequence", S.ref("Sequence")},
    C.Member{"generated_at", S.ref("Time")},
    C.Member{"payload", payload}], [])

def execution_fields(event: String, state: C.Json, extra: List<&2, C.Member>) -> List<&2, C.Member>:
  S.members([C.Member{"task_id", S.ref("Uuid")}, C.Member{"event", S.tag(event)}, C.Member{"state", state}], extra)

def execution_optional() -> List<&2, C.Member>:
  [C.Member{"message", S.text(1024)}, C.Member{"geometry_revision", S.ref("Counter")}]

def control_fields(queue_state: String) -> List<&2, C.Member>:
  [C.Member{"control_revision", S.ref("Counter")},
    C.Member{"applied_at", S.ref("Timestamp")},
    C.Member{"queue_state", S.tag(queue_state)}]

def definitions() -> List<&2, C.Member>:
  [
    S.named("ExecutionState", S.enum(["pending", "acknowledged", "in_progress", "paused", "completed", "failed", "cancelled"])),
    S.named("NonterminalState", S.enum(["pending", "acknowledged", "in_progress", "paused"])),
    S.named("ResultDeclaration", S.closed([C.Member{"object_id", S.ref("Uuid")},
      C.Member{"required", S.typed("boolean")}], [])),
    S.named("ResultDeclarations", S.array(S.ref("ResultDeclaration"), 0, 128, True{})),
    S.named("Task", S.one_of(List.concat(&2, C.Json, [task_variants(Components.move_fields()), task_variants(Components.pause_fields()), task_variants(Components.resume_fields())]))),
    S.named("TaskQueue", S.closed([
      C.Member{"requested_task_ids", S.array(S.ref("Uuid"), 0, 1000, True{})},
      C.Member{"revision", S.ref("Counter")},
      C.Member{"confirmed", S.nullable(S.closed([C.Member{"revision", S.ref("Counter")},
        C.Member{"process_generation", S.ref("Uuid")}], []))}], [])),
    S.named("TaskControl", S.closed([
      C.Member{"revision", S.ref("Counter")},
      C.Member{"requested", S.nullable(S.one_of([
        S.closed([C.Member{"task_id", S.ref("Uuid")},
          C.Member{"command", S.tag("pause")},
          C.Member{"expires_at", S.typed("null")}], []),
        S.closed([C.Member{"task_id", S.ref("Uuid")},
          C.Member{"command", S.tag("resume")},
          C.Member{"expires_at", S.ref("Timestamp")}], [])]))},
      C.Member{"confirmed", S.nullable(S.closed([C.Member{"revision", S.ref("Counter")},
        C.Member{"task_id", S.ref("Uuid")},
        C.Member{"process_generation", S.ref("Uuid")},
        C.Member{"queue_state", S.enum(["paused", "running"])}], []))}], [])),
    S.named("ExecutionPayload", S.one_of([
      S.closed(execution_fields("state", S.enum(["acknowledged", "in_progress", "paused"]), []), execution_optional()),
      S.closed(execution_fields("state", S.tag("failed"), [C.Member{"reason", S.nonblank(64)}]), execution_optional()),
      S.closed(execution_fields("state", S.tag("cancelled"), [C.Member{"cancellation_request_id", S.ref("NewId")}]), execution_optional()),
      S.closed(execution_fields("state", S.tag("completed"), []), execution_optional()),
      S.closed(execution_fields("state", S.tag("completed"), control_fields("paused")), [C.Member{"message", S.text(1024)}]),
      S.closed(execution_fields("state", S.tag("completed"), S.members(control_fields("running"), [C.Member{"read_id", S.ref("NewId")},
        C.Member{"core_run_id", S.ref("Uuid")},
        C.Member{"captured_at", S.ref("Timestamp")},
        C.Member{"instructions_valid_until", S.ref("Timestamp")},
        C.Member{"queue_revision", S.ref("Counter")}])), [C.Member{"message", S.text(1024)}]),
      S.closed(execution_fields("cancellation_refused", S.ref("NonterminalState"), [C.Member{"cancellation_request_id", S.ref("NewId")},
        C.Member{"reason", S.nonblank(64)}]), execution_optional())])),
    S.named("ExecutionEvidence", evidence(S.ref("ExecutionPayload"))),
    S.named("ReportTaskExecution", S.closed([C.Member{"evidence", S.ref("ExecutionEvidence")}], [])),
    S.named("DeclarationBatch", S.array(S.ref("ResultDeclaration"), 1, 128, False{})),
    S.named("ReportTaskResults", S.closed([C.Member{"evidence", evidence(S.closed([C.Member{"task_id", S.ref("Uuid")},
      C.Member{"declarations", S.ref("DeclarationBatch")}], []))}], [])),
    S.named("QueueConfirmation", S.one_of([
      S.closed([C.Member{"queue_revision", S.ref("Counter")}], []),
      S.closed([C.Member{"queue_revision", S.ref("Counter")},
        C.Member{"control_revision", S.ref("Counter")},
        C.Member{"queue_state", S.enum(["paused", "running"])}], [])])),
    S.named("ConfirmTaskOrder", S.closed([C.Member{"evidence", evidence(S.ref("QueueConfirmation"))}], []))]
