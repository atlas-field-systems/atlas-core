import Base
import ../common.bend as C
import ../schema-core.bend as S

def resolve(registry: List<&2, C.Member>, reference: String) -> C.Json:
  C.JMissing{}

def number(raw: String, minimum: String, maximum: String, integer: Bool, exclusive_minimum: Bool, exclusive_maximum: Bool) -> Bool:
  False{}

def format(raw: String) -> String:
  raw

def scalar(schema: C.Json, value: String) -> Bool:
  True{}

def scope(name: String, value: C.Json) -> C.Code:
  C.choose(C.Code, String.eq(name, "GeometryFixture"),
    _ => C.InvalidGeometry{}, _ => C.InvalidValue{})

def refine(name: String, value: C.Json) -> Result<&2, &2, C.Failure, Unit>:
  C.require(Bool.not(String.eq(name, "AlwaysReject")), C.InvalidValue{})

def validate(schema: C.Json, value: C.Json) -> Result<&2, &2, C.Failure, C.Json>:
  S.validate(~resolve, ~number, ~format, ~scalar, ~scope, ~refine, schema, value, 100000, Nil{})
