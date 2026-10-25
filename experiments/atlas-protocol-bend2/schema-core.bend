import Base
import ./common.bend as C

type Job is Data:
  Check{schema: C.Json, value: C.Json}
  Refine{name: String}
  CloseChoice{}
  Discard{}
  FinishArray{count: Nat, unique: Bool}
  FinishObject{keys: List<&2, String>}

type Choice is Data:
  Choice{alternatives: List<&2, C.Json>, value: C.Json, rest: List<&2, Job>, values: List<&2, C.Json>, failure: C.Failure}

type State is Data:
  Running{jobs: List<&2, Job>, values: List<&2, C.Json>, choices: List<&2, Choice>}
  Rejected{failure: C.Failure}
  Accepted{value: C.Json}

def uint_result(value: Maybe<&2, U32>, fallback: U32) -> U32:
  match value:
    case Some{x}:
      x
    case None{}:
      fallback

def uint(value: C.Json, fallback: U32) -> U32:
  match value:
    case C.JNum{s}:
      uint_result(U32.read(s), fallback)
    case _:
      fallback

def truth(value: C.Json) -> Bool:
  match value:
    case C.JBool{x}:
      x
    case _:
      False{}

def missing(value: C.Json) -> Bool:
  match value:
    case C.JMissing{}:
      True{}
    case _:
      False{}

def number_text(value: C.Json) -> String:
  match value:
    case C.JNum{s}:
      s
    case _:
      ""

def member_count(value: C.Json) -> U32:
  U32.from_nat(List.length(&2, C.Member, C.members(value)))

def item_count(value: C.Json) -> U32:
  U32.from_nat(List.length(&2, C.Json, C.items(value)))

def priority(code: C.Code) -> U32:
  match code:
    case C.GeometryLimitExceeded{}:
      3
    case C.UnsupportedGeometry{}:
      2
    case C.InvalidGeometry{}:
      1
    case _:
      0

def strongest(a: C.Failure, b: C.Failure) -> C.Failure:
  match a b:
    case C.Failure{+ac, +ai} C.Failure{+bc, +bi}:
      C.choose(C.Failure, U32.is_ge(priority(bc), priority(ac)),
        _ => C.Failure{bc, bi}, _ => C.Failure{ac, ai})

def reject(choices: List<&2, Choice>, +failure: C.Failure) -> State:
  match choices:
    case Nil{}:
      Rejected{failure}
    case Con{Choice{Nil{}, v, rest, vals, prior}, tail}:
      reject(tail, strongest(prior, failure))
    case Con{Choice{Con{alt, alternatives}, +v, +rest, +vals, prior}, tail}:
      Running{Con{Check{alt, v}, Con{CloseChoice{}, rest}}, vals,
        Con{Choice{alternatives, v, rest, vals, strongest(prior, failure)}, tail}}

def require_fields(xs: List<&2, C.Json>, +value: C.Json) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case Con{h, t}:
      C.has(value, C.string(h)) && require_fields(t, value)

def known_fields(xs: List<&2, C.Member>, +properties: C.Json, +additional: C.Json) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case Con{C.Member{k, v}, t}:
      (C.has(properties, k) || Bool.not(C.equal(additional, C.JBool{False{}}))) &&
        known_fields(t, properties, additional)

def matches_type(+name: String, value: C.Json) -> Bool:
  match value:
    case C.JMissing{}:
      False{}
    case C.JNull{}:
      String.eq(name, "null")
    case C.JBool{x}:
      String.eq(name, "boolean")
    case C.JNum{x}:
      String.eq(name, "number") || String.eq(name, "integer")
    case C.JStr{x}:
      String.eq(name, "string")
    case C.JArr{x}:
      String.eq(name, "array")
    case C.JObj{x}:
      String.eq(name, "object")

def matches_types(names: List<&2, C.Json>, +value: C.Json) -> Bool:
  match names:
    case Nil{}:
      False{}
    case Con{h, t}:
      matches_type(C.string(h), value) || matches_types(t, value)

def type_valid(schema_type: C.Json, +value: C.Json) -> Bool:
  match schema_type:
    case C.JMissing{}:
      True{}
    case C.JStr{name}:
      matches_type(name, value)
    case C.JArr{names}:
      matches_types(names, value)
    case _:
      False{}

def same(~number: String -> String -> String -> Bool -> Bool -> Bool -> Bool,
    a: C.Json, b: C.Json) -> Bool:
  match a b:
    case C.JNum{raw} C.JNum{+bound}:
      number(raw, bound, bound, False{}, False{}, False{})
    case x y:
      C.equal(x, y)

def enum_has(~number: String -> String -> String -> Bool -> Bool -> Bool -> Bool,
    values: List<&2, C.Json>, +value: C.Json) -> Bool:
  match values:
    case Nil{}:
      False{}
    case Con{h, t}:
      same(~number, h, value) || enum_has(~number, t, value)

def atoms_valid(~number: String -> String -> String -> Bool -> Bool -> Bool -> Bool,
    +schema: C.Json, +value: C.Json) -> Bool:
  (missing(C.get(schema, "const")) || same(~number, C.get(schema, "const"), value)) &&
    (missing(C.get(schema, "enum")) || enum_has(~number, C.items(C.get(schema, "enum")), value)) &&
    type_valid(C.get(schema, "type"), value)

def property_jobs(+xs: List<&2, C.Member>, +value: C.Json, +rest: List<&2, Job>) -> List<&2, Job>:
  match xs:
    case Nil{}:
      rest
    case Con{C.Member{+k, schema}, t}:
      C.choose(List<&2, Job>, C.has(value, k),
        _ => Con{Check{schema, C.get(value, k)}, property_jobs(t, value, rest)},
        _ => property_jobs(t, value, rest))

def property_keys(+xs: List<&2, C.Member>, +value: C.Json) -> List<&2, String>:
  match xs:
    case Nil{}:
      Nil{}
    case Con{C.Member{+k, s}, t}:
      C.choose(List<&2, String>, C.has(value, k),
        _ => Con{k, property_keys(t, value)}, _ => property_keys(t, value))

def extra_keys(+xs: List<&2, C.Member>, +properties: C.Json) -> List<&2, String>:
  match xs:
    case Nil{}:
      Nil{}
    case Con{C.Member{+k, v}, t}:
      C.choose(List<&2, String>, C.has(properties, k),
        _ => extra_keys(t, properties), _ => Con{k, extra_keys(t, properties)})

def extra_jobs(+xs: List<&2, C.Member>, +properties: C.Json, +additional: C.Json,
    +names: C.Json, +rest: List<&2, Job>) -> List<&2, Job>:
  match xs:
    case Nil{}:
      rest
    case Con{C.Member{+k, v}, t}:
      C.choose(List<&2, Job>, C.has(properties, k),
        _ => extra_jobs(t, properties, additional, names, rest),
        _ => Con{Check{additional, v}, extra_jobs(t, properties, additional, names, rest)})

def name_jobs(xs: List<&2, C.Member>, +schema: C.Json, +rest: List<&2, Job>) -> List<&2, Job>:
  match xs:
    case Nil{}:
      rest
    case Con{C.Member{k, v}, t}:
      Con{Check{schema, C.JStr{k}}, Con{Discard{}, name_jobs(t, schema, rest)}}

def object_state(+schema: C.Json, +members: List<&2, C.Member>, rest: List<&2, Job>,
    +values: List<&2, C.Json>, +choices: List<&2, Choice>) -> State:
  +value = {C.JObj{members} : C.Json}
  +properties = C.get(schema, "properties")
  +additional = C.get(schema, "additionalProperties")
  +keys = List.append(&2, String, property_keys(C.members(properties), value), extra_keys(members, properties))
  +valid = require_fields(C.items(C.get(schema, "required")), value) &&
    known_fields(members, properties, additional) &&
    U32.is_ge(member_count(value), uint(C.get(schema, "minProperties"), 0)) &&
    U32.is_le(member_count(value), uint(C.get(schema, "maxProperties"), 262144))
  +jobs = property_jobs(C.members(properties), value,
    extra_jobs(members, properties, additional, C.get(schema, "propertyNames"),
      Con{FinishObject{keys}, rest}))
  +next = C.choose(List<&2, Job>, missing(C.get(schema, "propertyNames")),
    _ => jobs, _ => name_jobs(members, C.get(schema, "propertyNames"), jobs))
  C.choose(State, valid, _ => Running{next, values, choices},
    _ => reject(choices, C.failure(C.InvalidValue{})))

def array_jobs(xs: List<&2, C.Json>, prefixes: List<&2, C.Json>, +items: C.Json,
    +rest: List<&2, Job>) -> List<&2, Job>:
  match xs prefixes:
    case Nil{} _:
      rest
    case Con{h, t} Nil{}:
      Con{Check{items, h}, array_jobs(t, Nil{}, items, rest)}
    case Con{h, t} Con{s, st}:
      Con{Check{s, h}, array_jobs(t, st, items, rest)}

def array_state(+schema: C.Json, +items: List<&2, C.Json>, rest: List<&2, Job>,
    +values: List<&2, C.Json>, +choices: List<&2, Choice>) -> State:
  +count = List.length(&2, C.Json, items)
  valid = U32.is_ge(U32.from_nat(count), uint(C.get(schema, "minItems"), 0)) &&
    U32.is_le(U32.from_nat(count), uint(C.get(schema, "maxItems"), 262144))
  jobs = array_jobs(items, C.items(C.get(schema, "prefixItems")), C.get(schema, "items"),
    Con{FinishArray{count, truth(C.get(schema, "uniqueItems"))}, rest})
  C.choose(State, valid, _ => Running{jobs, values, choices},
    _ => reject(choices, C.failure(C.InvalidValue{})))

def unique_head(+value: C.Json, xs: List<&2, C.Json>) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case Con{h, t}:
      Bool.not(C.equal(value, h)) && unique_head(value, t)

def unique(xs: List<&2, C.Json>) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case Con{+h, +t}:
      unique_head(h, t) && unique(t)

type Taken is Data:
  Taken{items: List<&2, C.Json>, rest: List<&2, C.Json>}

def take_values(count: Nat, values: List<&2, C.Json>, acc: List<&2, C.Json>) -> Taken:
  match count values:
    case 0n xs:
      Taken{acc, xs}
    case 1n+p Con{h, t}:
      take_values(p, t, Con{h, acc})
    case _ Nil{}:
      Taken{acc, Nil{}}

type Built is Data:
  Built{members: List<&2, C.Member>, rest: List<&2, C.Json>}

def build_members(keys: List<&2, String>, values: List<&2, C.Json>, acc: List<&2, C.Member>) -> Built:
  match keys values:
    case Nil{} xs:
      Built{acc, xs}
    case Con{k, t} Con{v, vt}:
      build_members(t, vt, Con{C.Member{k, v}, acc})
    case _ Nil{}:
      Built{acc, Nil{}}

def finish_array(taken: Taken, +distinct: Bool, jobs: List<&2, Job>, +choices: List<&2, Choice>) -> State:
  match taken:
    case Taken{+items, rest}:
      C.choose(State, Bool.not(distinct) || unique(items),
        _ => Running{jobs, Con{C.JArr{items}, rest}, choices},
        _ => reject(choices, C.failure(C.InvalidValue{})))

def finish_object(built: Built, jobs: List<&2, Job>, choices: List<&2, Choice>) -> State:
  match built:
    case Built{members, rest}:
      Running{jobs, Con{C.JObj{members}, rest}, choices}

def lower_bound(+schema: C.Json) -> String:
  C.choose(String, missing(C.get(schema, "exclusiveMinimum")),
    _ => number_text(C.get(schema, "minimum")), _ => number_text(C.get(schema, "exclusiveMinimum")))

def upper_bound(+schema: C.Json) -> String:
  C.choose(String, missing(C.get(schema, "exclusiveMaximum")),
    _ => number_text(C.get(schema, "maximum")), _ => number_text(C.get(schema, "exclusiveMaximum")))

def number_state(~number: String -> String -> String -> Bool -> Bool -> Bool -> Bool,
    ~format: String -> String, +schema: C.Json, +raw: String, rest: List<&2, Job>,
    +values: List<&2, C.Json>, +choices: List<&2, Choice>) -> State:
  valid = number(raw, lower_bound(schema), upper_bound(schema),
    String.eq(C.string(C.get(schema, "type")), "integer"),
    Bool.not(missing(C.get(schema, "exclusiveMinimum"))),
    Bool.not(missing(C.get(schema, "exclusiveMaximum"))))
  C.choose(State, valid, _ => Running{rest, Con{C.JNum{format(raw)}, values}, choices},
    _ => reject(choices, C.failure(C.InvalidValue{})))

def string_state(~scalar: C.Json -> String -> Bool, +schema: C.Json, +text: String,
    rest: List<&2, Job>, +values: List<&2, C.Json>, +choices: List<&2, Choice>) -> State:
  +length = U32.from_nat(String.length(text))
  valid = U32.is_ge(length, uint(C.get(schema, "minLength"), 0)) &&
    U32.is_le(length, uint(C.get(schema, "maxLength"), 4194304)) && scalar(schema, text)
  C.choose(State, valid, _ => Running{rest, Con{C.JStr{text}, values}, choices},
    _ => reject(choices, C.failure(C.InvalidValue{})))

def value_state(~number: String -> String -> String -> Bool -> Bool -> Bool -> Bool,
    ~format: String -> String, ~scalar: C.Json -> String -> Bool,
    +schema: C.Json, value: C.Json, jobs: List<&2, Job>, values: List<&2, C.Json>,
    +choices: List<&2, Choice>) -> State:
  match value:
    case C.JMissing{}:
      reject(choices, C.failure(C.InvalidValue{}))
    case C.JObj{members}:
      object_state(schema, members, jobs, values, choices)
    case C.JArr{items}:
      array_state(schema, items, jobs, values, choices)
    case C.JStr{text}:
      string_state(~scalar, schema, text, jobs, values, choices)
    case C.JNum{raw}:
      number_state(~number, ~format, schema, raw, jobs, values, choices)
    case v:
      Running{jobs, Con{v, values}, choices}

def alternatives_state(alternatives: List<&2, C.Json>, +value: C.Json, +jobs: List<&2, Job>,
    +values: List<&2, C.Json>, +choices: List<&2, Choice>) -> State:
  match alternatives:
    case Nil{}:
      reject(choices, C.failure(C.InvalidValue{}))
    case Con{h, t}:
      Running{Con{Check{h, value}, Con{CloseChoice{}, jobs}}, values,
        Con{Choice{t, value, jobs, values, C.failure(C.InvalidValue{})}, choices}}

def check_state(~resolve: String -> C.Json,
    ~number: String -> String -> String -> Bool -> Bool -> Bool -> Bool,
    ~format: String -> String, ~scalar: C.Json -> String -> Bool,
    ~scope: String -> C.Json -> C.Code,
    +schema: C.Json, +value: C.Json, +jobs: List<&2, Job>, +values: List<&2, C.Json>,
    +choices: List<&2, Choice>) -> State:
  C.choose(State, C.equal(schema, C.JBool{False{}}) || missing(schema),
    _ => reject(choices, C.failure(C.InvalidValue{})),
    _ => C.choose(State, C.has(schema, "$ref"),
      _ => Running{Con{Check{resolve(C.string(C.get(schema, "$ref"))), value}, jobs}, values, choices},
      _ => C.choose(State, C.has(schema, "title"),
        _ => Running{Con{Check{C.JObj{C.remove_member(C.members(schema), "title")}, value},
          Con{Refine{C.string(C.get(schema, "title"))}, Con{CloseChoice{}, jobs}}}, values,
          Con{Choice{Nil{}, value, jobs, values,
            C.failure(scope(C.string(C.get(schema, "title")), value))}, choices}},
        _ => C.choose(State, atoms_valid(~number, schema, value),
          _ => C.choose(State, C.has(schema, "anyOf") || C.has(schema, "oneOf"),
            _ => alternatives_state(C.items(C.choose(C.Json, C.has(schema, "anyOf"),
              _ => C.get(schema, "anyOf"), _ => C.get(schema, "oneOf"))), value, jobs, values, choices),
            _ => value_state(~number, ~format, ~scalar, schema, value, jobs, values, choices)),
          _ => reject(choices, C.failure(C.InvalidValue{}))))))

def refined(result: Result<&2, &2, C.Failure, Unit>, jobs: List<&2, Job>,
    +values: List<&2, C.Json>, +choices: List<&2, Choice>) -> State:
  match result:
    case Done{x}:
      Running{jobs, values, choices}
    case Fail{failure}:
      reject(choices, failure)

def top(values: List<&2, C.Json>) -> C.Json:
  match values:
    case Nil{}:
      C.JMissing{}
    case Con{h, t}:
      h

def drop(values: List<&2, C.Json>) -> List<&2, C.Json>:
  match values:
    case Nil{}:
      Nil{}
    case Con{h, t}:
      t

def drop_choice(choices: List<&2, Choice>) -> List<&2, Choice>:
  match choices:
    case Nil{}:
      Nil{}
    case Con{h, t}:
      t

def step(~resolve: String -> C.Json,
    ~number: String -> String -> String -> Bool -> Bool -> Bool -> Bool,
    ~format: String -> String, ~scalar: C.Json -> String -> Bool,
    ~scope: String -> C.Json -> C.Code,
    ~refine: String -> C.Json -> Result<&2, &2, C.Failure, Unit>,
    jobs: List<&2, Job>, +values: List<&2, C.Json>, +choices: List<&2, Choice>) -> State:
  match jobs:
    case Nil{}:
      Accepted{top(values)}
    case Con{Check{s, v}, rest}:
      check_state(~resolve, ~number, ~format, ~scalar, ~scope, s, v, rest, values, choices)
    case Con{Refine{name}, rest}:
      refined(refine(name, top(values)), rest, values, choices)
    case Con{Discard{}, rest}:
      Running{rest, drop(values), choices}
    case Con{CloseChoice{}, rest}:
      Running{rest, values, drop_choice(choices)}
    case Con{FinishArray{n, distinct}, rest}:
      finish_array(take_values(n, values, Nil{}), distinct, rest, choices)
    case Con{FinishObject{keys}, rest}:
      finish_object(build_members(List.reverse(&2, String, keys), values, Nil{}), rest, choices)

def run(~resolve: String -> C.Json,
    ~number: String -> String -> String -> Bool -> Bool -> Bool -> Bool,
    ~format: String -> String, ~scalar: C.Json -> String -> Bool,
    ~scope: String -> C.Json -> C.Code,
    ~refine: String -> C.Json -> Result<&2, &2, C.Failure, Unit>,
    fuel: Nat, state: State) -> Result<&2, &2, C.Failure, C.Json>:
  match fuel state:
    case _ Accepted{value}:
      Done{value}
    case _ Rejected{failure}:
      Fail{failure}
    case 0n _:
      Fail{C.failure(C.ResourceLimit{})}
    case 1n+p Running{jobs, values, choices}:
      run(~resolve, ~number, ~format, ~scalar, ~scope, ~refine, p,
        step(~resolve, ~number, ~format, ~scalar, ~scope, ~refine, jobs, values, choices))

def validate(~resolve: String -> C.Json,
    ~number: String -> String -> String -> Bool -> Bool -> Bool -> Bool,
    ~format: String -> String, ~scalar: C.Json -> String -> Bool,
    ~scope: String -> C.Json -> C.Code,
    ~refine: String -> C.Json -> Result<&2, &2, C.Failure, Unit>,
    schema: C.Json, value: C.Json, fuel: U32) -> Result<&2, &2, C.Failure, C.Json>:
  run(~resolve, ~number, ~format, ~scalar, ~scope, ~refine, U32.to_nat(fuel),
    Running{[Check{schema, value}], Nil{}, Nil{}})
