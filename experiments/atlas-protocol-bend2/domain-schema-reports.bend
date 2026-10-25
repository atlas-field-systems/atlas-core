import Base
import ./common.bend as C
import ./shapes.bend as S

def section_names() -> List<&2, String>:
  ["status", "communications", "telemetry", "attitude", "power", "camera", "camera_optics", "gimbal", "type", "geometry"]

def evidence_fields() -> List<&2, C.Member>:
  [C.Member{"dataset_id", S.ref("Uuid")},
    C.Member{"entity_id", S.ref("Uuid")},
    C.Member{"origin", S.ref("Origin")},
    C.Member{"report_id", S.ref("NewId")},
    C.Member{"sequence", S.ref("Sequence")}]

def evidence_sections(names: List<&2, String>) -> List<&2, C.Member>:
  match names:
    case Nil{}:
      Nil{}
    case Con{+name, rest}:
      S.named("SectionEvidence." ++ name, S.closed(S.members(evidence_fields(), [C.Member{"section", S.tag(name)}]), [])) <> evidence_sections(rest)

def metadata() -> List<&2, C.Member>:
  [C.Member{"classification", S.enum(["state_until_changed", "dated_measurement"])},
    C.Member{"observed_at", S.ref("Time")}]

def times_fields(names: List<&2, String>) -> List<&2, C.Member>:
  match names:
    case Nil{}:
      Nil{}
    case Con{name, rest}:
      C.Member{name, S.ref("Time")} <> times_fields(rest)

def source_times(names: List<&2, String>) -> C.Json:
  S.closed([], times_fields(names))

def result(value: String, times: String, +evidence: List<&2, C.Member>, value_evidence: List<&2, C.Member>, telemetry: Bool) -> C.Json:
  constituents = Bool.pick(List<&2, C.Member>, telemetry, [C.Member{"constituents", S.ref("Constituents")}], [])
  S.one_of([
    S.closed(S.members(metadata(), S.members([C.Member{"state", S.tag("value")},
      C.Member{"value", S.ref(value)}], S.members(value_evidence, constituents))), [C.Member{"source_times", S.ref(times)}]),
    S.closed(S.members(metadata(), S.members([C.Member{"state", S.tag("error")},
      C.Member{"error", S.ref("SectionError")}], evidence)), []),
    S.closed(S.members(metadata(), S.members([C.Member{"state", S.tag("withdrawn")}], evidence)), [])])

def input(section: String, value: String, times: String, telemetry: Bool) -> C.Member:
  S.named("InputSection." ++ section, result(value, times, [], [], telemetry))

def read(+section: String, value: String, times: String, +telemetry: Bool) -> C.Member:
  +evidence = S.ref("SectionEvidence." ++ section)
  value_evidence = Bool.pick(C.Json, telemetry, evidence, S.nullable(evidence))
  S.named("ReadSection." ++ section, result(value, times, [C.Member{"evidence", evidence}], [C.Member{"evidence", value_evidence}], telemetry))

def sections(+prefix: String, names: List<&2, String>) -> List<&2, C.Member>:
  match names:
    case Nil{}:
      Nil{}
    case Con{+name, rest}:
      C.Member{name, S.ref(prefix ++ name)} <> sections(prefix, rest)

def asset_sections() -> C.Json:
  S.closed([], sections("InputSection.", ["status", "communications", "telemetry", "attitude", "power", "camera", "camera_optics", "gimbal"]))

def report_fields() -> List<&2, C.Member>:
  [C.Member{"dataset_id", S.ref("Uuid")},
    C.Member{"entity_id", S.ref("Uuid")},
    C.Member{"report_id", S.ref("NewId")},
    C.Member{"sequence", S.ref("Sequence")},
    C.Member{"generated_at", S.ref("Time")}]

def definitions() -> List<&2, C.Member>:
  S.members([
    S.named("AssetOrigin", S.closed([C.Member{"kind", S.tag("asset_process")},
      C.Member{"process_generation", S.ref("Uuid")}], [])),
    S.named("PublisherOrigin", S.closed([C.Member{"kind", S.tag("publisher")},
      C.Member{"publisher_id", S.ref("Uuid")}], [])),
    S.named("Origin", S.one_of([S.ref("AssetOrigin"), S.ref("PublisherOrigin")])),
    S.named("Constituent", S.closed([C.Member{"origin", S.ref("Origin")}, C.Member{"reading_id", S.ref("NewId")}], [])),
    S.named("Constituents", S.closed([C.Member{"position", S.ref("Constituent")},
      C.Member{"altitude", S.ref("Constituent")},
      C.Member{"ground_speed", S.ref("Constituent")}], [C.Member{"airspeed", S.ref("Constituent")}])),
    S.named("SectionName", S.enum(section_names())),
    S.named("SectionEvidence", S.closed(S.members(evidence_fields(), [C.Member{"section", S.ref("SectionName")}]), [])),
    S.named("SectionError", S.closed([C.Member{"code", S.nonblank(128)}], [C.Member{"message", S.text(512)}])),
    S.named("SourceTimes.status", source_times(["condition"])),
    S.named("SourceTimes.communications", source_times(["bandwidth_bps"])),
    S.named("SourceTimes.telemetry", source_times(["position", "altitude", "ground_speed", "airspeed"])),
    S.named("SourceTimes.attitude", source_times(["heading", "pitch", "roll"])),
    S.named("SourceTimes.gimbal", source_times(["bearing", "elevation"])),
    S.named("SourceTimes.camera", source_times(["zoom_ratio", "recording", "capturing"])),
    S.named("SourceTimes.camera_optics", source_times(["horizontal_fov", "vertical_fov"])),
    S.named("SourceTimes.type", source_times(["kind"])),
    S.named("SourceTimes.geometry", source_times(["geometry"])),
    input("status", "Status", "SourceTimes.status", False{}),
    input("communications", "Capacity", "SourceTimes.communications", False{}),
    input("telemetry", "Telemetry", "SourceTimes.telemetry", True{}),
    input("attitude", "Attitude", "SourceTimes.attitude", False{}),
    input("power", "Power", "PowerTimes", False{}),
    input("camera", "Camera", "SourceTimes.camera", False{}),
    input("camera_optics", "CameraOptics", "SourceTimes.camera_optics", False{}),
    input("gimbal", "Gimbal", "SourceTimes.gimbal", False{}),
    input("type", "SubjectType", "SourceTimes.type", False{}),
    input("geometry", "Geometry", "SourceTimes.geometry", False{}),
    read("status", "Status", "SourceTimes.status", False{}),
    read("communications", "Capacity", "SourceTimes.communications", False{}),
    read("telemetry", "Telemetry", "SourceTimes.telemetry", True{}),
    read("attitude", "Attitude", "SourceTimes.attitude", False{}),
    read("power", "Power", "PowerTimes", False{}),
    read("camera", "Camera", "SourceTimes.camera", False{}),
    read("camera_optics", "CameraOptics", "SourceTimes.camera_optics", False{}),
    read("gimbal", "Gimbal", "SourceTimes.gimbal", False{}),
    read("type", "SubjectType", "SourceTimes.type", False{}),
    read("geometry", "Geometry", "SourceTimes.geometry", False{}),
    S.named("EvidenceDisposition", S.enum(["accepted", "duplicate"])),
    S.named("AssetReport", S.one_of([
      S.closed(S.members(report_fields(), [C.Member{"origin", S.ref("AssetOrigin")},
        C.Member{"mode", S.tag("current")},
        C.Member{"sections", asset_sections()}]), [C.Member{"contact_proof", S.closed([C.Member{"challenge_id", S.ref("Uuid")}], [])}]),
      S.closed(S.members(report_fields(), [C.Member{"origin", S.ref("AssetOrigin")},
        C.Member{"mode", S.tag("history_only")},
        C.Member{"sections", S.nonempty(asset_sections())}]), [])])),
    S.named("ObservationReport", S.closed(S.members(report_fields(), [C.Member{"origin", S.ref("PublisherOrigin")},
      C.Member{"mode", S.enum(["current", "history_only"])},
      C.Member{"sections", S.nonempty(S.closed([], sections("InputSection.", ["type", "telemetry", "attitude", "geometry"])))}]), []))], evidence_sections(section_names()))
