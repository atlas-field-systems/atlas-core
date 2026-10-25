import Base
import ./common.bend as C
import ./runtime.bend as R
import ./budget.bend as B
import ./rules.bend as Rules
import ./geometry.bend as Geometry
import ./casefold.bend as Casefold
import ./schemas.bend as Schemas
import ./shapes.bend as Shapes
import ./exchanges.bend as E
import ./http.bend as H
import ./wss.bend as W
import ./reference.bend as Reference

def protocol_version() -> String:
  C.protocol_version()

def definitions(unit: Unit) -> List<&2, C.Member>:
  E.definitions()

def refine(name: String, value: C.Json) -> Result<&2, &2, C.Failure, Unit>:
  +n = name
  +v = value
  do Result<&2, &2, C.Failure, Unit>:
    Rules.refine(n, v)
    E.refine(n, v)

def read_json(name: String, boundary: String, bytes: List<&2, U32>, lower: C.Json) -> Result<&2, &2, C.Failure, C.Json>:
  R.read_json(~definitions, ~refine, ~Rules.scope, ~Geometry.reserve, name, boundary, bytes, lower)

def validate_value(name: String, boundary: String, value: C.Json, lower: C.Json) -> Result<&2, &2, C.Failure, C.Json>:
  R.validate_value(~definitions, ~refine, ~Rules.scope, ~Geometry.reserve, name, boundary, value, lower)

def write_json(name: String, boundary: String, value: C.Json, lower: C.Json) -> Result<&2, &2, C.Failure, List<&2, U32>>:
  R.write_json(~definitions, ~refine, ~Rules.scope, ~Geometry.reserve, name, boundary, value, lower)

def effective_budget(boundary: String, lower: C.Json) -> Result<&2, &2, C.Failure, C.Budget>:
  B.effective(boundary, lower)

def effective_budget_json(boundary: String, lower: C.Json) -> Result<&2, &2, C.Failure, C.Json>:
  do Result<&2, &2, C.Failure, C.Json>:
    budget : C.Budget <- B.effective(boundary, lower)
    return B.as_json(budget)

def check_json(bytes: List<&2, U32>, boundary: String, lower: C.Json) -> Result<&2, &2, C.Failure, Unit>:
  R.check_json(bytes, boundary, lower)

def read_http_request(operation: String, incoming: C.Json, lower: C.Json) -> Result<&2, &2, C.Failure, C.Json>:
  H.read_request(~read_json, ~validate_value, ~effective_budget, operation, incoming, lower)

def read_http(operation: String, received: C.Json, context: C.Json) -> Result<&2, &2, C.Failure, C.Json>:
  H.read_response(~read_json, ~validate_value, ~effective_budget, ~Casefold.fold, operation, received, context)

def read_wss_client(bytes: List<&2, U32>, context: C.Json) -> Result<&2, &2, C.Failure, C.Json>:
  W.read_client(~read_json, ~effective_budget, bytes, context)

def read_wss_server(bytes: List<&2, U32>, context: C.Json) -> Result<&2, &2, C.Failure, C.Json>:
  W.read_server(~read_json, ~effective_budget, bytes, context)

def write_wss_client(value: C.Json, context: C.Json) -> Result<&2, &2, C.Failure, List<&2, U32>>:
  W.write_client(~write_json, ~effective_budget, value, context)

def write_wss_server(value: C.Json, context: C.Json) -> Result<&2, &2, C.Failure, List<&2, U32>>:
  W.write_server(~write_json, ~effective_budget, value, context)

def correlation(headers: C.Json) -> C.Json:
  H.correlation(headers)

def failure_code(failure: C.Failure) -> String:
  match failure:
    case C.Failure{code, issues}:
      C.code_name(code)

def schema_names() -> C.Json:
  C.JArr{Shapes.strings(Schemas.public_names())}

def section_names() -> C.Json:
  C.JArr{Shapes.strings(Schemas.section_names())}

def exchange_catalog() -> C.Json:
  E.catalog()

def budget_catalog() -> C.Json:
  B.catalog()

def command_catalog() -> C.Json:
  C.JObj{[C.Member{"move_to", Schemas.schema("Command.move_to")},
    C.Member{"pause", Schemas.schema("Command.pause")}, C.Member{"resume", Schemas.schema("Command.resume")}]}

def reference_document() -> C.Json:
  Reference.document()
