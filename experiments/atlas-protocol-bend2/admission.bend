import Base
import ./common.bend as C
import ./json.bend as J
import ./budget.bend as B

type Facts is Data:
  Facts{root_type: String, limits: C.Json, values_left: U32}

type Prepared is Data:
  Prepared{value: C.Json, budget: C.Budget}

def at_path(frames: List<&2, J.Frame>, path: List<&2, String>) -> Bool:
  match frames path:
    case Nil{} Nil{}:
      True{}
    case Con{J.ObjectFrame{members, keys, key}, t} Con{h, rest}:
      String.eq(key, h) && at_path(t, rest)
    case _ _:
      False{}

def root_type_path(parser: J.Parser) -> Bool:
  match parser:
    case J.Parser{J.Value{}, frames, root, values, depth, build}:
      at_path(frames, ["type"])
    case _:
      False{}

def remember_limit(+key: String, value: C.Json, facts: Facts) -> Facts:
  match facts:
    case Facts{frame_type, limits, left}:
      Facts{frame_type, C.JObj{Con{C.Member{key, value}, C.remove_member(C.members(limits), key)}}, left}

def remember(token: J.Token, parser: J.Parser, facts: Facts) -> Facts:
  match token parser facts:
    case J.TString{s} J.Parser{J.Value{}, frames, root, +values, depth, build} Facts{+frame_type, +limits, left}:
      C.choose(Facts, at_path(frames, ["type"]),
        _ => Facts{s, limits, values}, _ => Facts{frame_type, limits, values})
    case J.TNumber{+s} J.Parser{J.Value{}, +frames, root, values, depth, build} Facts{frame_type, limits, left}:
      +current = {Facts{frame_type, limits, values} : Facts}
      C.choose(Facts, at_path(frames, ["max_message_bytes", "limits", "data"]),
        _ => remember_limit("max_message_bytes", C.JNum{s}, current),
        _ => C.choose(Facts, at_path(frames, ["max_json_values", "limits", "data"]),
          _ => remember_limit("max_json_values", C.JNum{s}, current),
          _ => C.choose(Facts, at_path(frames, ["max_changes", "limits", "data"]),
            _ => remember_limit("max_changes", C.JNum{s}, current), _ => current)))
    case _ J.Parser{e, frames, root, values, depth, build} Facts{frame_type, limits, left}:
      Facts{frame_type, limits, values}

type Scanned is Data:
  Scanned{step: J.ParseStep, facts: Facts}

def scan_token(token: J.ScannedToken, +parser: J.Parser, facts: Facts) -> Result<&2, &2, C.Failure, Scanned>:
  match token:
    case J.ScannedToken{+kind, rest}:
      do Result<&2, &2, C.Failure, Scanned>:
        next : J.ParseStep <- J.next_step(J.ScannedToken{kind, rest}, parser)
        return Scanned{next, remember(kind, parser, facts)}

def scan(fuel: Nat, state: Scanned) -> Result<&2, &2, C.Failure, Facts>:
  match fuel state:
    case _ Scanned{J.Parsed{value}, facts}:
      Done{facts}
    case 0n _:
      Fail{C.failure(C.ResourceLimit{})}
    case 1n+p Scanned{J.Parsing{bytes, parser}, facts}:
      do Result<&2, &2, C.Failure, Facts>:
        +trimmed : List<&2, U32> = J.whitespace(bytes)
        +ready : J.Parser <- J.reserve(parser, trimmed)
        token : J.ScannedToken <- J.lex(trimmed, J.token_keep(ready) || root_type_path(ready))
        next : Scanned <- scan_token(token, ready, facts)
        scan(p, next)

def control(+frame_type: String) -> Bool:
  String.eq(frame_type, "authenticated") || String.eq(frame_type, "snapshot_released") ||
    String.eq(frame_type, "subscribed") || String.eq(frame_type, "unsubscribed") ||
    String.eq(frame_type, "handoff_complete") || String.eq(frame_type, "gap") || String.eq(frame_type, "error")

def applies(+name: String) -> Bool:
  String.eq(name, "Wss.ServerFrame") || String.eq(name, "Success.ReadSnapshot")

def selected_budget(+name: String, facts: Facts, +base: C.Budget, lower: C.Json) -> Result<&2, &2, C.Failure, C.Budget>:
  match facts:
    case Facts{+frame_type, +limits, left}:
      do Result<&2, &2, C.Failure, C.Budget>:
        +initial : C.Budget <- C.choose(Result<&2, &2, C.Failure, C.Budget>,
          String.eq(name, "Wss.ServerFrame") && control(frame_type),
          _ => B.effective("wss_control", lower), _ => Done{base})
        return C.choose(C.Budget,
          (String.eq(name, "Success.ReadSnapshot") ||
            (String.eq(name, "Wss.ServerFrame") && String.eq(frame_type, "read_snapshot_result"))) && B.valid_limits(limits),
          _ => B.message(initial, limits), _ => initial)

def enforce(count: U32, used: U32, budget: C.Budget) -> Result<&2, &2, C.Failure, Unit>:
  match budget:
    case C.Budget{bytes, values, depth, changes, work}:
      do Result<&2, &2, C.Failure, Unit>:
        C.require(U32.is_le(count, bytes), C.PayloadTooLarge{})
        C.require(U32.is_le(used, values), C.ResourceLimit{})

def finish_scan(+name: String, +bytes: List<&2, U32>, +base: C.Budget, lower: C.Json,
    +count: U32, +facts: Facts) -> Result<&2, &2, C.Failure, Prepared>:
  match base facts:
    case C.Budget{b, +values, d, c, w} Facts{frame_type, limits, left}:
      do Result<&2, &2, C.Failure, Prepared>:
        +budget : C.Budget <- selected_budget(name, Facts{frame_type, limits, left}, C.Budget{b, values, d, c, w}, lower)
        enforce(count, (values - left : U32), budget)
        value : C.Json <- J.parse_pass(bytes, count, budget, True{})
        return Prepared{value, budget}

def prepare(+name: String, +bytes: List<&2, U32>, +base: C.Budget, lower: C.Json) -> Result<&2, &2, C.Failure, Prepared>:
  match base:
    case C.Budget{+b, +v, +d, +c, +w}:
      C.choose(Result<&2, &2, C.Failure, Prepared>, applies(name),
        _ => do Result<&2, &2, C.Failure, Prepared>:
          +count : U32 <- J.bytes_count(bytes, b, 0)
          J.utf_check(bytes, J.Utf{0n, 0, 128, 191})
          facts : Facts <- scan(2n+U32.to_nat(count),
            Scanned{J.Parsing{bytes, J.Parser{J.Value{}, Nil{}, C.JMissing{}, v, d, False{}}},
              Facts{"", C.JObj{Nil{}}, v}})
          finish_scan(name, bytes, C.Budget{b, v, d, c, w}, lower, count, facts),
        _ => do Result<&2, &2, C.Failure, Prepared>:
          value : C.Json <- J.parse(bytes, C.Budget{b, v, d, c, w})
          return Prepared{value, C.Budget{b, v, d, c, w}})

def writer_budget(name: String, +value: C.Json, base: C.Budget, lower: C.Json) -> Result<&2, &2, C.Failure, C.Budget>:
  selected_budget(name, Facts{C.string(C.get(value, "type")), C.get(C.get(value, "data"), "limits"), 0}, base, lower)
