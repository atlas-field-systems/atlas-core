import Base
import ../common.bend as C
import ../json.bend as J
import ../geometry.bend as G

def bytes(s: String) -> List<&2, U32>:
  match s:
    case SNil{}:
      Nil{}
    case SCon{Chr{x}, t}:
      Con{x, bytes(t)}

def run(+mode: String, raw: String, changes: U32, work: U32) -> Result<&2, &2, C.Failure, Unit>:
  do Result<&2, &2, C.Failure, Unit>:
    +value : C.Json <- J.parse(bytes(raw), C.default_budget("http_response"))
    C.choose(Result<&2, &2, C.Failure, Unit>, String.eq(mode, "reserve"),
      _ => G.reserve(value, C.Budget{4194304, 262144, 32, changes, work}), _ => G.check(value))

def status(result: Result<&2, &2, C.Failure, Unit>) -> String:
  match result:
    case Done{x}:
      "ok"
    case Fail{C.Failure{code, issues}}:
      C.code_name(code)

def uint(value: Maybe<&2, U32>, fallback: U32) -> U32:
  match value:
    case Some{x}:
      x
    case None{}:
      fallback

def args(values: List<String>) -> IO(Unit):
  match values:
    case Con{program, Con{mode, Con{raw, Con{changes, Con{work, Nil{}}}}}}:
      IO.print(status(run(mode, raw, uint(U32.read(changes), 1000), uint(U32.read(work), 4194304))))
    case _:
      IO.die(Unit, 1, "mode JSON changes work")

def main() -> IO(Unit):
  do IO<Unit>:
    values : List<String> <- IO.args()
    args(values)
