import Base
import ./common.bend as C
import ./numbers.bend as N
import ./shapes.bend as H

def field(key: String, value: C.Json) -> C.Member:
  C.Member{key, value}

def strings(xs: List<&2, String>) -> List<&2, C.Json>:
  match xs:
    case Nil{}:
      Nil{}
    case Con{h, t}:
      Con{C.JStr{h}, strings(t)}

def object(properties: List<&2, C.Member>, required: List<&2, String>) -> C.Json:
  C.JObj{[field("type", C.JStr{"object"}), field("properties", C.JObj{properties}),
    field("required", C.JArr{strings(required)}), field("additionalProperties", C.JBool{False{}})]}

def ref(name: String) -> C.Json:
  H.ref(name)

def choice(xs: List<&2, C.Json>) -> C.Json:
  H.any_of(xs)

def nullable(value: C.Json) -> C.Json:
  H.nullable(value)

def literal(value: C.Json) -> C.Json:
  H.literal(value)

def enum(xs: List<&2, String>) -> C.Json:
  H.enum(xs)

def text(+max: U32, nonblank: Bool) -> C.Json:
  C.choose(C.Json, nonblank, _ => H.nonblank(max), _ => H.text(max))

def array(item: C.Json, max: U32, unique: Bool) -> C.Json:
  H.array(item, 0, max, unique)

def titled(name: String, value: C.Json) -> C.Json:
  H.add(value, [field("title", C.JStr{name})])

def nonempty(value: C.Json) -> C.Json:
  H.nonempty(value)

def ids() -> C.Json:
  array(ref("Uuid"), 1000, True{})

def descriptive_edits() -> C.Json:
  nonempty(object([field("alias", nullable(ref("Alias"))),
    field("description", nullable(ref("Description")))], Nil{}))

def retry_fields() -> List<&2, C.Member>:
  [field("request_id", ref("NewId"))]

def edit_fields() -> List<&2, C.Member>:
  [field("request_id", ref("NewId")), field("expected_edit_revision", ref("Counter"))]

def identity_request(+key: String) -> C.Json:
  object([field(key, ref("Uuid"))], [key])

def delete_request(+key: String) -> C.Json:
  object(Con{field(key, ref("Uuid")), retry_fields()}, [key, "request_id"])

def edit_request(+key: String, edits: C.Json) -> C.Json:
  object(List.append(&2, C.Member, [field(key, ref("Uuid")), field("edits", edits)], edit_fields()),
    [key, "request_id", "expected_edit_revision", "edits"])

def base_filters() -> List<&2, C.Member>:
  [field("ids", ids()), field("aliases", array(ref("Alias"), 1000, True{}))]

def filters(+kind: String) -> C.Json:
  +base = base_filters()
  C.choose(C.Json, String.eq(kind, "assets"),
    _ => object(List.append(&2, C.Member, base, [field("kinds", array(nullable(enum(["drone", "security_camera", "tracker", "other"])), 1000, True{})), field("health", array(ref("Health"), 1000, True{}))]), Nil{}),
    _ => C.choose(C.Json, String.eq(kind, "observations"),
      _ => object(List.append(&2, C.Member, base, [field("kinds", array(nullable(ref("SubjectKind")), 1000, True{})), field("publisher_ids", ids()), field("source_asset_ids", ids()), field("track_ids", ids())]), Nil{}),
      _ => C.choose(C.Json, String.eq(kind, "tracks") || String.eq(kind, "geofeatures"),
        _ => object(List.append(&2, C.Member, base, [field("kinds", array(nullable(ref(Bool.pick(String, String.eq(kind, "tracks"), "SubjectKind", "GeofeatureKind"))), 1000, True{}))]), Nil{}),
        _ => C.choose(C.Json, String.eq(kind, "tasks"),
          _ => object([field("ids", ids()), field("asset_ids", ids()), field("commands", array(enum(["move_to", "pause", "resume"]), 1000, True{})), field("states", array(choice([ref("ExecutionState"), literal(C.JStr{"cancellation_requested"})]), 1000, True{}))], Nil{}),
          _ => C.choose(C.Json, String.eq(kind, "objects"),
            _ => object([field("ids", ids()), field("content_types", array(ref("ContentType"), 1000, True{}))], Nil{}),
            _ => C.choose(C.Json, String.eq(kind, "api_keys"),
              _ => object([field("ids", ids()), field("operator_ids", ids())], Nil{}),
              _ => C.choose(C.Json, String.eq(kind, "operators"),
                _ => object([field("ids", ids())], Nil{}),
                _ => object([field(Bool.pick(String, String.eq(kind, "resources"), "kinds", "categories"), array(text(128, True{}), 1000, True{}))], Nil{}))))))))

def list_request(kind: String) -> C.Json:
  choice([object([field("page_size", ref("PageSize")), field("filters", filters(kind))], Nil{}), ref("Continuation")])

def associated_request(+key: String) -> C.Json:
  choice([object([field(key, ref("Uuid")), field("page_size", ref("PageSize"))], [key]), ref("Continuation")])

def page(item: String, key: String) -> C.Json:
  titled("Exchange.Page." ++ key, object([field("items", array(ref(item), 1000, False{})),
    field("next_page_token", nullable(ref("Opaque")))], ["items", "next_page_token"]))

def asset_result(required: Bool) -> C.Json:
  object([field("asset", ref("Asset")), field("evidence_disposition", ref("EvidenceDisposition"))],
    Bool.pick(List<&2, String>, required, ["asset", "evidence_disposition"], ["asset"]))

def observation_result(required: Bool) -> C.Json:
  titled("Exchange.ObservationResult", object([field("observation", ref("Observation")),
    field("track", ref("Track")), field("evidence_disposition", ref("EvidenceDisposition"))],
    Bool.pick(List<&2, String>, required, ["observation", "track", "evidence_disposition"], ["observation", "track"])))

def task_result() -> C.Json:
  object([field("task", ref("Task")), field("evidence_disposition", ref("EvidenceDisposition"))], ["task", "evidence_disposition"])

def register_request() -> C.Json:
  object([field("asset_id", ref("NewId")), field("registration_id", ref("NewId")), field("request_id", ref("NewId")),
    field("process_generation", ref("NewId")), field("api_key_id", ref("NewId")), field("secret", ref("Secret")),
    field("alias", ref("Alias")), field("description", ref("AssetDescription")), field("type", ref("AssetType")), field("capabilities", ref("Capabilities"))],
    ["asset_id", "registration_id", "request_id", "process_generation", "api_key_id", "secret"])

def update_request() -> C.Json:
  object([field("asset_id", ref("Uuid")), field("request_id", ref("NewId")), field("expected_edit_revision", ref("Counter")),
    field("alias", nullable(ref("Alias"))), field("description", nullable(ref("AssetDescription"))),
    field("type", ref("AssetType")), field("capabilities", ref("Capabilities")), field("report", ref("AssetReport"))], ["asset_id", "request_id"])

def create_observation_request() -> C.Json:
  object([field("observation_id", ref("NewId")), field("request_id", ref("NewId")), field("publisher_id", ref("Uuid")),
    field("source_asset_id", ref("Uuid")), field("publisher_subject", ref("PublisherSubject")), field("alias", ref("Alias")),
    field("description", ref("Description")), field("report", ref("ObservationReport"))], ["observation_id", "request_id", "publisher_id"])

def asset_status() -> C.Json:
  titled("Exchange.AssetStatus", object([field("asset_id", ref("Uuid")), field("status", ref("ReadSection.status")),
    field("communications", ref("Communications")), field("heartbeat", ref("Heartbeat"))], ["asset_id", "status", "communications", "heartbeat"]))

type Operation is Data:
  Operation{name: String, method: String, path: String, transport: String, discovery: Bool, committed: Bool,
    statuses: List<&2, C.Json>, request: C.Json, data: C.Json}

def post(name: String, path: String, request: C.Json, data: C.Json, committed: Bool) -> Operation:
  Operation{name, "POST", path, "json", False{}, committed, [C.JNum{"200"}], request, data}

def operations() -> List<&2, Operation>:
  [post("ListResources", "/messages/list_resources", list_request("resources"), page("ResourceUsage", "kind"), False{}),
   post("ReadActivity", "/messages/read_activity", list_request("activity"), page("Activity", "activity_id"), False{}),
   post("ListApiKeys", "/messages/list_api_keys", list_request("api_keys"), page("ApiKey", "api_key_id"), False{}),
   post("CreateApiKey", "/messages/create_api_key", object([field("request_id", ref("NewId")), field("api_key_id", ref("NewId")), field("secret", ref("Secret")), field("operator_id", ref("Uuid"))], ["request_id", "api_key_id", "secret"]), ref("ApiKey"), True{}),
   post("RevokeApiKey", "/messages/revoke_api_key", delete_request("api_key_id"), ref("ApiKey"), True{}),
   post("ListOperators", "/messages/list_operators", list_request("operators"), page("Operator", "operator_id"), False{}),
   post("GetOperator", "/messages/get_operator", identity_request("operator_id"), ref("Operator"), False{}),
   post("CreateOperator", "/messages/create_operator", object([field("request_id", ref("NewId")), field("operator_id", ref("NewId")), field("name", text(256, True{})), field("description", text(4096, False{}))], ["request_id", "operator_id", "name"]), ref("Operator"), True{}),
   post("EditOperator", "/messages/edit_operator", edit_request("operator_id", nonempty(object([field("name", text(256, True{})), field("description", nullable(text(4096, False{})))], Nil{}))), ref("Operator"), True{}),
   post("DeleteOperator", "/messages/delete_operator", delete_request("operator_id"), object([field("deleted", literal(C.JBool{True{}}))], ["deleted"]), True{}),
   Operation{"GetHealth", "GET", "/health", "json", True{}, False{}, [C.JNum{"200"}], object(Nil{}, Nil{}), ref("HealthData")},
   Operation{"GetReadiness", "GET", "/readiness", "json", False{}, False{}, [C.JNum{"200"}, C.JNum{"503"}], object(Nil{}, Nil{}), ref("Readiness")},
   Operation{"GetReference", "GET", "/reference", "reference", False{}, False{}, [C.JNum{"200"}], object(Nil{}, Nil{}), object(Nil{}, Nil{})},
   post("RegisterAsset", "/messages/register_asset", register_request(), object([field("asset", ref("Asset")), field("api_key", ref("ApiKey"))], ["asset", "api_key"]), True{}),
   post("ListAssets", "/messages/list_assets", list_request("assets"), page("Asset", "id"), False{}),
   post("GetAsset", "/messages/get_asset", identity_request("asset_id"), ref("Asset"), False{}),
   post("GetAssetByAlias", "/messages/get_asset_by_alias", object([field("alias", ref("Alias"))], ["alias"]), ref("Asset"), False{}),
   post("UpdateAsset", "/messages/update_asset", update_request(), asset_result(False{}), False{}),
   post("DeleteAsset", "/messages/delete_asset", delete_request("asset_id"), object([field("deleted", literal(C.JBool{True{}}))], ["deleted"]), True{}),
   post("GetAssetStatus", "/messages/get_asset_status", identity_request("asset_id"), asset_status(), False{}),
   post("GetAssetMovementHistory", "/messages/get_asset_movement_history", ref("HistoryQuery"), ref("HistoryPage"), False{}),
   post("GetAssetObjects", "/messages/get_asset_objects", associated_request("asset_id"), page("ObjectImage", "object_id"), False{}),
   post("CreateObservation", "/messages/create_observation", create_observation_request(), observation_result(False{}), True{}),
   post("ReportObservation", "/messages/report_observation", object([field("observation_id", ref("Uuid")), field("publisher_id", ref("Uuid")), field("report", ref("ObservationReport"))], ["observation_id", "publisher_id", "report"]), observation_result(True{}), False{}),
   post("EditObservation", "/messages/edit_observation", edit_request("observation_id", descriptive_edits()), ref("Observation"), True{}),
   post("ListObservations", "/messages/list_observations", list_request("observations"), page("Observation", "id"), False{}),
   post("GetObservation", "/messages/get_observation", identity_request("observation_id"), ref("Observation"), False{}),
   post("GetObservationByAlias", "/messages/get_observation_by_alias", object([field("alias", ref("Alias"))], ["alias"]), ref("Observation"), False{}),
   post("GetObservationMovementHistory", "/messages/get_observation_movement_history", ref("HistoryQuery"), ref("HistoryPage"), False{}),
   post("GetObservationObjects", "/messages/get_observation_objects", associated_request("observation_id"), page("ObjectImage", "object_id"), False{}),
   post("ListTracks", "/messages/list_tracks", list_request("tracks"), page("Track", "id"), False{}),
   post("GetTrack", "/messages/get_track", identity_request("track_id"), ref("Track"), False{}),
   post("GetTrackByAlias", "/messages/get_track_by_alias", object([field("alias", ref("Alias"))], ["alias"]), ref("Track"), False{}),
   post("EditTrack", "/messages/edit_track", edit_request("track_id", descriptive_edits()), ref("Track"), True{}),
   post("GetTrackObservations", "/messages/get_track_observations", choice([object([field("track_id", ref("Uuid")), field("page_size", ref("PageSize")), field("publisher_ids", ids()), field("source_asset_ids", ids())], ["track_id"]), ref("Continuation")]), page("Observation", "id"), False{}),
   post("GetTrackMovementHistory", "/messages/get_track_movement_history", ref("HistoryQuery"), ref("HistoryPage"), False{}),
   post("GetTrackObjects", "/messages/get_track_objects", associated_request("track_id"), page("ObjectImage", "object_id"), False{}),
   post("CreateGeofeature", "/messages/create_geofeature", object([field("request_id", ref("NewId")), field("geofeature_id", ref("NewId")), field("geometry", ref("Geometry")), field("alias", ref("Alias")), field("description", ref("Description")), field("type", ref("GeofeatureType"))], ["request_id", "geofeature_id", "geometry"]), ref("Geofeature"), True{}),
   post("ListGeofeatures", "/messages/list_geofeatures", list_request("geofeatures"), page("Geofeature", "id"), False{}),
   post("GetGeofeature", "/messages/get_geofeature", identity_request("geofeature_id"), ref("Geofeature"), False{}),
   post("GetGeofeatureByAlias", "/messages/get_geofeature_by_alias", object([field("alias", ref("Alias"))], ["alias"]), ref("Geofeature"), False{}),
   post("EditGeofeature", "/messages/edit_geofeature", edit_request("geofeature_id", nonempty(object([field("alias", nullable(ref("Alias"))), field("description", nullable(ref("Description"))), field("type", ref("GeofeatureType")), field("geometry", ref("Geometry"))], Nil{}))), ref("Geofeature"), True{}),
   post("DeleteGeofeature", "/messages/delete_geofeature", delete_request("geofeature_id"), object([field("deleted", literal(C.JBool{True{}}))], ["deleted"]), True{}),
   post("GetGeofeatureObjects", "/messages/get_geofeature_objects", associated_request("geofeature_id"), page("ObjectImage", "object_id"), False{}),
   post("CreateTask", "/messages/create_task", ref("CreateTask"), ref("Task"), True{}),
   post("ListTasks", "/messages/list_tasks", list_request("tasks"), page("Task", "task_id"), False{}),
   post("GetTask", "/messages/get_task", identity_request("task_id"), ref("Task"), False{}),
   post("ReportTaskExecution", "/messages/report_task_execution", ref("ReportTaskExecution"), task_result(), False{}),
   post("RequestTaskCancellation", "/messages/request_task_cancellation", delete_request("task_id"), ref("Task"), False{}),
   post("ReportTaskResults", "/messages/report_task_results", ref("ReportTaskResults"), task_result(), False{}),
   post("GetTaskObjects", "/messages/get_task_objects", associated_request("task_id"), page("ObjectImage", "object_id"), False{}),
   post("GetAssignedTasks", "/messages/get_assigned_tasks", choice([object([field("asset_id", ref("Uuid")), field("process_generation", ref("Uuid")), field("read_id", ref("NewId")), field("page_size", ref("PageSize"))], ["asset_id", "process_generation", "read_id"]), ref("Continuation")]), ref("AssignedTasks"), False{}),
   post("SetTaskOrder", "/messages/set_task_order", object([field("request_id", ref("NewId")), field("asset_id", ref("Uuid")), field("expected_queue_revision", ref("Counter")), field("task_ids", ids())], ["request_id", "asset_id", "expected_queue_revision", "task_ids"]), ref("Asset"), True{}),
   post("ConfirmTaskOrder", "/messages/confirm_task_order", ref("ConfirmTaskOrder"), asset_result(True{}), False{}),
   Operation{"UploadObject", "POST", "/objects", "upload", False{}, True{}, [C.JNum{"200"}], ref("UploadDescriptor"), ref("ObjectImage")},
   post("ListObjects", "/messages/list_objects", list_request("objects"), page("ObjectImage", "object_id"), False{}),
   post("GetObject", "/messages/get_object", identity_request("object_id"), ref("ObjectImage"), False{}),
   post("EditObject", "/messages/edit_object", edit_request("object_id", ref("ObjectEdits")), ref("ObjectImage"), True{}),
   post("DeleteObject", "/messages/delete_object", delete_request("object_id"), object([field("deleted", literal(C.JBool{True{}}))], ["deleted"]), True{}),
   Operation{"ReadObjectContent", "GET", "/objects/{object_id}/content", "content", False{}, False{}, [C.JNum{"200"}], object([field("object_id", ref("Uuid")), field("disposition", enum(["inline", "attachment"]))], ["object_id", "disposition"]), ref("ContentDescriptor")},
   post("ReleaseHistoryView", "/messages/release_history_view", ref("Release"), ref("Released"), False{}),
   post("ReadSnapshot", "/messages/read_snapshot", ref("ReadSnapshot"), ref("SnapshotPage"), False{}),
   post("ReleaseSnapshot", "/messages/release_snapshot", ref("Release"), ref("Released"), False{}),
   post("ReadChanges", "/messages/read_changes", ref("ReadChanges"), ref("ReplayPage"), False{}),
   post("BeginAssetContact", "/messages/begin_asset_contact", ref("BeginAssetContact"), ref("ContactChallenge"), False{}),
   post("ReplaceAssetProcess", "/messages/replace_asset_process", ref("ReplaceAssetProcess"), asset_result(True{}), True{})]

def catalog_entry(operation: Operation) -> C.Json:
  match operation:
    case Operation{name, method, path, +transport, discovery, committed, statuses, request, data}:
      C.JObj{[field("operationId", C.JStr{name}), field("method", C.JStr{method}), field("path", C.JStr{path}),
        field("transport", C.JStr{transport}), field("discovery", C.JBool{discovery}), field("committed", C.JBool{committed}),
        field("successStatuses", C.JArr{statuses}),
        field("requestMedia", C.JStr{Bool.pick(String, String.eq(transport, "upload"), "multipart/form-data", "application/json")}),
        field("responseMedia", C.JStr{Bool.pick(String, String.eq(transport, "content"), "binary",
          Bool.pick(String, String.eq(transport, "reference"), "application/vnd.oai.openapi+json", "application/json"))})]}

def catalog_entries(xs: List<&2, Operation>) -> List<&2, C.Json>:
  match xs:
    case Nil{}:
      Nil{}
    case Con{h, t}:
      Con{catalog_entry(h), catalog_entries(t)}

def catalog() -> C.Json:
  C.JArr{catalog_entries(operations())}

def find(xs: List<&2, Operation>, +name: String) -> Maybe<&2, Operation>:
  match xs:
    case Nil{}:
      None{}
    case Con{+h, t}:
      Operation{n, m, p, tr, di, co, st, r, d} = h
      C.choose(Maybe<&2, Operation>, String.eq(n, name), _ => Some{h}, _ => find(t, name))

def found_binding(value: Maybe<&2, Operation>) -> C.Json:
  match value:
    case None{}:
      C.JMissing{}
    case Some{operation}:
      catalog_entry(operation)

def binding(name: String) -> C.Json:
  found_binding(find(operations(), name))

def success_schema(data: C.Json, committed: Bool) -> C.Json:
  object([field("dataset_id", ref("Uuid")), field("data", data), field("commit_cursor", ref("Opaque"))],
    Bool.pick(List<&2, String>, committed, ["dataset_id", "data", "commit_cursor"], ["dataset_id", "data"]))

def response_schema(+name: String, +transport: String, statuses: List<&2, C.Json>) -> C.Json:
  +success = C.choose(C.Json, String.eq(transport, "reference"),
    _ => object([field("kind", literal(C.JStr{"reference"})), field("status", literal(C.JNum{"200"})),
      field("media", enum(["application/vnd.oai.openapi+json", "text/html"])), field("document", text(4194304, False{}))], ["kind", "status", "media", "document"]),
    _ => C.choose(C.Json, String.eq(transport, "content"),
      _ => object([field("kind", literal(C.JStr{"content"})), field("status", literal(C.JNum{"200"})), field("descriptor", ref("ContentDescriptor"))], ["kind", "status", "descriptor"]),
      _ => object([field("kind", literal(C.JStr{"success"})), field("status", C.JObj{[field("enum", C.JArr{statuses})]}), field("body", ref("Success." ++ name))], ["kind", "status", "body"])))
  choice([success, ref("HttpError")])

def error_statuses() -> List<&2, String>:
  ["400", "401", "404", "409", "410", "413", "422", "429", "500", "507"]

def operation_definitions(xs: List<&2, Operation>) -> List<&2, C.Member>:
  match xs:
    case Nil{}:
      Nil{}
    case Con{Operation{+n, method, path, transport, discovery, committed, statuses, request, data}, t}:
      Con{field("Request." ++ n, titled("Request." ++ n, request)),
        Con{field("Success." ++ n, success_schema(data, committed)),
          Con{field("Response." ++ n, response_schema(n, transport, statuses)), operation_definitions(t)}}}

def error_definitions(xs: List<&2, String>) -> List<&2, C.Member>:
  match xs:
    case Nil{}:
      Nil{}
    case Con{+h, t}:
      Con{field("Exchange.ErrorEnvelope." ++ h,
        object([field("dataset_id", ref("Uuid")), field("error", ref("Error." ++ h))], ["dataset_id", "error"])), error_definitions(t)}

def definitions() -> List<&2, C.Member>:
  List.append(&2, C.Member, operation_definitions(operations()), error_definitions(error_statuses()))

def schema(name: String) -> C.Json:
  C.lookup(definitions(), name)

def names() -> List<&2, String>:
  H.keys(definitions())

def missing(value: C.Json) -> Bool:
  match value:
    case C.JMissing{}:
      True{}
    case _:
      False{}

def null(value: C.Json) -> Bool:
  match value:
    case C.JNull{}:
      True{}
    case _:
      False{}

def present(value: C.Json) -> Bool:
  Bool.not(missing(value))

def uint_result(value: Maybe<&2, U32>, fallback: U32) -> U32:
  match value:
    case None{}:
      fallback
    case Some{x}:
      x

def parsed_uint(value: Maybe<&2, U32>, raw: String, fallback: U32) -> U32:
  match value:
    case Some{x}:
      x
    case None{}:
      uint_result(U32.read(N.format(raw)), fallback)

def uint(value: C.Json, fallback: U32) -> U32:
  match value:
    case C.JNum{+raw}:
      parsed_uint(U32.read(raw), raw, fallback)
    case _:
      fallback

def same_field(+a: C.Json, ak: String, +b: C.Json, bk: String) -> Bool:
  C.equal(C.get(a, ak), C.get(b, bk))

def fields_equal(xs: List<&2, String>, +a: C.Json, +b: C.Json) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case Con{+h, t}:
      same_field(a, h, b, h) && fields_equal(t, a, b)

def any_field(xs: List<&2, String>, +value: C.Json) -> Bool:
  match xs:
    case Nil{}:
      False{}
    case Con{h, t}:
      C.has(value, h) || any_field(t, value)

def after(prior: Maybe<&2, String>, current: String) -> Bool:
  match prior:
    case None{}:
      True{}
    case Some{p}:
      Cmp.is_lt(String.order(p, current))

def ordered_items(xs: List<&2, C.Json>, +key: String, prior: Maybe<&2, String>) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case Con{h, t}:
      +current = C.string(C.get(h, key))
      after(prior, current) && ordered_items(t, key, Some{current})

def source_matches(xs: List<&2, C.Json>, +observation: C.Json) -> Bool:
  match xs:
    case Nil{}:
      False{}
    case Con{+h, t}:
      (same_field(h, "observation_id", observation, "id") &&
        fields_equal(["publisher_id", "source_asset_id"], h, observation)) || source_matches(t, observation)

def observation_pair(+value: C.Json) -> Bool:
  +observation = C.get(value, "observation")
  +track = C.get(value, "track")
  same_field(observation, "dataset_id", track, "dataset_id") &&
    same_field(observation, "track_id", track, "id") &&
    source_matches(C.items(C.get(track, "sources")), observation) &&
    fields_equal(["type", "telemetry", "attitude", "geometry"], observation, track)

def evidence_matches(+evidence: C.Json, +asset_id: C.Json) -> Bool:
  missing(evidence) || null(evidence) ||
    (C.equal(C.get(evidence, "entity_id"), asset_id) &&
      String.eq(C.string(C.get(C.get(evidence, "origin"), "kind")), "asset_process"))

def evidence_scope(+evidence: C.Json) -> C.Json:
  C.JArr{[C.get(evidence, "dataset_id"), C.get(evidence, "entity_id"), C.get(evidence, "origin"), C.get(evidence, "report_id")]}

def status_context(+value: C.Json) -> Bool:
  +a = C.get(C.get(value, "status"), "evidence")
  +b = C.get(C.get(C.get(value, "communications"), "capacity"), "evidence")
  evidence_matches(a, C.get(value, "asset_id")) && evidence_matches(b, C.get(value, "asset_id")) &&
    (missing(a) || null(a) || missing(b) || null(b) || Bool.not(C.equal(evidence_scope(a), evidence_scope(b))) ||
      same_field(a, "sequence", b, "sequence"))

def observation_report_context(+value: C.Json) -> Bool:
  +report = C.get(value, "report")
  missing(report) || (same_field(report, "entity_id", value, "observation_id") &&
    same_field(C.get(report, "origin"), "publisher_id", value, "publisher_id"))

def refine(+name: String, +value: C.Json) -> Result<&2, &2, C.Failure, Unit>:
  C.require(C.choose(Bool, String.starts_with(name, "Exchange.Page."),
    _ => ordered_items(C.items(C.get(value, "items")), String.drop(name, 14n), None{}),
    _ => C.choose(Bool, String.eq(name, "Exchange.ObservationResult"),
      _ => observation_pair(value),
      _ => C.choose(Bool, String.eq(name, "Exchange.AssetStatus"),
        _ => status_context(value),
        _ => C.choose(Bool, String.eq(name, "Request.UpdateAsset"),
          _ => (any_field(["alias", "description", "type", "capabilities"], value) || C.has(value, "report")) &&
            (Bool.not(any_field(["alias", "description", "type", "capabilities"], value)) || C.has(value, "expected_edit_revision")) &&
            (Bool.not(C.has(value, "report")) || same_field(C.get(value, "report"), "entity_id", value, "asset_id")),
          _ => C.choose(Bool, String.eq(name, "Request.CreateObservation") || String.eq(name, "Request.ReportObservation"),
            _ => observation_report_context(value), _ => True{}))))), C.InvalidValue{})

def page_size(+request: C.Json, entries: List<&2, C.Json>) -> Bool:
  missing(request) || C.has(request, "page_token") ||
    U32.is_le(U32.from_nat(List.length(&2, C.Json, entries)), uint(C.get(request, "page_size"), 100))

def items_match(xs: List<&2, C.Json>, +key: String, +value: C.Json) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case Con{h, t}:
      C.equal(C.get(h, key), value) && items_match(t, key, value)

def includes(xs: List<&2, C.Json>, +value: C.Json) -> Bool:
  match xs:
    case Nil{}:
      False{}
    case Con{h, t}:
      C.equal(h, value) || includes(t, value)

def history_readings(xs: List<&2, C.Json>, +kind: String, +entity_id: C.Json) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case Con{+h, t}:
      C.choose(Bool, String.eq(kind, "track"),
        _ => includes(C.items(C.get(h, "track_ids")), entity_id),
        _ => String.eq(C.string(C.get(h, "source_entity_kind")), kind) && C.equal(C.get(h, "source_entity_id"), entity_id)) &&
        history_readings(t, kind, entity_id)

def history_matches(kind: String, +request: C.Json, +data: C.Json) -> Bool:
  page_size(request, C.items(C.get(data, "readings"))) &&
    (missing(request) || C.has(request, "page_token") ||
      (same_field(request, "query_id", data, "query_id") &&
        history_readings(C.items(C.get(data, "readings")), kind, C.get(request, "entity_id"))))

type Identity is Data:
  Identity{operation: String, request_key: String, data_key: String}

def identities() -> List<&2, Identity>:
  [Identity{"GetOperator", "operator_id", "operator_id"}, Identity{"CreateOperator", "operator_id", "operator_id"}, Identity{"EditOperator", "operator_id", "operator_id"},
   Identity{"GetAsset", "asset_id", "id"}, Identity{"GetAssetStatus", "asset_id", "asset_id"}, Identity{"SetTaskOrder", "asset_id", "id"},
   Identity{"EditObservation", "observation_id", "id"}, Identity{"GetObservation", "observation_id", "id"},
   Identity{"GetTrack", "track_id", "id"}, Identity{"EditTrack", "track_id", "id"},
   Identity{"CreateGeofeature", "geofeature_id", "id"}, Identity{"GetGeofeature", "geofeature_id", "id"}, Identity{"EditGeofeature", "geofeature_id", "id"},
   Identity{"GetTask", "task_id", "task_id"}, Identity{"GetObject", "object_id", "object_id"}, Identity{"EditObject", "object_id", "object_id"}]

def identity_matches(xs: List<&2, Identity>, +operation: String, +request: C.Json, +data: C.Json) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case Con{Identity{name, rk, dk}, t}:
      C.choose(Bool, String.eq(name, operation), _ => missing(request) || same_field(request, rk, data, dk),
        _ => identity_matches(t, operation, request, data))

def terminal(+state: C.Json) -> Bool:
  C.equal(state, C.JStr{"completed"}) || C.equal(state, C.JStr{"failed"}) || C.equal(state, C.JStr{"cancelled"})

def first_cursor(messages: List<&2, C.Json>, data: C.Json) -> C.Json:
  match messages:
    case Nil{}:
      C.get(data, "through_cursor")
    case Con{h, t}:
      C.get(C.get(h, "data"), "previous_cursor")

def limits_within(+limits: C.Json, +request: C.Json) -> Bool:
  U32.is_le(uint(C.get(limits, "max_message_bytes"), 0), uint(C.get(request, "max_message_bytes"), 0)) &&
    U32.is_le(uint(C.get(limits, "max_json_values"), 0), uint(C.get(request, "max_json_values"), 0)) &&
    U32.is_le(uint(C.get(limits, "max_changes"), 0), uint(C.get(request, "max_changes"), 0))

def bool_equal(a: Bool, b: Bool) -> Bool:
  Bool.not(Bool.xor(a, b))

def creation_matches(+operation: String, +request: C.Json, +data: C.Json) -> Bool:
  (Bool.not(String.eq(operation, "CreateApiKey")) ||
    (same_field(request, "api_key_id", data, "api_key_id") &&
      C.equal(C.choose(C.Json, C.has(request, "operator_id"), _ => C.get(request, "operator_id"), _ => C.JNull{}), C.get(data, "operator_id")))) &&
  (Bool.not(String.eq(operation, "RegisterAsset")) ||
    (same_field(request, "asset_id", C.get(data, "asset"), "id") &&
      same_field(request, "api_key_id", C.get(data, "api_key"), "api_key_id"))) &&
  (Bool.not(String.eq(operation, "CreateObservation")) ||
    (same_field(request, "observation_id", C.get(data, "observation"), "id") &&
      fields_equal(["publisher_id", "source_asset_id"], request, C.get(data, "observation")) &&
      fields_equal(["id", "lifetime_id"], C.get(request, "publisher_subject"), C.get(C.get(data, "observation"), "publisher_subject")) &&
      bool_equal(C.has(request, "report"), C.has(data, "evidence_disposition")))) &&
  (Bool.not(String.eq(operation, "CreateTask")) ||
    (fields_equal(["request_id", "task_id", "asset_id", "command", "scheduling", "inputs"], request, data) &&
      (Bool.not(C.equal(C.get(request, "command"), C.JStr{"resume"})) || fields_equal(["expires_at"], request, data)))) &&
  (Bool.not(String.eq(operation, "UploadObject")) ||
    fields_equal(["object_id", "byte_length", "sha256", "content_type"], request, data))

def evidence_response_matches(+operation: String, +request: C.Json, +data: C.Json, envelope: C.Json) -> Bool:
  (Bool.not(String.eq(operation, "UpdateAsset")) ||
    (same_field(request, "asset_id", C.get(data, "asset"), "id") &&
      bool_equal(C.has(request, "report"), C.has(data, "evidence_disposition")) &&
      (Bool.not(any_field(["alias", "description", "type", "capabilities"], request)) || C.has(envelope, "commit_cursor")))) &&
  (Bool.not(String.eq(operation, "ReportObservation")) ||
    (same_field(request, "observation_id", C.get(data, "observation"), "id") &&
      same_field(request, "publisher_id", C.get(data, "observation"), "publisher_id"))) &&
  (Bool.not(String.eq(operation, "ReportTaskExecution") || String.eq(operation, "ReportTaskResults")) ||
    (same_field(C.get(request, "evidence"), "asset_id", C.get(data, "task"), "asset_id") &&
      same_field(C.get(C.get(request, "evidence"), "payload"), "task_id", C.get(data, "task"), "task_id"))) &&
  (Bool.not(String.eq(operation, "ConfirmTaskOrder")) ||
    same_field(C.get(request, "evidence"), "asset_id", C.get(data, "asset"), "id")) &&
  (Bool.not(String.eq(operation, "ReplaceAssetProcess")) ||
    (same_field(request, "asset_id", C.get(data, "asset"), "id") &&
      fields_equal(["process_generation"], request, C.get(data, "asset"))))

def paged_response_matches(+operation: String, +request: C.Json, +data: C.Json) -> Bool:
  C.has(request, "page_token") ||
    ((Bool.not(String.eq(operation, "GetTrackObservations")) ||
      items_match(C.items(C.get(data, "items")), "track_id", C.get(request, "track_id"))) &&
     (Bool.not(String.eq(operation, "GetAssignedTasks")) ||
      fields_equal(["asset_id", "process_generation", "read_id"], request, data)) &&
     (Bool.not(String.eq(operation, "ReadSnapshot")) ||
      (fields_equal(["load_id"], request, data) && limits_within(C.get(data, "limits"), request))) &&
     (Bool.not(String.eq(operation, "ReadChanges")) ||
      C.equal(first_cursor(C.items(C.get(data, "messages")), data), C.get(request, "from_cursor"))))

def special_matches(~fold: String -> String, +operation: String, +request: C.Json,
    +envelope: C.Json, +data: C.Json, status: U32, version: String) -> Bool:
  (Bool.not(String.eq(operation, "GetHealth")) || C.equal(C.get(data, "protocol_version"), C.JStr{version})) &&
  (Bool.not(String.eq(operation, "GetReadiness")) || C.equal(C.get(data, "ready"), C.JBool{U32.is_eq(status, 200)})) &&
  (Bool.not(String.eq(operation, "RequestTaskCancellation")) ||
    ((missing(request) || same_field(request, "task_id", data, "task_id")) &&
      (terminal(C.get(data, "execution_state")) ||
        (Bool.not(null(C.get(data, "cancellation_request_id"))) && C.has(envelope, "commit_cursor") &&
          (missing(request) || same_field(data, "cancellation_request_id", request, "request_id")))))) &&
  (Bool.not(String.eq(operation, "RevokeApiKey")) ||
    (Bool.not(null(C.get(data, "revoked_at"))) && (missing(request) || same_field(request, "api_key_id", data, "api_key_id")))) &&
  (Bool.not(String.eq(operation, "ReadObjectContent")) ||
    (present(request) && same_field(request, "disposition", data, "disposition"))) &&
  C.choose(Bool, missing(request), _ => True{},
    _ => creation_matches(operation, request, data) &&
      evidence_response_matches(operation, request, data, envelope) &&
      paged_response_matches(operation, request, data) &&
      (Bool.not(String.eq(operation, "BeginAssetContact")) ||
        (fields_equal(["asset_id", "process_generation", "mode"], request, data) &&
          (C.equal(C.get(request, "mode"), C.JStr{"current"}) || fields_equal(["expected_process_generation"], request, data)))) &&
      C.choose(Bool, String.ends_with(operation, "ByAlias"),
        _ => C.has(data, "alias") && String.eq(fold(C.string(C.get(request, "alias"))), fold(C.string(C.get(data, "alias")))),
        _ => True{}))

def check_response(~fold: String -> String, +operation: String, +request: C.Json,
    +envelope: C.Json, status: U32, version: String) -> Result<&2, &2, C.Failure, Unit>:
  +data = C.get(envelope, "data")
  +history = String.ends_with(operation, "MovementHistory")
  C.require(present(binding(operation)) && (C.has(envelope, "error") ||
    (identity_matches(identities(), operation, request, data) &&
      (Bool.not(C.has(data, "items")) || page_size(request, C.items(C.get(data, "items")))) &&
      (Bool.not(C.has(data, "tasks")) || page_size(request, C.items(C.get(data, "tasks")))) &&
      (Bool.not(history) || history_matches(
        Bool.pick(String, String.eq(operation, "GetAssetMovementHistory"), "asset",
          Bool.pick(String, String.eq(operation, "GetObservationMovementHistory"), "observation", "track")), request, data)) &&
      special_matches(~fold, operation, request, envelope, data, status, version))), C.InvalidHttp{})
