import Base
import ./common.bend as C
import ./shapes.bend as S

def uint64_twenty_digits() -> String:
  "1[0-7][0-9]{18}|18[0-3][0-9]{17}|184[0-3][0-9]{16}|1844[0-5][0-9]{15}|18446[0-6][0-9]{14}|184467[0-3][0-9]{13}|1844674[0-3][0-9]{12}|184467440[0-6][0-9]{10}|1844674407[0-2][0-9]{9}|18446744073[0-6][0-9]{8}|1844674407370[0-8][0-9]{6}|18446744073709[0-4][0-9]{5}|184467440737095[0-4][0-9]{4}|18446744073709550[0-9]{3}|18446744073709551[0-5][0-9]{2}|1844674407370955160[0-9]|1844674407370955161[0-5]"

def scalar_definitions() -> List<&2, C.Member>:
  [
    S.named("Uuid", S.pattern(36, "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\\s\\S])")),
    S.named("NewId", S.pattern(36, "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\\s\\S])")),
    S.named("Opaque", S.add(S.text(4194304), [C.Member{"minLength", C.JNum{"1"}}])),
    S.named("Alias", S.nonblank(128)),
    S.named("Counter", S.pattern(20, "^(?:0|[1-9][0-9]{0,18}|" ++ uint64_twenty_digits() ++ ")$(?![\\s\\S])")),
    S.named("Sequence", S.pattern(20, "^(?:[1-9][0-9]{0,18}|" ++ uint64_twenty_digits() ++ ")$(?![\\s\\S])")),
    S.named("Secret", S.add(S.pattern(43, "^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$(?![\\s\\S])"), [C.Member{"minLength", C.JNum{"43"}}])),
    S.named("Timestamp", S.pattern(30, "^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\\.([0-9]{1,9}))?Z$(?![\\s\\S])")),
    S.named("Float", S.number([
      C.Member{"minimum", C.JNum{"-179769313486231570814527423731704356798070567525844996598917476803157260780028538760589558632766878171540458953514382464234321326889464182768467546703537516986049910576551282076245490090389328944075868508455133942304583236903222948165808559332123348274797826204144723168738177180919299881250404026184124858368"}},
      C.Member{"maximum", C.JNum{"179769313486231570814527423731704356798070567525844996598917476803157260780028538760589558632766878171540458953514382464234321326889464182768467546703537516986049910576551282076245490090389328944075868508455133942304583236903222948165808559332123348274797826204144723168738177180919299881250404026184124858368"}}])),
    S.named("Integer", S.integer(0, 2147483647)),
    S.named("PageSize", S.integer(1, 1000)),
    S.named("Latitude", S.number([C.Member{"minimum", C.JNum{"-90"}}, C.Member{"maximum", C.JNum{"90"}}])),
    S.named("Longitude", S.number([C.Member{"minimum", C.JNum{"-180"}}, C.Member{"maximum", C.JNum{"180"}}])),
    S.named("Time", S.nullable(S.ref("Timestamp"))),
    S.named("Position", S.closed([C.Member{"latitude", S.ref("Latitude")},
      C.Member{"longitude", S.ref("Longitude")}], [])),
    S.named("Altitude", S.closed([C.Member{"metres", S.ref("Float")},
      C.Member{"reference", S.tag("wgs84_ellipsoid")}], [])),
    S.named("Nonnegative", S.number([C.Member{"minimum", C.JNum{"0"}}])),
    S.named("Positive", S.number([C.Member{"exclusiveMinimum", C.JNum{"0"}}])),
    S.named("Heading", S.number([C.Member{"minimum", C.JNum{"0"}}, C.Member{"exclusiveMaximum", C.JNum{"360"}}])),
    S.named("Roll", S.number([C.Member{"minimum", C.JNum{"-180"}}, C.Member{"exclusiveMaximum", C.JNum{"180"}}])),
    S.named("FieldOfView", S.number([C.Member{"exclusiveMinimum", C.JNum{"0"}},
      C.Member{"exclusiveMaximum", C.JNum{"180"}}])),
    S.named("ZoomRatio", S.number([C.Member{"minimum", C.JNum{"1"}}])),
    S.named("Percent", S.number([C.Member{"minimum", C.JNum{"0"}}, C.Member{"maximum", C.JNum{"100"}}]))]

def component_definitions() -> List<&2, C.Member>:
  [
    S.named("Description", S.closed([C.Member{"name", S.nonblank(128)}], [C.Member{"description", S.text(4096)}])),
    S.named("AssetDescription", S.closed([C.Member{"name", S.nonblank(128)}], [C.Member{"description", S.text(4096)},
      C.Member{"manufacturer", S.nonblank(128)},
      C.Member{"model", S.nonblank(128)}])),
    S.named("AssetType", S.one_of([
      S.closed([C.Member{"kind", S.tag("drone")},
        C.Member{"variant", S.nullable(S.enum(["powered_fixed_wing", "fixed_wing_glider", "quadcopter"]))}], []),
      S.closed([C.Member{"kind", S.nullable(S.enum(["security_camera", "tracker", "other"]))}], [])])),
    S.named("SubjectKind", S.enum(["person", "ground_vehicle", "aircraft", "animal", "other"])),
    S.named("SubjectType", S.closed([C.Member{"kind", S.nullable(S.ref("SubjectKind"))}], [])),
    S.named("GeofeatureKind", S.enum(["point_of_interest", "route", "search_area", "boundary", "other"])),
    S.named("GeofeatureType", S.closed([C.Member{"kind", S.nullable(S.ref("GeofeatureKind"))}], [])),
    S.named("Status", S.closed([C.Member{"condition", S.enum(["unknown", "healthy", "degraded", "faulted"])}], [C.Member{"explanation", S.nonblank(512)}])),
    S.named("Telemetry", S.closed([
      C.Member{"position", S.nullable(S.ref("Position"))}, C.Member{"altitude", S.nullable(S.ref("Altitude"))},
      C.Member{"ground_speed", S.nullable(S.ref("Nonnegative"))}], [C.Member{"airspeed", S.nullable(S.ref("Nonnegative"))}])),
    S.named("Attitude", S.closed([
      C.Member{"heading", S.nullable(S.ref("Heading"))},
        C.Member{"pitch", S.nullable(S.ref("Latitude"))},
        C.Member{"roll", S.nullable(S.ref("Roll"))}], [])),
    S.named("Gimbal", S.closed([C.Member{"bearing", S.nullable(S.ref("Heading"))},
      C.Member{"elevation", S.nullable(S.ref("Latitude"))}], [])),
    S.named("Camera", S.closed([C.Member{"zoom_ratio", S.nullable(S.ref("ZoomRatio"))}], [C.Member{"recording", S.nullable(S.typed("boolean"))},
      C.Member{"capturing", S.nullable(S.typed("boolean"))}])),
    S.named("CameraOptics", S.closed([C.Member{"horizontal_fov", S.nullable(S.ref("FieldOfView"))},
      C.Member{"vertical_fov", S.nullable(S.ref("FieldOfView"))}], [])),
    S.named("Capacity", S.closed([C.Member{"bandwidth_bps", S.nullable(S.ref("Positive"))}], [])),
    S.named("Health", S.enum(["healthy", "degraded", "offline"])),
    S.named("Heartbeat", S.closed([C.Member{"last_contact_at", S.ref("Time")}], [])),
    S.named("Reserve", S.one_of([
      S.closed([C.Member{"id", S.ref("Uuid")},
        C.Member{"kind", S.tag("battery")},
        C.Member{"remaining_percent", S.nullable(S.ref("Percent"))},
        C.Member{"voltage_volts", S.nullable(S.ref("Nonnegative"))},
        C.Member{"current_amperes", S.nullable(S.ref("Float"))}], []),
      S.closed([C.Member{"id", S.ref("Uuid")},
        C.Member{"kind", S.tag("fuel")},
        C.Member{"remaining_percent", S.nullable(S.ref("Percent"))}], [])])),
    S.named("Power", S.closed([C.Member{"external_power", S.nullable(S.typed("boolean"))},
      C.Member{"reserves", S.array(S.ref("Reserve"), 0, 16, False{})}], [])),
    S.named("ReserveTimes", S.closed([], [C.Member{"remaining_percent", S.ref("Time")},
      C.Member{"voltage_volts", S.ref("Time")},
      C.Member{"current_amperes", S.ref("Time")}])),
    S.named("PowerTimes", S.closed([], [C.Member{"external_power", S.ref("Time")},
      C.Member{"reserves", S.dictionary(S.ref("Uuid"), S.ref("ReserveTimes"), 16)}])),
    S.named("CoordinatePair", S.tuple([S.ref("Longitude"), S.ref("Latitude")])),
    S.named("Point", S.closed([C.Member{"type", S.tag("Point")},
      C.Member{"coordinates", S.ref("CoordinatePair")}], [])),
    S.named("LineString", S.closed([C.Member{"type", S.tag("LineString")},
      C.Member{"coordinates", S.array(S.ref("CoordinatePair"), 2, 1024, False{})}], [])),
    S.named("Polygon", S.closed([C.Member{"type", S.tag("Polygon")},
      C.Member{"coordinates", S.tuple([S.array(S.ref("CoordinatePair"), 4, 1024, False{})])}], [])),
    S.named("Geometry", S.one_of([S.ref("Point"), S.ref("LineString"), S.ref("Polygon")]))]

def move_fields() -> List<&2, C.Member>:
  [C.Member{"command", S.tag("move_to")},
    C.Member{"scheduling", S.tag("queued")},
    C.Member{"inputs", S.ref("MoveToInputs")}]

def pause_fields() -> List<&2, C.Member>:
  [C.Member{"command", S.tag("pause")},
    C.Member{"scheduling", S.tag("immediate")},
    C.Member{"inputs", S.closed([], [])}]

def resume_fields() -> List<&2, C.Member>:
  [C.Member{"command", S.tag("resume")},
    C.Member{"scheduling", S.tag("immediate")},
    C.Member{"inputs", S.closed([], [])},
    C.Member{"expires_at", S.ref("Timestamp")}]

def creation_fields() -> List<&2, C.Member>:
  [C.Member{"request_id", S.ref("NewId")}, C.Member{"task_id", S.ref("NewId")}, C.Member{"asset_id", S.ref("Uuid")}]

def support(command: String, scheduling: String) -> C.Json:
  S.closed([C.Member{"command", S.tag(command)}, C.Member{"scheduling", S.array(S.tag(scheduling), 1, 1, True{})}], [])

def command_definitions() -> List<&2, C.Member>:
  [
    S.named("MoveToInputs", S.closed([C.Member{"target", S.one_of([
      S.closed([C.Member{"kind", S.tag("position")}, C.Member{"position", S.ref("Position")}], []),
      S.closed([C.Member{"kind", S.tag("geofeature")},
        C.Member{"geofeature_id", S.ref("Uuid")}], [])])}], [C.Member{"altitude", S.ref("Altitude")}])),
    S.named("Command.move_to", S.closed(move_fields(), [])),
    S.named("Command.pause", S.closed(pause_fields(), [])),
    S.named("Command.resume", S.closed(resume_fields(), [])),
    S.named("Command", S.one_of([S.ref("Command.move_to"), S.ref("Command.pause"), S.ref("Command.resume")])),
    S.named("CreateTask", S.one_of([
      S.closed(S.members(move_fields(), creation_fields()), []),
      S.closed(S.members(pause_fields(), creation_fields()), []),
      S.closed(S.members(resume_fields(), creation_fields()), [])])),
    S.named("Capabilities", S.closed([C.Member{"commands", S.array(S.one_of([support("move_to", "queued"), support("pause", "immediate"), support("resume", "immediate")]), 0, 3, True{})}], []))]

def definitions() -> List<&2, C.Member>:
  S.members(scalar_definitions(), S.members(component_definitions(), command_definitions()))
