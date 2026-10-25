import Base
import ./common.bend as C
import ./scalar-rules.bend as S
import ./geometry.bend as G

def field(value: C.Json, key: String) -> String:
  C.string(C.get(value, key))

def tagged(+value: C.Json, key: String, wanted: String) -> Bool:
  String.eq(field(value, key), wanted)

def absent(value: C.Json) -> Bool:
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

def present(+value: C.Json) -> Bool:
  Bool.not(absent(value) || null(value))

def set_found(pair: Set() & Bool) -> Bool:
  (keys, found) = pair
  found

def map_value(-A: Data, pair: Map<&2, A> & A) -> A:
  (map, value) = pair
  value

def unique(~key: C.Json -> String, xs: List<&2, C.Json>, +seen: Set()) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case Con{h, t}:
      +k = key(h)
      exists = set_found(Set.has(seen, k))
      Bool.not(exists) && unique(~key, t, Set.add(seen, k))

def ordered(~key: C.Json -> String, xs: List<&2, C.Json>, previous: Maybe<&2, String>) -> Bool:
  match xs previous:
    case Nil{} _:
      True{}
    case Con{h, t} None{}:
      ordered(~key, t, Some{key(h)})
    case Con{h, t} Some{prior}:
      +k = key(h)
      Cmp.is_lt(String.order(prior, k)) && ordered(~key, t, Some{k})

def id(value: C.Json) -> String:
  field(value, "id")

def object_id(value: C.Json) -> String:
  field(value, "object_id")

def task_id(value: C.Json) -> String:
  field(value, "task_id")

def change_key(+value: C.Json) -> String:
  field(value, "resource_kind") ++ ":" ++ field(value, "resource_id")

def nonempty(value: C.Json) -> Bool:
  Bool.not(Nat.is_eq(List.length(&2, C.Member, C.members(value)), 0n))

def truth(value: C.Json) -> Bool:
  match value:
    case C.JBool{x}:
      x
    case _:
      False{}

def same_flag_batch(xs: List<&2, C.Json>, +flags: Map<&2, C.Json>) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case Con{+h, t}:
      +k = object_id(h)
      +flag = C.get(h, "required")
      +prior = map_value(C.Json, Map.get(C.Json, C.JMissing{}, flags, k))
      (absent(prior) || C.equal(prior, flag)) &&
        same_flag_batch(t, Map.set(&2, C.Json, flags, k, flag))

def singular(+value: C.Json) -> Bool:
  C.equal(value, C.JNum{"90"}) || C.equal(value, C.JNum{"-90"})

def attitude(+value: C.Json) -> Bool:
  Bool.not(singular(C.get(value, "pitch"))) ||
    (null(C.get(value, "heading")) && null(C.get(value, "roll")))

def gimbal(+value: C.Json) -> Bool:
  Bool.not(singular(C.get(value, "elevation"))) || null(C.get(value, "bearing"))

def applicable(xs: List<&2, C.Member>, +value: C.Json) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case Con{C.Member{+k, v}, t}:
      (String.eq(k, "geometry") || C.has(value, k)) && applicable(t, value)

def reserve_find(xs: List<&2, C.Json>, +key: String) -> C.Json:
  match xs:
    case Nil{}:
      C.JMissing{}
    case Con{+h, t}:
      C.choose(C.Json, String.eq(id(h), key), _ => h, _ => reserve_find(t, key))

def reserve_times(xs: List<&2, C.Member>, +reserves: List<&2, C.Json>) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case Con{C.Member{k, +times}, t}:
      +reserve = reserve_find(reserves, k)
      present(reserve) && (tagged(reserve, "kind", "battery") ||
        (Bool.not(C.has(times, "voltage_volts")) && Bool.not(C.has(times, "current_amperes")))) &&
        reserve_times(t, reserves)

def initial_value(section: String, +value: C.Json) -> Bool:
  match section:
    case "status":
      tagged(value, "condition", "unknown") && Bool.not(C.has(value, "explanation"))
    case "communications":
      null(C.get(value, "bandwidth_bps"))
    case "type":
      null(C.get(value, "kind"))
    case _:
      False{}

def section(+name: String, +value: C.Json, read: Bool) -> Bool:
  +payload = C.get(value, "value")
  +times = C.get(value, "source_times")
  Bool.not(tagged(value, "state", "value")) ||
    (applicable(C.members(times), payload) &&
      (Bool.not(String.eq(name, "power")) ||
        reserve_times(C.members(C.get(times, "reserves")), C.items(C.get(payload, "reserves")))) &&
      (Bool.not(String.eq(name, "telemetry")) || Bool.not(Bool.xor(C.has(payload, "airspeed"),
        C.has(C.get(value, "constituents"), "airspeed")))) &&
      (Bool.not(read && null(C.get(value, "evidence"))) ||
        (initial_value(name, payload) && tagged(value, "classification", "state_until_changed") &&
          null(C.get(value, "observed_at")) && absent(times))))

def origin_id(+origin: C.Json) -> String:
  C.choose(String, tagged(origin, "kind", "publisher"),
    _ => field(origin, "publisher_id"), _ => field(origin, "process_generation"))

def origins(xs: List<&2, C.Member>, +kind: String, +publisher: String) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case Con{C.Member{k, reading}, t}:
      +origin = C.get(reading, "origin")
      tagged(origin, "kind", kind) && (Bool.not(String.eq(kind, "publisher")) ||
        String.eq(field(origin, "publisher_id"), publisher)) && origins(t, kind, publisher)

def constituents(section_value: C.Json) -> List<&2, C.Member>:
  match section_value:
    case C.JObj{+xs}:
      C.choose(List<&2, C.Member>, tagged(C.JObj{xs}, "state", "value"),
        _ => C.members(C.get(C.JObj{xs}, "constituents")), _ => Nil{})
    case _:
      Nil{}

def report(+value: C.Json, +asset: Bool) -> Bool:
  +sections = C.get(value, "sections")
  +proof = C.has(value, "contact_proof")
  (nonempty(sections) || (asset && tagged(value, "mode", "current") && proof)) &&
    (Bool.not(proof) || present(C.get(value, "generated_at"))) &&
    origins(constituents(C.get(sections, "telemetry")),
      Bool.pick(String, asset, "asset_process", "publisher"), field(C.get(value, "origin"), "publisher_id"))

def reported_sections(+value: C.Json, asset: Bool) -> List<&2, C.Json>:
  C.choose(List<&2, C.Json>, asset,
    _ => [C.get(value, "status"), C.get(C.get(value, "communications"), "capacity"),
      C.get(value, "telemetry"), C.get(value, "attitude"), C.get(value, "power"),
      C.get(value, "camera"), C.get(value, "camera_optics"), C.get(value, "gimbal")],
    _ => [C.get(value, "type"), C.get(value, "telemetry"), C.get(value, "attitude"), C.get(value, "geometry")])

def report_key(+evidence: C.Json) -> String:
  +origin = C.get(evidence, "origin")
  field(evidence, "dataset_id") ++ "/" ++ field(evidence, "entity_id") ++ "/" ++
    field(origin, "kind") ++ "/" ++ origin_id(origin) ++ "/" ++ field(evidence, "report_id")

def report_sequences(xs: List<&2, C.Json>, +seen: Map<&2, String>) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case Con{section_value, +t}:
      +evidence = C.get(section_value, "evidence")
      C.choose(Bool, present(evidence),
        _ => (
          +key = report_key(evidence)
          +sequence = field(evidence, "sequence")
          +prior = map_value(String, Map.get(String, "", seen, key))
          (String.is_empty(prior) || String.eq(prior, sequence)) &&
            report_sequences(t, Map.set(&2, String, seen, key, sequence))),
        _ => report_sequences(t, seen))

def source_matches(xs: List<&2, C.Json>, +entity_id: String, +publisher: String) -> Bool:
  match xs:
    case Nil{}:
      False{}
    case Con{+h, t}:
      (String.eq(field(h, "observation_id"), entity_id) &&
        String.eq(field(h, "publisher_id"), publisher)) || source_matches(t, entity_id, publisher)

def source_publisher(xs: List<&2, C.Json>, +publisher: String) -> Bool:
  match xs:
    case Nil{}:
      False{}
    case Con{h, t}:
      String.eq(field(h, "publisher_id"), publisher) || source_publisher(t, publisher)

def evidence_matches(+evidence: C.Json, +entity: C.Json, +kind: String) -> Bool:
  +origin = C.get(evidence, "origin")
  Bool.not(present(evidence)) || (String.eq(field(evidence, "dataset_id"), field(entity, "dataset_id")) &&
    C.choose(Bool, String.eq(kind, "track"),
      _ => tagged(origin, "kind", "publisher") &&
        source_matches(C.items(C.get(entity, "sources")), field(evidence, "entity_id"), origin_id(origin)),
      _ => String.eq(field(evidence, "entity_id"), id(entity)) &&
        C.choose(Bool, String.eq(kind, "asset"), _ => tagged(origin, "kind", "asset_process"),
          _ => tagged(origin, "kind", "publisher") &&
            String.eq(field(origin, "publisher_id"), field(entity, "publisher_id")))))

def section_evidence(xs: List<&2, C.Json>, +entity: C.Json, +kind: String) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case Con{h, t}:
      evidence_matches(C.get(h, "evidence"), entity, kind) && section_evidence(t, entity, kind)

def reading_origins(xs: List<&2, C.Member>, +entity: C.Json, +kind: String) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case Con{C.Member{k, h}, t}:
      +origin = C.get(h, "origin")
      C.choose(Bool, String.eq(kind, "asset"), _ => tagged(origin, "kind", "asset_process"),
        _ => tagged(origin, "kind", "publisher") && C.choose(Bool, String.eq(kind, "track"),
          _ => source_publisher(C.items(C.get(entity, "sources")), origin_id(origin)),
          _ => String.eq(origin_id(origin), field(entity, "publisher_id")))) && reading_origins(t, entity, kind)

def track_identities(xs: List<&2, C.Json>, +track: String) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case Con{+h, t}:
      +observation = field(h, "observation_id")
      +asset = C.get(h, "source_asset_id")
      Bool.not(String.eq(observation, track)) &&
        Bool.not(C.equal(asset, C.JStr{track})) && Bool.not(C.equal(asset, C.JStr{observation})) &&
        track_identities(t, track)

def identities(+value: C.Json, kind: String) -> Bool:
  match kind:
    case "observation":
      +observation = C.get(value, "id")
      +track = C.get(value, "track_id")
      +asset = C.get(value, "source_asset_id")
      Bool.not(C.equal(observation, track)) && Bool.not(C.equal(asset, observation)) && Bool.not(C.equal(asset, track))
    case "track":
      track_identities(C.items(C.get(value, "sources")), id(value))
    case _:
      True{}

def entity(+value: C.Json, +kind: String) -> Bool:
  +sections = reported_sections(value, String.eq(kind, "asset"))
  identities(value, kind) && report_sequences(sections, Map.new(&2, String)) &&
    section_evidence(sections, value, kind) && reading_origins(constituents(C.get(value, "telemetry")), value, kind)

def counter_le(a: String, b: String) -> Bool:
  Cmp.is_le(S.decimal_order(a, b))

def task_queue(+value: C.Json) -> Bool:
  +confirmed = C.get(value, "confirmed")
  null(confirmed) || counter_le(field(confirmed, "revision"), field(value, "revision"))

def task_control(+value: C.Json) -> Bool:
  +revision = field(value, "revision")
  +requested = C.get(value, "requested")
  +confirmed = C.get(value, "confirmed")
  +confirmed_revision = field(confirmed, "revision")
  Bool.not(Bool.xor(String.eq(revision, "0"), null(requested))) &&
    (null(confirmed) || (Bool.not(String.eq(confirmed_revision, "0")) &&
      counter_le(confirmed_revision, revision) &&
      (Bool.not(String.eq(confirmed_revision, revision)) ||
        (String.eq(field(requested, "task_id"), field(confirmed, "task_id")) &&
          String.eq(field(confirmed, "queue_state"), Bool.pick(String,
            tagged(requested, "command", "pause"), "paused", "running"))))))

def task(+value: C.Json) -> Bool:
  Bool.not(tagged(value, "command", "resume")) ||
    S.duration(field(value, "accepted_at"), field(value, "expires_at"), 0, 1, 60, 0)

def execution(+value: C.Json) -> Bool:
  Bool.not(tagged(value, "queue_state", "running")) ||
    (S.ordered(field(value, "captured_at"), field(value, "applied_at"), True{}) &&
      S.ordered(field(value, "applied_at"), field(value, "instructions_valid_until"), False{}))

def terminal(+state: String) -> Bool:
  String.eq(state, "completed") || String.eq(state, "failed") || String.eq(state, "cancelled")

def assigned_context(xs: List<&2, C.Json>, +asset: String) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case Con{+h, t}:
      String.eq(field(h, "asset_id"), asset) && Bool.not(terminal(field(h, "execution_state"))) &&
        assigned_context(t, asset)

def assigned(+value: C.Json) -> Bool:
  +tasks = C.items(C.get(value, "tasks"))
  S.duration(field(value, "captured_at"), field(value, "instructions_valid_until"), 10, 0, 10, 0) &&
    assigned_context(tasks, field(value, "asset_id")) && ordered(~task_id, tasks, None{})

def replace_process(+value: C.Json) -> Bool:
  +report_value = C.get(value, "first_report")
  +generation = field(value, "process_generation")
  Bool.not(String.eq(field(value, "expected_process_generation"), generation)) &&
    String.eq(field(report_value, "entity_id"), field(value, "asset_id")) &&
    String.eq(field(C.get(report_value, "origin"), "process_generation"), generation) &&
    tagged(report_value, "mode", "current") &&
    String.eq(field(C.get(report_value, "contact_proof"), "challenge_id"), field(value, "challenge_id"))

def history_key(+value: C.Json) -> String:
  +evidence = C.get(value, "source_evidence")
  +origin = C.get(evidence, "origin")
  field(value, "source_entity_kind") ++ "/" ++ field(value, "source_entity_id") ++ "/" ++
    field(origin, "kind") ++ "/" ++ origin_id(origin) ++ "/" ++ field(value, "quantity") ++ "/" ++
    field(evidence, "reading_id")

def history_pair(+a: C.Json, +b: C.Json) -> Bool:
  +a_known = tagged(a, "time_status", "known")
  +b_known = tagged(b, "time_status", "known")
  C.choose(Bool, a_known && Bool.not(b_known), _ => True{},
    _ => C.choose(Bool, Bool.not(a_known) && b_known, _ => False{},
      _ => C.choose(Bool, a_known,
        _ => S.ordered(field(a, "observed_at"), field(b, "observed_at"), False{}) ||
          (S.ordered(field(a, "observed_at"), field(b, "observed_at"), True{}) &&
            Cmp.is_lt(String.order(history_key(a), history_key(b)))),
        _ => Cmp.is_lt(String.order(history_key(a), history_key(b))))))

def history_order(xs: List<&2, C.Json>, previous: Maybe<&2, C.Json>) -> Bool:
  match xs previous:
    case Nil{} _:
      True{}
    case Con{+h, t} None{}:
      history_order(t, Some{h})
    case Con{+h, t} Some{prior}:
      history_pair(prior, h) && history_order(t, Some{h})

def history_bounds(+value: C.Json) -> Bool:
  Bool.not(C.has(value, "source_time_from") && C.has(value, "source_time_before")) ||
    S.ordered(field(value, "source_time_from"), field(value, "source_time_before"), False{})

def put(+value: C.Json) -> Bool:
  +kind = field(value, "resource_kind")
  +image = C.get(value, "image")
  +key = C.choose(String, String.eq(kind, "task"), _ => "task_id",
    _ => Bool.pick(String, String.eq(kind, "object"), "object_id", "id"))
  String.eq(field(value, "version"), field(image, "version")) &&
    String.eq(field(value, "resource_id"), field(image, key))

def uint(value: C.Json) -> U32:
  match value:
    case C.JNum{raw}:
      Maybe.default(&2, U32, U32.read(raw), 0)
    case _:
      0

def snapshot(+value: C.Json) -> Bool:
  +items = C.items(C.get(value, "items"))
  U32.is_le(U32.from_nat(List.length(&2, C.Json, items)), uint(C.get(C.get(value, "limits"), "max_changes"))) &&
    ordered(~(x => change_key(x)), items, None{})

def message_cursor(+value: C.Json) -> String:
  +data = C.get(value, "data")
  C.choose(String, tagged(value, "type", "change_batch"),
    _ => field(data, "commit_cursor"), _ => field(data, "through_cursor"))

def replay_chain(xs: List<&2, C.Json>, +cursor: String, +seen: Set(), +through: String) -> Bool:
  match xs:
    case Nil{}:
      String.eq(cursor, through)
    case Con{+h, t}:
      +next = message_cursor(h)
      String.eq(field(C.get(h, "data"), "previous_cursor"), cursor) &&
        (String.eq(next, cursor) || Bool.not(set_found(Set.has(seen, next)))) &&
        replay_chain(t, next, Set.add(seen, next), through)

def replay_messages(xs: List<&2, C.Json>, through: String) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case Con{+h, +t}:
      +start = field(C.get(h, "data"), "previous_cursor")
      replay_chain(Con{h, t}, start, Set.add(Set.new(), start), through)

def replay(+value: C.Json) -> Bool:
  replay_messages(C.items(C.get(value, "messages")), field(value, "through_cursor")) &&
    (Bool.not(null(C.get(value, "next_page_token"))) ||
      String.eq(field(value, "through_cursor"), field(value, "replay_boundary")))

def puts_dataset(xs: List<&2, C.Json>, +dataset: String) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case Con{+h, t}:
      (Bool.not(tagged(h, "kind", "put")) ||
        String.eq(field(C.get(h, "image"), "dataset_id"), dataset)) && puts_dataset(t, dataset)

def messages_dataset(xs: List<&2, C.Json>, +dataset: String) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case Con{+h, t}:
      (Bool.not(tagged(h, "type", "change_batch")) ||
        puts_dataset(C.items(C.get(C.get(h, "data"), "changes")), dataset)) && messages_dataset(t, dataset)

def server_frame(+value: C.Json) -> Bool:
  +data = C.get(value, "data")
  +dataset = field(value, "dataset_id")
  +kind = field(value, "type")
  C.choose(Bool, String.eq(kind, "change_batch"),
    _ => puts_dataset(C.items(C.get(data, "changes")), dataset),
    _ => C.choose(Bool, String.eq(kind, "read_snapshot_result"),
      _ => puts_dataset(C.items(C.get(data, "items")), dataset),
      _ => C.choose(Bool, String.eq(kind, "read_changes_result"),
        _ => messages_dataset(C.items(C.get(data, "messages")), dataset), _ => True{})))

def geometry_kind_scope(kind: C.Json) -> C.Code:
  match kind:
    case C.JStr{+text}:
      C.choose(C.Code, String.eq(text, "Point") || String.eq(text, "LineString") || String.eq(text, "Polygon"),
        _ => C.InvalidGeometry{}, _ => C.UnsupportedGeometry{})
    case _:
      C.InvalidGeometry{}

def geometry_scope(value: C.Json) -> C.Code:
  geometry_kind_scope(C.get(value, "type"))

def section_geometry_scope(+value: C.Json) -> C.Code:
  C.choose(C.Code, tagged(value, "state", "value") && Bool.not(C.has(value, "value")),
    _ => C.InvalidGeometry{}, _ => C.InvalidValue{})

def scope(name: String, value: C.Json) -> C.Code:
  match name:
    case "Geometry":
      geometry_scope(value)
    case "Point":
      geometry_scope(value)
    case "LineString":
      geometry_scope(value)
    case "Polygon":
      geometry_scope(value)
    case "InputSection.geometry":
      section_geometry_scope(value)
    case "ReadSection.geometry":
      section_geometry_scope(value)
    case _:
      C.InvalidValue{}

def refine_named(name: String, +value: C.Json) -> Result<&2, &2, C.Failure, Unit>:
  match name:
    case "Uuid":
      C.require(S.uuid(C.string(value)), C.InvalidValue{})
    case "NewId":
      C.require(S.new_id(C.string(value)), C.InvalidValue{})
    case "Counter":
      C.require(S.counter(C.string(value), "18446744073709551615", False{}), C.InvalidValue{})
    case "Sequence":
      C.require(S.counter(C.string(value), "18446744073709551615", True{}), C.InvalidValue{})
    case "Secret":
      C.require(S.secret(C.string(value)), C.InvalidValue{})
    case "Timestamp":
      C.require(S.timestamp_valid(S.timestamp(C.string(value))), C.InvalidValue{})
    case "ContentType":
      C.require(S.content_type(C.string(value)), C.InvalidValue{})
    case "Sha256":
      C.require(S.sha256(C.string(value)), C.InvalidValue{})
    case "ObjectLength":
      C.require(S.counter(C.string(value), "2000000000", False{}), C.InvalidValue{})
    case "Attitude":
      C.require(attitude(value), C.InvalidValue{})
    case "Gimbal":
      C.require(gimbal(value), C.InvalidValue{})
    case "Power":
      C.require(unique(~id, C.items(C.get(value, "reserves")), Set.new()), C.InvalidValue{})
    case "LineString":
      G.check(value)
    case "Polygon":
      G.check(value)
    case "InputSection.status":
      C.require(section("status", value, False{}), C.InvalidValue{})
    case "InputSection.communications":
      C.require(section("communications", value, False{}), C.InvalidValue{})
    case "InputSection.telemetry":
      C.require(section("telemetry", value, False{}), C.InvalidValue{})
    case "InputSection.attitude":
      C.require(section("attitude", value, False{}), C.InvalidValue{})
    case "InputSection.power":
      C.require(section("power", value, False{}), C.InvalidValue{})
    case "InputSection.camera":
      C.require(section("camera", value, False{}), C.InvalidValue{})
    case "InputSection.camera_optics":
      C.require(section("camera_optics", value, False{}), C.InvalidValue{})
    case "InputSection.gimbal":
      C.require(section("gimbal", value, False{}), C.InvalidValue{})
    case "InputSection.type":
      C.require(section("type", value, False{}), C.InvalidValue{})
    case "InputSection.geometry":
      C.require(section("geometry", value, False{}), C.InvalidValue{})
    case "ReadSection.status":
      C.require(section("status", value, True{}), C.InvalidValue{})
    case "ReadSection.communications":
      C.require(section("communications", value, True{}), C.InvalidValue{})
    case "ReadSection.telemetry":
      C.require(section("telemetry", value, True{}), C.InvalidValue{})
    case "ReadSection.attitude":
      C.require(section("attitude", value, True{}), C.InvalidValue{})
    case "ReadSection.power":
      C.require(section("power", value, True{}), C.InvalidValue{})
    case "ReadSection.camera":
      C.require(section("camera", value, True{}), C.InvalidValue{})
    case "ReadSection.camera_optics":
      C.require(section("camera_optics", value, True{}), C.InvalidValue{})
    case "ReadSection.gimbal":
      C.require(section("gimbal", value, True{}), C.InvalidValue{})
    case "ReadSection.type":
      C.require(section("type", value, True{}), C.InvalidValue{})
    case "ReadSection.geometry":
      C.require(section("geometry", value, True{}), C.InvalidValue{})
    case "AssetReport":
      C.require(report(value, True{}), C.InvalidValue{})
    case "ObservationReport":
      C.require(report(value, False{}), C.InvalidValue{})
    case "Asset":
      C.require(entity(value, "asset"), C.InvalidValue{})
    case "Observation":
      C.require(entity(value, "observation"), C.InvalidValue{})
    case "Track":
      C.require(entity(value, "track"), C.InvalidValue{})
    case "ResultDeclarations":
      C.require(unique(~object_id, C.items(value), Set.new()), C.InvalidValue{})
    case "DeclarationBatch":
      C.require(same_flag_batch(C.items(value), Map.new(&2, C.Json)), C.InvalidValue{})
    case "TaskQueue":
      C.require(task_queue(value), C.InvalidValue{})
    case "TaskControl":
      C.require(task_control(value), C.InvalidValue{})
    case "Task":
      C.require(task(value), C.InvalidValue{})
    case "ExecutionPayload":
      C.require(execution(value), C.InvalidValue{})
    case "Activity":
      C.require(Bool.not(null(C.get(value, "operator_id")) && truth(C.get(value, "operator_deleted"))), C.InvalidValue{})
    case "HistoryReading":
      C.require(Bool.not(Bool.xor(tagged(value, "time_status", "unknown"), null(C.get(value, "observed_at")))), C.InvalidValue{})
    case "HistoryFirst":
      C.require(history_bounds(value), C.InvalidValue{})
    case "HistoryPage":
      C.require(unique(~(x => history_key(x)), C.items(C.get(value, "readings")), Set.new()) &&
        history_order(C.items(C.get(value, "readings")), None{}), C.InvalidValue{})
    case "AssignedTasks":
      C.require(assigned(value), C.InvalidValue{})
    case "BeginAssetContact":
      C.require(Bool.not(tagged(value, "mode", "replace")) ||
        Bool.not(String.eq(field(value, "process_generation"), field(value, "expected_process_generation"))), C.InvalidValue{})
    case "ContactChallenge":
      C.require(S.duration(field(value, "issued_at"), field(value, "expires_at"), 0, 1, 10, 0), C.InvalidValue{})
    case "ReplaceAssetProcess":
      C.require(replace_process(value), C.InvalidValue{})
    case "Put":
      C.require(put(value), C.InvalidValue{})
    case "Changes":
      C.require(unique(~(x => change_key(x)), C.items(value), Set.new()), C.InvalidValue{})
    case "SnapshotPage":
      C.require(snapshot(value), C.InvalidValue{})
    case "ChangeBatchData":
      C.require(Bool.not(String.eq(field(value, "previous_cursor"), field(value, "commit_cursor"))), C.InvalidValue{})
    case "LiveChangeBatchData":
      C.require(Bool.not(String.eq(field(value, "previous_cursor"), field(value, "commit_cursor"))), C.InvalidValue{})
    case "ReplayPage":
      C.require(replay(value), C.InvalidValue{})
    case "ServerFrame":
      C.require(server_frame(value), C.InvalidValue{})
    case _:
      Done{Unit{}}

def refine(name: String, value: C.Json) -> Result<&2, &2, C.Failure, Unit>:
  refine_named(name, value)
