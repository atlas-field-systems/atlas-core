import Base
import ./common.bend as C
import ./json.bend as J
import ./numbers.bend as N
import ./budget.bend as B
import ./admission.bend as A
import ./scalar-rules.bend as Scalars
import ./schema-core.bend as S
import ./schemas.bend as Schemas
import ./catalog.bend as Catalog

def scalar(schema: C.Json, text: String) -> Bool:
  Scalars.scalar(schema, text)

def validate(~definitions: Unit -> List<&2, C.Member>,
    ~refine: String -> C.Json -> Result<&2, &2, C.Failure, Unit>,
    ~scope: String -> C.Json -> C.Code,
    ~reserve: C.Json -> C.Budget -> Result<&2, &2, C.Failure, Unit>,
    name: String, +value: C.Json, +budget: C.Budget) -> Result<&2, &2, C.Failure, C.Json>:
  match budget:
    case C.Budget{b, +values, d, c, w}:
      do Result<&2, &2, C.Failure, C.Json>:
        reserve(value, C.Budget{b, values, d, c, w})
        +registry : List<&2, C.Member> = List.append(&2, C.Member, Schemas.definitions(), definitions(Unit{}))
        S.validate(~Catalog.resolve, ~Catalog.numeric, ~N.format, ~scalar, ~scope, ~refine,
          Catalog.resolve(registry, name), value, (values * 96 + 1024 : U32), registry)

def read_prepared(~definitions: Unit -> List<&2, C.Member>,
    ~refine: String -> C.Json -> Result<&2, &2, C.Failure, Unit>,
    ~scope: String -> C.Json -> C.Code,
    ~reserve: C.Json -> C.Budget -> Result<&2, &2, C.Failure, Unit>,
    name: String, prepared: A.Prepared) -> Result<&2, &2, C.Failure, C.Json>:
  match prepared:
    case A.Prepared{value, budget}:
      validate(~definitions, ~refine, ~scope, ~reserve, name, value, budget)

def read_json(~definitions: Unit -> List<&2, C.Member>,
    ~refine: String -> C.Json -> Result<&2, &2, C.Failure, Unit>,
    ~scope: String -> C.Json -> C.Code,
    ~reserve: C.Json -> C.Budget -> Result<&2, &2, C.Failure, Unit>,
    +name: String, boundary: String, bytes: List<&2, U32>, +lower: C.Json) -> Result<&2, &2, C.Failure, C.Json>:
  do Result<&2, &2, C.Failure, C.Json>:
    base : C.Budget <- B.effective(boundary, lower)
    prepared : A.Prepared <- A.prepare(name, bytes, base, lower)
    read_prepared(~definitions, ~refine, ~scope, ~reserve, name, prepared)

def validate_value(~definitions: Unit -> List<&2, C.Member>,
    ~refine: String -> C.Json -> Result<&2, &2, C.Failure, Unit>,
    ~scope: String -> C.Json -> C.Code,
    ~reserve: C.Json -> C.Budget -> Result<&2, &2, C.Failure, Unit>,
    +name: String, boundary: String, +value: C.Json, +lower: C.Json) -> Result<&2, &2, C.Failure, C.Json>:
  do Result<&2, &2, C.Failure, C.Json>:
    base : C.Budget <- B.effective(boundary, lower)
    +budget : C.Budget <- A.writer_budget(name, value, base, lower)
    measured : List<&2, U32> <- J.encode(value, budget)
    validate(~definitions, ~refine, ~scope, ~reserve, name, value, budget)

def write_json(~definitions: Unit -> List<&2, C.Member>,
    ~refine: String -> C.Json -> Result<&2, &2, C.Failure, Unit>,
    ~scope: String -> C.Json -> C.Code,
    ~reserve: C.Json -> C.Budget -> Result<&2, &2, C.Failure, Unit>,
    +name: String, +boundary: String, value: C.Json, +lower: C.Json) -> Result<&2, &2, C.Failure, List<&2, U32>>:
  do Result<&2, &2, C.Failure, List<&2, U32>>:
    +checked : C.Json <- validate_value(~definitions, ~refine, ~scope, ~reserve, name, boundary, value, lower)
    base : C.Budget <- B.effective(boundary, lower)
    budget : C.Budget <- A.writer_budget(name, checked, base, lower)
    J.encode(checked, budget)

def check_json(bytes: List<&2, U32>, boundary: String, lower: C.Json) -> Result<&2, &2, C.Failure, Unit>:
  do Result<&2, &2, C.Failure, Unit>:
    budget : C.Budget <- B.effective(boundary, lower)
    J.check(bytes, budget)
