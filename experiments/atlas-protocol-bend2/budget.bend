import Base
import ./common.bend as C
import ./numbers.bend as N

def parsed_uint(result: Maybe<&2, U32>) -> U32:
  match result:
    case Some{value}:
      value
    case None{}:
      0

def lower_value(value: C.Json, +cap: U32) -> Result<&2, &2, C.Failure, U32>:
  match value:
    case C.JMissing{}:
      Done{cap}
    case C.JNum{+raw}:
      do Result<&2, &2, C.Failure, U32>:
        C.require(N.accept(raw, "0", "9007199254740991", True{}, False{}, False{}), C.InvalidBudget{})
        return C.choose(U32, N.accept(raw, "0", U32.show(cap), True{}, False{}, False{}),
          _ => parsed_uint(U32.read(N.format(raw))), _ => cap)
    case _:
      Fail{C.failure(C.InvalidBudget{})}

def lower(base: C.Budget, +value: C.Json) -> Result<&2, &2, C.Failure, C.Budget>:
  match base:
    case C.Budget{bytes, values, depth, changes, work}:
      do Result<&2, &2, C.Failure, C.Budget>:
        b : U32 <- lower_value(C.get(value, "maxBytes"), bytes)
        v : U32 <- lower_value(C.get(value, "maxValues"), values)
        d : U32 <- lower_value(C.get(value, "maxDepth"), depth)
        c : U32 <- lower_value(C.get(value, "maxChanges"), changes)
        w : U32 <- lower_value(C.get(value, "maxGeometryWork"), work)
        return C.Budget{b, v, d, c, w}

def effective(+boundary: String, value: C.Json) -> Result<&2, &2, C.Failure, C.Budget>:
  do Result<&2, &2, C.Failure, C.Budget>:
    C.require(String.eq(boundary, "http_request") || String.eq(boundary, "http_response") ||
      String.eq(boundary, "wss_control") || String.eq(boundary, "wss_data"), C.InvalidValue{})
    lower(C.default_budget(boundary), value)

def uint(value: C.Json) -> U32:
  match value:
    case C.JNum{raw}:
      parsed_uint(U32.read(N.format(raw)))
    case _:
      0

def limit_number(value: C.Json, cap: String) -> Bool:
  match value:
    case C.JNum{raw}:
      N.accept(raw, "0", cap, True{}, False{}, False{})
    case _:
      False{}

def valid_limits(+limits: C.Json) -> Bool:
  limit_number(C.get(limits, "max_message_bytes"), "4194304") &&
    limit_number(C.get(limits, "max_json_values"), "262144") &&
    limit_number(C.get(limits, "max_changes"), "1000")

def message(base: C.Budget, +limits: C.Json) -> C.Budget:
  match base:
    case C.Budget{bytes, values, depth, changes, work}:
      C.Budget{U32.min(bytes, uint(C.get(limits, "max_message_bytes"))),
        U32.min(values, uint(C.get(limits, "max_json_values"))), depth,
        U32.min(changes, uint(C.get(limits, "max_changes"))), work}

def as_json(budget: C.Budget) -> C.Json:
  match budget:
    case C.Budget{b, v, d, c, w}:
      C.JObj{[
        C.Member{"maxBytes", C.JNum{U32.show(b)}},
        C.Member{"maxValues", C.JNum{U32.show(v)}},
        C.Member{"maxDepth", C.JNum{U32.show(d)}},
        C.Member{"maxChanges", C.JNum{U32.show(c)}},
        C.Member{"maxGeometryWork", C.JNum{U32.show(w)}}]}

def catalog() -> C.Json:
  C.JObj{[
    C.Member{"http_request", as_json(C.default_budget("http_request"))},
    C.Member{"http_response", as_json(C.default_budget("http_response"))},
    C.Member{"wss_control", as_json(C.default_budget("wss_control"))},
    C.Member{"wss_data", as_json(C.default_budget("wss_data"))}]}
