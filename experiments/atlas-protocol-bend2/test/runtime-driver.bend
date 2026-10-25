import Base
import ../common.bend as C
import ../runtime.bend as R
import ../scalar-rules.bend as S

def definitions(unit: Unit) -> List<&2, C.Member>:
  Nil{}

def refine(name: String, value: C.Json) -> Result<&2, &2, C.Failure, Unit>:
  C.require(S.standard(name, value), C.InvalidValue{})

def scope(name: String, value: C.Json) -> C.Code:
  C.InvalidValue{}

def reserve(value: C.Json, budget: C.Budget) -> Result<&2, &2, C.Failure, Unit>:
  Done{Unit{}}

def read_json(name: String, bytes: List<&2, U32>) -> Result<&2, &2, C.Failure, C.Json>:
  R.read_json(~definitions, ~refine, ~scope, ~reserve, name, "http_request", bytes, C.JObj{Nil{}})

def write_json(name: String, value: C.Json) -> Result<&2, &2, C.Failure, List<&2, U32>>:
  R.write_json(~definitions, ~refine, ~scope, ~reserve, name, "http_request", value, C.JObj{Nil{}})

def failure_code(failure: C.Failure) -> String:
  match failure:
    case C.Failure{code, issues}:
      C.code_name(code)
