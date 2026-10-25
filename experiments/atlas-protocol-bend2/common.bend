import Base

def protocol_version() -> String:
  "0.1.0"

type Json is Data:
  JMissing{}
  JNull{}
  JBool{value: Bool}
  JNum{raw: String}
  JStr{value: String}
  JArr{items: List<&2, Json>}
  JObj{members: List<&2, Member>}

type Member is Data:
  Member{key: String, value: Json}

type Code is Data:
  InvalidJson{}
  InvalidUtf8{}
  InvalidValue{}
  PayloadTooLarge{}
  ResourceLimit{}
  InvalidGeometry{}
  UnsupportedGeometry{}
  GeometryLimitExceeded{}
  InvalidHttp{}
  InvalidBudget{}

type Issue is Data:
  Issue{path: String, message: String}

type Failure is Data:
  Failure{code: Code, issues: List<&2, Issue>}

type Budget is Data:
  Budget{max_bytes: U32, max_values: U32, max_depth: U32, max_changes: U32, max_geometry_work: U32}

def choose(-A: Type, c: Bool, yes: Unit -> A, no: Unit -> A) -> A:
  match c:
    case True{}:
      yes(Unit{})
    case False{}:
      no(Unit{})

def require(ok: Bool, code: Code) -> Result<&2, &2, Failure, Unit>:
  match ok:
    case True{}:
      Done{Unit{}}
    case False{}:
      Fail{Failure{code, Nil{}}}

def code_name(code: Code) -> String:
  match code:
    case InvalidJson{}:
      "invalid_json"
    case InvalidUtf8{}:
      "invalid_utf8"
    case InvalidValue{}:
      "invalid_value"
    case PayloadTooLarge{}:
      "payload_too_large"
    case ResourceLimit{}:
      "resource_limit"
    case InvalidGeometry{}:
      "invalid_geometry"
    case UnsupportedGeometry{}:
      "unsupported_geometry"
    case GeometryLimitExceeded{}:
      "geometry_limit_exceeded"
    case InvalidHttp{}:
      "invalid_http"
    case InvalidBudget{}:
      "invalid_budget"

def failure(code: Code) -> Failure:
  Failure{code, Nil{}}

def default_budget(+boundary: String) -> Budget:
  choose(Budget, String.eq(boundary, "http_request"),
    _ => Budget{1048576, 65536, 32, 1000, 4194304},
    _ => choose(Budget, String.eq(boundary, "wss_control"),
      _ => Budget{16384, 4096, 32, 1000, 4194304},
      _ => Budget{4194304, 262144, 32, 1000, 4194304}))

def lookup(xs: List<&2, Member>, +key: String) -> Json:
  match xs:
    case Nil{}:
      JMissing{}
    case Con{Member{k, +v}, t}:
      choose(Json, String.eq(k, key), _ => v, _ => lookup(t, key))

def contains(xs: List<&2, Member>, +key: String) -> Bool:
  match xs:
    case Nil{}:
      False{}
    case Con{Member{k, v}, t}:
      Bool.or(String.eq(k, key), contains(t, key))

def get(json: Json, key: String) -> Json:
  match json:
    case JObj{xs}:
      lookup(xs, key)
    case _:
      JMissing{}

def has(json: Json, key: String) -> Bool:
  match json:
    case JObj{xs}:
      contains(xs, key)
    case _:
      False{}

def string(json: Json) -> String:
  match json:
    case JStr{s}:
      s
    case _:
      ""

def items(json: Json) -> List<&2, Json>:
  match json:
    case JArr{xs}:
      xs
    case _:
      Nil{}

def members(json: Json) -> List<&2, Member>:
  match json:
    case JObj{xs}:
      xs
    case _:
      Nil{}

def remove_member(xs: List<&2, Member>, +key: String) -> List<&2, Member>:
  match xs:
    case Nil{}:
      Nil{}
    case Con{Member{+k, +v}, +t}:
      Bool.pick(List<&2, Member>, String.eq(k, key), t,
        Con{Member{k, v}, remove_member(t, key)})

def equal(a: Json, b: Json) -> Bool:
  match a b:
    case JMissing{} JMissing{}:
      True{}
    case JNull{} JNull{}:
      True{}
    case JBool{x} JBool{y}:
      Cmp.is_eq(Bool.cmp(x, y))
    case JNum{x} JNum{y}:
      String.eq(x, y)
    case JStr{x} JStr{y}:
      String.eq(x, y)
    case JArr{Nil{}} JArr{Nil{}}:
      True{}
    case JArr{Con{h, t}} JArr{Con{bh, bt}}:
      Bool.and(equal(h, bh), equal(JArr{t}, JArr{bt}))
    case JObj{Nil{}} JObj{Nil{}}:
      True{}
    case JObj{Con{Member{+k, v}, t}} JObj{+bs}:
      Bool.and(contains(bs, k), Bool.and(equal(v, lookup(bs, k)),
        equal(JObj{t}, JObj{remove_member(bs, k)})))
    case _ _:
      False{}
