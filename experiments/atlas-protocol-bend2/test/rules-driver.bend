import Base
import ../common.bend as C
import ../json.bend as J
import ../numbers.bend as N
import ../scalar-rules.bend as Scalars
import ../schema-core.bend as Schema
import ../schemas.bend as Schemas
import ../rules.bend as R
import ../geometry.bend as G

def bytes(s: String) -> List<&2, U32>:
  match s:
    case SNil{}:
      Nil{}
    case SCon{Chr{x}, t}:
      Con{x, bytes(t)}

def resolve(reference: String) -> C.Json:
  Schemas.schema(String.drop(reference, 21n))

def bound(+raw: String) -> String:
  C.choose(String, Nat.is_gt(String.length(raw), 128n),
    _ => C.choose(String, String.starts_with(raw, "-"),
      _ => "-1.7976931348623157e+308", _ => "1.7976931348623157e+308"), _ => raw)

def number(raw: String, minimum: String, maximum: String, integer: Bool, exclusive_minimum: Bool, exclusive_maximum: Bool) -> Bool:
  N.accept(raw, bound(minimum), bound(maximum), integer, exclusive_minimum, exclusive_maximum)

def scalar(schema: C.Json, value: String) -> Bool:
  Scalars.scalar(schema, value)

def run(+mode: String, +name: String, raw: String) -> Result<&2, &2, C.Failure, Unit>:
  do Result<&2, &2, C.Failure, Unit>:
    +value : C.Json <- J.parse(bytes(raw), C.default_budget("http_response"))
    G.reserve(value, C.default_budget("http_response"))
    C.choose(Result<&2, &2, C.Failure, Unit>, String.eq(mode, "refine"),
      _ => R.refine(name, value),
      _ => do Result<&2, &2, C.Failure, Unit>:
        validated : C.Json <- Schema.validate(~resolve, ~number, ~N.format, ~scalar,
          ~R.scope, ~R.refine, Schemas.schema(name), value, 1000000)
        return Unit{})

def status(result: Result<&2, &2, C.Failure, Unit>) -> String:
  match result:
    case Done{x}:
      "ok"
    case Fail{C.Failure{code, issues}}:
      C.code_name(code)

def args(values: List<String>) -> IO(Unit):
  match values:
    case Con{program, Con{mode, Con{name, Con{raw, Nil{}}}}}:
      IO.print(status(run(mode, name, raw)))
    case _:
      IO.die(Unit, 1, "mode schema JSON")

def main() -> IO(Unit):
  do IO<Unit>:
    values : List<String> <- IO.args()
    args(values)
