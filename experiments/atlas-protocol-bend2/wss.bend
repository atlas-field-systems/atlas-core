import Base
import ./common.bend as C
import ./exchanges.bend as E

def expected(+context: C.Json, +key: String, actual: C.Json) -> Bool:
  Bool.not(C.has(context, key)) || C.equal(C.get(context, key), actual)

def declared_within(limits: C.Json, budget: C.Budget) -> Bool:
  match budget:
    case C.Budget{bytes, values, depth, changes, work}:
      E.limits_within(limits, C.JObj{[E.field("max_message_bytes", C.JNum{U32.show(bytes)}),
        E.field("max_json_values", C.JNum{U32.show(values)}), E.field("max_changes", C.JNum{U32.show(changes)})]})

def check(~budget: String -> C.Json -> Result<&2, &2, C.Failure, C.Budget>,
    +frame: C.Json, +context: C.Json, reading_server: Bool) -> Result<&2, &2, C.Failure, Unit>:
  +error = C.get(frame, "error")
  +details = C.get(error, "details")
  +code = C.string(C.get(error, "code"))
  +data = C.get(frame, "data")
  +is_error = C.equal(C.get(frame, "type"), C.JStr{"error"})
  do Result<&2, &2, C.Failure, Unit>:
    C.require(Bool.not(is_error && C.has(error, "details")) ||
      ((Bool.not(String.eq(code, "dataset_mismatch")) || E.same_field(details, "dataset_id", frame, "dataset_id")) &&
       (Bool.not(String.eq(code, "protocol_mismatch")) || E.same_field(details, "protocol_version", frame, "protocol_version"))), C.InvalidValue{})
    C.require((C.equal(C.get(frame, "protocol_version"), C.JStr{C.protocol_version()}) ||
      (reading_server && is_error && String.eq(code, "protocol_mismatch"))) &&
      expected(context, "datasetId", C.get(frame, "dataset_id")) &&
      expected(context, "requestId", C.get(frame, "request_id")), C.InvalidValue{})
    C.choose(Result<&2, &2, C.Failure, Unit>, C.has(data, "limits"),
      _ => do Result<&2, &2, C.Failure, Unit>:
        effective : C.Budget <- budget("wss_data", C.get(context, "budget"))
        C.require(declared_within(C.get(data, "limits"), effective), C.InvalidValue{}),
      _ => Done{Unit{}})
    C.require(Bool.not(C.has(data, "subscription_id")) ||
      expected(context, "subscriptionId", C.get(data, "subscription_id")), C.InvalidValue{})
    return Unit{}

def read_client(
    ~read: String -> String -> List<&2, U32> -> C.Json -> Result<&2, &2, C.Failure, C.Json>,
    ~budget: String -> C.Json -> Result<&2, &2, C.Failure, C.Budget>,
    bytes: List<&2, U32>, +context: C.Json) -> Result<&2, &2, C.Failure, C.Json>:
  do Result<&2, &2, C.Failure, C.Json>:
    +frame : C.Json <- read("Wss.ClientFrame", "wss_control", bytes, C.get(context, "budget"))
    check(~budget, frame, context, False{})
    return frame

def read_server(
    ~read: String -> String -> List<&2, U32> -> C.Json -> Result<&2, &2, C.Failure, C.Json>,
    ~budget: String -> C.Json -> Result<&2, &2, C.Failure, C.Budget>,
    bytes: List<&2, U32>, +context: C.Json) -> Result<&2, &2, C.Failure, C.Json>:
  do Result<&2, &2, C.Failure, C.Json>:
    +frame : C.Json <- read("Wss.ServerFrame", "wss_data", bytes, C.get(context, "budget"))
    check(~budget, frame, context, True{})
    return frame

def write_client(
    ~write: String -> String -> C.Json -> C.Json -> Result<&2, &2, C.Failure, List<&2, U32>>,
    ~budget: String -> C.Json -> Result<&2, &2, C.Failure, C.Budget>,
    +value: C.Json, +context: C.Json) -> Result<&2, &2, C.Failure, List<&2, U32>>:
  do Result<&2, &2, C.Failure, List<&2, U32>>:
    bytes : List<&2, U32> <- write("Wss.ClientFrame", "wss_control", value, C.get(context, "budget"))
    check(~budget, value, context, False{})
    return bytes

def write_server(
    ~write: String -> String -> C.Json -> C.Json -> Result<&2, &2, C.Failure, List<&2, U32>>,
    ~budget: String -> C.Json -> Result<&2, &2, C.Failure, C.Budget>,
    +value: C.Json, +context: C.Json) -> Result<&2, &2, C.Failure, List<&2, U32>>:
  do Result<&2, &2, C.Failure, List<&2, U32>>:
    bytes : List<&2, U32> <- write("Wss.ServerFrame", "wss_data", value, C.get(context, "budget"))
    check(~budget, value, context, False{})
    return bytes
