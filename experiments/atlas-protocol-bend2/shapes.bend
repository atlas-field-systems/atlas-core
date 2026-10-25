import Base
import ./common.bend as C

def strings(xs: List<&2, String>) -> List<&2, C.Json>:
  match xs:
    case Nil{}:
      Nil{}
    case Con{h, t}:
      C.JStr{h} <> strings(t)

def keys(xs: List<&2, C.Member>) -> List<&2, String>:
  match xs:
    case Nil{}:
      Nil{}
    case Con{C.Member{k, v}, t}:
      k <> keys(t)

def members(a: List<&2, C.Member>, b: List<&2, C.Member>) -> List<&2, C.Member>:
  List.append(&2, C.Member, a, b)

def typed(kind: String) -> C.Json:
  C.JObj{[C.Member{"type", C.JStr{kind}}]}

def ref(name: String) -> C.Json:
  C.JObj{[C.Member{"$ref", C.JStr{"#/components/schemas/" ++ name}}]}

def literal(value: C.Json) -> C.Json:
  C.JObj{[C.Member{"const", value}]}

def tag(value: String) -> C.Json:
  literal(C.JStr{value})

def enum(values: List<&2, String>) -> C.Json:
  C.JObj{[C.Member{"type", C.JStr{"string"}}, C.Member{"enum", C.JArr{strings(values)}}]}

def any_of(values: List<&2, C.Json>) -> C.Json:
  C.JObj{[C.Member{"anyOf", C.JArr{values}}]}

def one_of(values: List<&2, C.Json>) -> C.Json:
  C.JObj{[C.Member{"oneOf", C.JArr{values}}]}

def nullable(value: C.Json) -> C.Json:
  any_of([value, typed("null")])

def closed(+required: List<&2, C.Member>, optional: List<&2, C.Member>) -> C.Json:
  C.JObj{[
    C.Member{"type", C.JStr{"object"}},
    C.Member{"properties", C.JObj{members(required, optional)}},
    C.Member{"required", C.JArr{strings(keys(required))}},
    C.Member{"additionalProperties", C.JBool{False{}}}]}

def add(value: C.Json, extra: List<&2, C.Member>) -> C.Json:
  C.JObj{members(C.members(value), extra)}

def nonempty(value: C.Json) -> C.Json:
  add(value, [C.Member{"minProperties", C.JNum{"1"}}])

def array(item: C.Json, minimum: U32, maximum: U32, unique: Bool) -> C.Json:
  C.JObj{[
    C.Member{"type", C.JStr{"array"}}, C.Member{"items", item},
    C.Member{"minItems", C.JNum{U32.show(minimum)}},
    C.Member{"maxItems", C.JNum{U32.show(maximum)}},
    C.Member{"uniqueItems", C.JBool{unique}}]}

def tuple(+items: List<&2, C.Json>) -> C.Json:
  C.JObj{[
    C.Member{"type", C.JStr{"array"}}, C.Member{"prefixItems", C.JArr{items}},
    C.Member{"items", C.JBool{False{}}},
    C.Member{"minItems", C.JNum{Nat.show(List.length(&2, C.Json, items))}},
    C.Member{"maxItems", C.JNum{Nat.show(List.length(&2, C.Json, items))}}]}

def dictionary(names: C.Json, item: C.Json, maximum: U32) -> C.Json:
  C.JObj{[
    C.Member{"type", C.JStr{"object"}}, C.Member{"propertyNames", names},
    C.Member{"additionalProperties", item},
    C.Member{"maxProperties", C.JNum{U32.show(maximum)}}]}

def text(maximum: U32) -> C.Json:
  add(typed("string"), [C.Member{"maxLength", C.JNum{U32.show(maximum)}}])

def pattern(maximum: U32, regex: String) -> C.Json:
  add(text(maximum), [C.Member{"pattern", C.JStr{regex}}])

def nonblank(maximum: U32) -> C.Json:
  add(pattern(maximum,
    "[^\\u0009-\\u000d\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]"),
    [C.Member{"minLength", C.JNum{"1"}}])

def integer(minimum: U32, maximum: U32) -> C.Json:
  add(typed("integer"), [
    C.Member{"minimum", C.JNum{U32.show(minimum)}},
    C.Member{"maximum", C.JNum{U32.show(maximum)}}])

def number(bounds: List<&2, C.Member>) -> C.Json:
  add(typed("number"), bounds)

def named(+name: String, value: C.Json) -> C.Member:
  C.Member{name, add(value, [C.Member{"title", C.JStr{name}}])}
