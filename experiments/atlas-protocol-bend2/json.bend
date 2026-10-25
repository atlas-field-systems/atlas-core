import Base
import ./common.bend as C

def bytes_count(xs: List<&2, U32>, +remaining: U32, count: U32) -> Result<&2, &2, C.Failure, U32>:
  match xs:
    case Nil{}:
      Done{count}
    case Con{h, t}:
      do Result<&2, &2, C.Failure, U32>:
        C.require((remaining > 0 : U32), C.PayloadTooLarge{})
        bytes_count(t, (remaining - 1 : U32), (count + 1 : U32))

def between(+x: U32, lo: U32, hi: U32) -> Bool:
  Bool.and((x >= lo : U32), (x <= hi : U32))

type Utf is Data:
  Utf{left: Nat, scalar: U32, lo: U32, hi: U32}

def utf_start_cases(+b: U32, ascii: Bool, two: Bool, three: Bool, four: Bool) -> Result<&2, &2, C.Failure, Utf>:
  match ascii two three four:
    case True{} _ _ _:
      Done{Utf{0n, b, 128, 191}}
    case _ True{} _ _:
      Done{Utf{1n, (b - 192 : U32), 128, 191}}
    case _ _ True{} _:
      Done{Utf{2n, (b - 224 : U32),
        (128 + 32 * Bool.to_u32(U32.is_eq(b, 224)) : U32),
        (191 - 32 * Bool.to_u32(U32.is_eq(b, 237)) : U32)}}
    case _ _ _ True{}:
      Done{Utf{3n, (b - 240 : U32),
        (128 + 16 * Bool.to_u32(U32.is_eq(b, 240)) : U32),
        (191 - 48 * Bool.to_u32(U32.is_eq(b, 244)) : U32)}}
    case _ _ _ _:
      Fail{C.failure(C.InvalidUtf8{})}

def utf_start(+b: U32) -> Result<&2, &2, C.Failure, Utf>:
  utf_start_cases(b, (b < 128 : U32), between(b, 194, 223), between(b, 224, 239), between(b, 240, 244))

def utf_step(+b: U32, u: Utf) -> Result<&2, &2, C.Failure, Utf>:
  match u:
    case Utf{0n, old, lo, hi}:
      utf_start(b)
    case Utf{1n+p, scalar, lo, hi}:
      do Result<&2, &2, C.Failure, Utf>:
        C.require(between(b, lo, hi), C.InvalidUtf8{})
        return Utf{p, (scalar * 64 + b - 128 : U32), 128, 191}

def utf_end(u: Utf) -> Result<&2, &2, C.Failure, Unit>:
  match u:
    case Utf{0n, scalar, lo, hi}:
      Done{Unit{}}
    case _:
      Fail{C.failure(C.InvalidUtf8{})}

def utf_check(xs: List<&2, U32>, u: Utf) -> Result<&2, &2, C.Failure, Unit>:
  match xs:
    case Nil{}:
      utf_end(u)
    case Con{b, t}:
      do Result<&2, &2, C.Failure, Unit>:
        next : Utf <- utf_step(b, u)
        utf_check(t, next)

def scalar_valid(+x: U32) -> Bool:
  Bool.and((x <= 1114111 : U32), Bool.not(between(x, 55296, 57343)))

def keep_char(keep: Bool, x: U32, acc: String) -> String:
  match keep:
    case True{}:
      SCon{Chr{x}, acc}
    case False{}:
      acc

type StringMode is Data:
  StringText{}
  Escape{}
  Hex{left: Nat, value: U32}
  LowSlash{high: U32}
  LowU{high: U32}
  LowHex{left: Nat, value: U32, high: U32}
  Unicode{utf: Utf}

type StringScan is Data:
  StringScan{mode: StringMode, acc: String, keep: Bool}

def string_utf(u: Utf, acc: String, +keep: Bool) -> StringScan:
  match u:
    case Utf{0n, scalar, lo, hi}:
      StringScan{StringText{}, keep_char(keep, scalar, acc), keep}
    case next:
      StringScan{Unicode{next}, acc, keep}

def hex_digit(+b: U32) -> Result<&2, &2, C.Failure, U32>:
  C.choose(Result<&2, &2, C.Failure, U32>, between(b, 48, 57),
    _ => Done{(b - 48 : U32)},
    _ => C.choose(Result<&2, &2, C.Failure, U32>, between(b, 65, 70),
      _ => Done{(b - 55 : U32)},
      _ => C.choose(Result<&2, &2, C.Failure, U32>, between(b, 97, 102),
        _ => Done{(b - 87 : U32)}, _ => Fail{C.failure(C.InvalidJson{})})))

def hex_finish(+x: U32, acc: String, +keep: Bool, high: Bool, low: Bool) -> Result<&2, &2, C.Failure, StringScan>:
  match high low:
    case True{} _:
      Done{StringScan{LowSlash{x}, acc, keep}}
    case _ True{}:
      Fail{C.failure(C.InvalidJson{})}
    case _ _:
      Done{StringScan{StringText{}, keep_char(keep, x, acc), keep}}

def hex_step(left: Nat, +x: U32, acc: String, keep: Bool) -> Result<&2, &2, C.Failure, StringScan>:
  match left:
    case 0n:
      hex_finish(x, acc, keep, between(x, 55296, 56319), between(x, 56320, 57343))
    case n:
      Done{StringScan{Hex{n, x}, acc, keep}}

def low_hex_step(left: Nat, +x: U32, high: U32, acc: String, +keep: Bool) -> Result<&2, &2, C.Failure, StringScan>:
  match left:
    case 0n:
      do Result<&2, &2, C.Failure, StringScan>:
        C.require(between(x, 56320, 57343), C.InvalidJson{})
        return StringScan{StringText{}, keep_char(keep, (65536 + (high - 55296) * 1024 + x - 56320 : U32), acc), keep}
    case n:
      Done{StringScan{LowHex{n, x, high}, acc, keep}}

def string_step(+b: U32, s: StringScan) -> Result<&2, &2, C.Failure, StringScan>:
  match s:
    case StringScan{StringText{}, +acc, +keep}:
      C.choose(Result<&2, &2, C.Failure, StringScan>, U32.is_eq(b, 92),
        _ => Done{StringScan{Escape{}, acc, keep}},
        _ => do Result<&2, &2, C.Failure, StringScan>:
          C.require((b >= 32 : U32), C.InvalidJson{})
          u : Utf <- utf_start(b)
          return string_utf(u, acc, keep))
    case StringScan{Escape{}, +acc, +keep}:
      C.choose(Result<&2, &2, C.Failure, StringScan>, U32.is_eq(b, 117),
        _ => Done{StringScan{Hex{4n, 0}, acc, keep}},
        _ => do Result<&2, &2, C.Failure, StringScan>:
          C.require(Bool.or(Bool.or(U32.is_eq(b, 34), U32.is_eq(b, 92)),
            Bool.or(U32.is_eq(b, 47), Bool.or(U32.is_eq(b, 98),
              Bool.or(U32.is_eq(b, 102), Bool.or(U32.is_eq(b, 110),
                Bool.or(U32.is_eq(b, 114), U32.is_eq(b, 116))))))), C.InvalidJson{})
          return StringScan{StringText{}, keep_char(keep,
            Bool.pick(U32, U32.is_eq(b, 98), 8,
            Bool.pick(U32, U32.is_eq(b, 102), 12,
            Bool.pick(U32, U32.is_eq(b, 110), 10,
            Bool.pick(U32, U32.is_eq(b, 114), 13,
            Bool.pick(U32, U32.is_eq(b, 116), 9, b))))), acc), keep})
    case StringScan{Hex{0n, x}, acc, keep}:
      Fail{C.failure(C.InvalidJson{})}
    case StringScan{Hex{1n+p, x}, acc, keep}:
      do Result<&2, &2, C.Failure, StringScan>:
        digit : U32 <- hex_digit(b)
        hex_step(p, (x * 16 + digit : U32), acc, keep)
    case StringScan{LowSlash{high}, acc, keep}:
      do Result<&2, &2, C.Failure, StringScan>:
        C.require(U32.is_eq(b, 92), C.InvalidJson{})
        return StringScan{LowU{high}, acc, keep}
    case StringScan{LowU{high}, acc, keep}:
      do Result<&2, &2, C.Failure, StringScan>:
        C.require(U32.is_eq(b, 117), C.InvalidJson{})
        return StringScan{LowHex{4n, 0, high}, acc, keep}
    case StringScan{LowHex{0n, x, high}, acc, keep}:
      Fail{C.failure(C.InvalidJson{})}
    case StringScan{LowHex{1n+p, x, high}, acc, keep}:
      do Result<&2, &2, C.Failure, StringScan>:
        digit : U32 <- hex_digit(b)
        low_hex_step(p, (x * 16 + digit : U32), high, acc, keep)
    case StringScan{Unicode{u}, acc, keep}:
      do Result<&2, &2, C.Failure, StringScan>:
        next : Utf <- utf_step(b, u)
        return string_utf(next, acc, keep)

type ScannedString is Data:
  ScannedString{value: String, rest: List<&2, U32>}

def string_scan(xs: List<&2, U32>, s: StringScan) -> Result<&2, &2, C.Failure, ScannedString>:
  match xs s:
    case Nil{} _:
      Fail{C.failure(C.InvalidJson{})}
    case Con{34, t} StringScan{StringText{}, acc, keep}:
      Done{ScannedString{String.reverse(acc), t}}
    case Con{b, t} scan:
      do Result<&2, &2, C.Failure, ScannedString>:
        next : StringScan <- string_step(b, scan)
        string_scan(t, next)

type NumberPhase is Data:
  NumberStart{}
  NumberSign{}
  NumberZero{}
  NumberInteger{}
  NumberDot{}
  NumberFraction{}
  NumberExponent{}
  NumberExponentSign{}
  NumberExponentDigits{}

type NumberState is Data:
  NumberState{phase: NumberPhase, exponent: U32}

def number_digit(+b: U32, phase: NumberPhase) -> Result<&2, &2, C.Failure, NumberState>:
  do Result<&2, &2, C.Failure, NumberState>:
    C.require(between(b, 48, 57), C.InvalidJson{})
    return NumberState{phase, 0}

def number_integer_digit(+b: U32) -> Result<&2, &2, C.Failure, NumberState>:
  do Result<&2, &2, C.Failure, NumberState>:
    C.require(between(b, 48, 57), C.InvalidJson{})
    return NumberState{Bool.pick(NumberPhase, U32.is_eq(b, 48), NumberZero{}, NumberInteger{}), 0}

def exponent_digit(+b: U32, exponent: U32) -> Result<&2, &2, C.Failure, NumberState>:
  do Result<&2, &2, C.Failure, NumberState>:
    C.require(between(b, 48, 57), C.InvalidJson{})
    +next : U32 = (exponent * 10 + b - 48 : U32)
    C.require((next <= 10000 : U32), C.InvalidValue{})
    return NumberState{NumberExponentDigits{}, next}

def number_step(+b: U32, state: NumberState) -> Result<&2, &2, C.Failure, NumberState>:
  match state:
    case NumberState{NumberStart{}, e}:
      C.choose(Result<&2, &2, C.Failure, NumberState>, U32.is_eq(b, 45),
        _ => Done{NumberState{NumberSign{}, 0}}, _ => number_integer_digit(b))
    case NumberState{NumberSign{}, e}:
      number_integer_digit(b)
    case NumberState{NumberZero{}, e}:
      C.choose(Result<&2, &2, C.Failure, NumberState>, U32.is_eq(b, 46),
        _ => Done{NumberState{NumberDot{}, 0}},
        _ => do Result<&2, &2, C.Failure, NumberState>:
          C.require(Bool.or(U32.is_eq(b, 101), U32.is_eq(b, 69)), C.InvalidJson{})
          return NumberState{NumberExponent{}, 0})
    case NumberState{NumberInteger{}, e}:
      C.choose(Result<&2, &2, C.Failure, NumberState>, between(b, 48, 57),
        _ => Done{NumberState{NumberInteger{}, 0}},
        _ => C.choose(Result<&2, &2, C.Failure, NumberState>, U32.is_eq(b, 46),
          _ => Done{NumberState{NumberDot{}, 0}},
          _ => do Result<&2, &2, C.Failure, NumberState>:
            C.require(Bool.or(U32.is_eq(b, 101), U32.is_eq(b, 69)), C.InvalidJson{})
            return NumberState{NumberExponent{}, 0}))
    case NumberState{NumberDot{}, e}:
      number_digit(b, NumberFraction{})
    case NumberState{NumberFraction{}, e}:
      C.choose(Result<&2, &2, C.Failure, NumberState>, between(b, 48, 57),
        _ => Done{NumberState{NumberFraction{}, 0}},
        _ => do Result<&2, &2, C.Failure, NumberState>:
          C.require(Bool.or(U32.is_eq(b, 101), U32.is_eq(b, 69)), C.InvalidJson{})
          return NumberState{NumberExponent{}, 0})
    case NumberState{NumberExponent{}, e}:
      C.choose(Result<&2, &2, C.Failure, NumberState>, Bool.or(U32.is_eq(b, 43), U32.is_eq(b, 45)),
        _ => Done{NumberState{NumberExponentSign{}, 0}}, _ => exponent_digit(b, 0))
    case NumberState{NumberExponentSign{}, e}:
      exponent_digit(b, 0)
    case NumberState{NumberExponentDigits{}, e}:
      exponent_digit(b, e)

def number_end(state: NumberState) -> Result<&2, &2, C.Failure, Unit>:
  match state:
    case NumberState{NumberZero{}, e}:
      Done{Unit{}}
    case NumberState{NumberInteger{}, e}:
      Done{Unit{}}
    case NumberState{NumberFraction{}, e}:
      Done{Unit{}}
    case NumberState{NumberExponentDigits{}, e}:
      Done{Unit{}}
    case _:
      Fail{C.failure(C.InvalidJson{})}

def number_walk(s: String, state: NumberState, +left: U32) -> Result<&2, &2, C.Failure, Unit>:
  match s:
    case SNil{}:
      number_end(state)
    case SCon{Chr{b}, t}:
      do Result<&2, &2, C.Failure, Unit>:
        C.require((left > 0 : U32), C.InvalidValue{})
        next : NumberState <- number_step(b, state)
        number_walk(t, next, (left - 1 : U32))

def number_char(+b: U32) -> Bool:
  Bool.or(between(b, 48, 57), Bool.or(U32.is_eq(b, 45),
    Bool.or(U32.is_eq(b, 43), Bool.or(U32.is_eq(b, 46),
      Bool.or(U32.is_eq(b, 101), U32.is_eq(b, 69))))))

def number_scan(xs: List<&2, U32>, +acc: String, +count: U32) -> Result<&2, &2, C.Failure, ScannedString>:
  match xs:
    case Nil{}:
      Done{ScannedString{String.reverse(acc), Nil{}}}
    case Con{+b, +t}:
      C.choose(Result<&2, &2, C.Failure, ScannedString>, number_char(b),
        _ => do Result<&2, &2, C.Failure, ScannedString>:
          C.require((count < 128 : U32), C.InvalidValue{})
          number_scan(t, SCon{Chr{b}, acc}, (count + 1 : U32)),
        _ => Done{ScannedString{String.reverse(acc), Con{b, t}}})

type Token is Data:
  TNull{}
  TBool{value: Bool}
  TNumber{raw: String}
  TString{value: String}
  TArray{}
  TArrayEnd{}
  TObject{}
  TObjectEnd{}
  TComma{}
  TColon{}
  TEnd{}

type ScannedToken is Data:
  ScannedToken{token: Token, rest: List<&2, U32>}

def string_token(s: ScannedString) -> ScannedToken:
  match s:
    case ScannedString{v, rest}:
      ScannedToken{TString{v}, rest}

def number_token(s: ScannedString) -> Result<&2, &2, C.Failure, ScannedToken>:
  match s:
    case ScannedString{+v, rest}:
      do Result<&2, &2, C.Failure, ScannedToken>:
        number_walk(v, NumberState{NumberStart{}, 0}, 128)
        return ScannedToken{TNumber{v}, rest}

def literal(xs: List<&2, U32>, text: String, token: Token) -> Result<&2, &2, C.Failure, ScannedToken>:
  match xs text:
    case rest SNil{}:
      Done{ScannedToken{token, rest}}
    case Con{b, t} SCon{Chr{c}, chars}:
      do Result<&2, &2, C.Failure, ScannedToken>:
        C.require(U32.is_eq(b, c), C.InvalidJson{})
        literal(t, chars, token)
    case _ _:
      Fail{C.failure(C.InvalidJson{})}

def whitespace(xs: List<&2, U32>) -> List<&2, U32>:
  match xs:
    case Con{32, t}:
      whitespace(t)
    case Con{9, t}:
      whitespace(t)
    case Con{10, t}:
      whitespace(t)
    case Con{13, t}:
      whitespace(t)
    case rest:
      rest

def lex(xs: List<&2, U32>, keep: Bool) -> Result<&2, &2, C.Failure, ScannedToken>:
  match xs:
    case Nil{}:
      Done{ScannedToken{TEnd{}, Nil{}}}
    case Con{34, t}:
      do Result<&2, &2, C.Failure, ScannedToken>:
        s : ScannedString <- string_scan(t, StringScan{StringText{}, "", keep})
        return string_token(s)
    case Con{91, t}:
      Done{ScannedToken{TArray{}, t}}
    case Con{93, t}:
      Done{ScannedToken{TArrayEnd{}, t}}
    case Con{123, t}:
      Done{ScannedToken{TObject{}, t}}
    case Con{125, t}:
      Done{ScannedToken{TObjectEnd{}, t}}
    case Con{44, t}:
      Done{ScannedToken{TComma{}, t}}
    case Con{58, t}:
      Done{ScannedToken{TColon{}, t}}
    case Con{110, t}:
      literal(t, "ull", TNull{})
    case Con{116, t}:
      literal(t, "rue", TBool{True{}})
    case Con{102, t}:
      literal(t, "alse", TBool{False{}})
    case Con{+b, t}:
      do Result<&2, &2, C.Failure, ScannedToken>:
        C.require(Bool.or(U32.is_eq(b, 45), between(b, 48, 57)), C.InvalidJson{})
        s : ScannedString <- number_scan(Con{b, t}, "", 0)
        number_token(s)

type Expect is Data:
  Value{}
  ArrayFirst{}
  ArrayAfter{}
  ObjectFirst{}
  ObjectKey{}
  ObjectColon{}
  ObjectAfter{}
  RootEnd{}

type Frame is Data:
  ArrayFrame{items: List<&2, C.Json>}
  ObjectFrame{members: List<&2, C.Member>, keys: Set(), key: String}

type Parser is Data:
  Parser{expect: Expect, frames: List<&2, Frame>, root: C.Json, values_left: U32, depth_left: U32, build: Bool}

type ParseStep is Data:
  Parsing{bytes: List<&2, U32>, parser: Parser}
  Parsed{value: C.Json}

def reserve_value(parser: Parser) -> Result<&2, &2, C.Failure, Parser>:
  match parser:
    case Parser{e, frames, root, +values, +depth, build}:
      do Result<&2, &2, C.Failure, Parser>:
        C.require(Bool.and((values > 0 : U32), (depth > 0 : U32)), C.ResourceLimit{})
        return Parser{e, frames, root, (values - 1 : U32), depth, build}

def value_start(+b: U32) -> Bool:
  Bool.or(between(b, 48, 57), Bool.or(U32.is_eq(b, 45),
    Bool.or(U32.is_eq(b, 34), Bool.or(U32.is_eq(b, 91),
      Bool.or(U32.is_eq(b, 123), Bool.or(U32.is_eq(b, 110),
        Bool.or(U32.is_eq(b, 116), U32.is_eq(b, 102))))))))

def reserve(+parser: Parser, bytes: List<&2, U32>) -> Result<&2, &2, C.Failure, Parser>:
  match parser bytes:
    case Parser{Value{}, frames, root, values, depth, build} Con{b, t}:
      C.choose(Result<&2, &2, C.Failure, Parser>, value_start(b),
        _ => reserve_value(Parser{Value{}, frames, root, values, depth, build}),
        _ => Done{Parser{Value{}, frames, root, values, depth, build}})
    case Parser{ArrayFirst{}, frames, root, values, depth, build} Con{b, t}:
      C.choose(Result<&2, &2, C.Failure, Parser>, value_start(b),
        _ => reserve_value(Parser{ArrayFirst{}, frames, root, values, depth, build}),
        _ => Done{Parser{ArrayFirst{}, frames, root, values, depth, build}})
    case p _:
      Done{p}

def token_keep(parser: Parser) -> Bool:
  match parser:
    case Parser{ObjectFirst{}, frames, root, values, depth, build}:
      True{}
    case Parser{ObjectKey{}, frames, root, values, depth, build}:
      True{}
    case Parser{e, frames, root, values, depth, build}:
      build

def array_add(build: Bool, value: C.Json, xs: List<&2, C.Json>) -> List<&2, C.Json>:
  match build:
    case True{}:
      Con{value, xs}
    case False{}:
      xs

def object_add(build: Bool, key: String, value: C.Json, xs: List<&2, C.Member>) -> List<&2, C.Member>:
  match build:
    case True{}:
      Con{C.Member{key, value}, xs}
    case False{}:
      xs

def accept(value: C.Json, parser: Parser) -> Parser:
  match parser:
    case Parser{e, Nil{}, root, values, depth, build}:
      Parser{RootEnd{}, Nil{}, value, values, depth, build}
    case Parser{e, Con{ArrayFrame{xs}, t}, root, values, depth, +build}:
      Parser{ArrayAfter{}, Con{ArrayFrame{array_add(build, value, xs)}, t}, root, values, depth, build}
    case Parser{e, Con{ObjectFrame{xs, keys, key}, t}, root, values, depth, +build}:
      Parser{ObjectAfter{}, Con{ObjectFrame{object_add(build, key, value, xs), keys, ""}, t}, root, values, depth, build}

def start_value(token: Token, parser: Parser) -> Result<&2, &2, C.Failure, Parser>:
  match token parser:
    case TNull{} p:
      Done{accept(C.JNull{}, p)}
    case TBool{b} p:
      Done{accept(C.JBool{b}, p)}
    case TNumber{raw} p:
      Done{accept(C.JNum{raw}, p)}
    case TString{s} p:
      Done{accept(C.JStr{s}, p)}
    case TArray{} Parser{e, frames, root, values, depth, build}:
      Done{Parser{ArrayFirst{}, Con{ArrayFrame{Nil{}}, frames}, root, values, (depth - 1 : U32), build}}
    case TObject{} Parser{e, frames, root, values, depth, build}:
      Done{Parser{ObjectFirst{}, Con{ObjectFrame{Nil{}, Set.new(), ""}, frames}, root, values, (depth - 1 : U32), build}}
    case _ _:
      Fail{C.failure(C.InvalidJson{})}

def close_array(parser: Parser) -> Result<&2, &2, C.Failure, Parser>:
  match parser:
    case Parser{e, Con{ArrayFrame{xs}, t}, root, values, depth, build}:
      Done{accept(C.JArr{List.reverse(&2, C.Json, xs)}, Parser{e, t, root, values, (depth + 1 : U32), build})}
    case _:
      Fail{C.failure(C.InvalidJson{})}

def close_object(parser: Parser) -> Result<&2, &2, C.Failure, Parser>:
  match parser:
    case Parser{e, Con{ObjectFrame{xs, keys, key}, t}, root, values, depth, build}:
      Done{accept(C.JObj{List.reverse(&2, C.Member, xs)}, Parser{e, t, root, values, (depth + 1 : U32), build})}
    case _:
      Fail{C.failure(C.InvalidJson{})}

def object_key_found(found: Set() & Bool, +key: String, xs: List<&2, C.Member>, t: List<&2, Frame>, root: C.Json, values: U32, depth: U32, build: Bool) -> Result<&2, &2, C.Failure, Parser>:
  match found:
    case Tuple{keys, exists}:
      do Result<&2, &2, C.Failure, Parser>:
        C.require(Bool.not(exists), C.InvalidJson{})
        return Parser{ObjectColon{}, Con{ObjectFrame{xs, Set.add(keys, key), key}, t}, root, values, depth, build}

def object_key(+key: String, parser: Parser) -> Result<&2, &2, C.Failure, Parser>:
  match parser:
    case Parser{e, Con{ObjectFrame{xs, keys, old}, t}, root, values, depth, build}:
      object_key_found(Set.has(keys, key), key, xs, t, root, values, depth, build)
    case _:
      Fail{C.failure(C.InvalidJson{})}

def advance(token: Token, parser: Parser) -> Result<&2, &2, C.Failure, Parser>:
  match token parser:
    case TArrayEnd{} Parser{ArrayFirst{}, frames, root, values, depth, build}:
      close_array(Parser{ArrayFirst{}, frames, root, values, depth, build})
    case t Parser{Value{}, frames, root, values, depth, build}:
      start_value(t, Parser{Value{}, frames, root, values, depth, build})
    case t Parser{ArrayFirst{}, frames, root, values, depth, build}:
      start_value(t, Parser{ArrayFirst{}, frames, root, values, depth, build})
    case TObjectEnd{} Parser{ObjectFirst{}, frames, root, values, depth, build}:
      close_object(Parser{ObjectFirst{}, frames, root, values, depth, build})
    case TString{key} Parser{ObjectFirst{}, frames, root, values, depth, build}:
      object_key(key, Parser{ObjectFirst{}, frames, root, values, depth, build})
    case TString{key} Parser{ObjectKey{}, frames, root, values, depth, build}:
      object_key(key, Parser{ObjectKey{}, frames, root, values, depth, build})
    case TColon{} Parser{ObjectColon{}, frames, root, values, depth, build}:
      Done{Parser{Value{}, frames, root, values, depth, build}}
    case TComma{} Parser{ArrayAfter{}, frames, root, values, depth, build}:
      Done{Parser{Value{}, frames, root, values, depth, build}}
    case TArrayEnd{} Parser{ArrayAfter{}, frames, root, values, depth, build}:
      close_array(Parser{ArrayAfter{}, frames, root, values, depth, build})
    case TComma{} Parser{ObjectAfter{}, frames, root, values, depth, build}:
      Done{Parser{ObjectKey{}, frames, root, values, depth, build}}
    case TObjectEnd{} Parser{ObjectAfter{}, frames, root, values, depth, build}:
      close_object(Parser{ObjectAfter{}, frames, root, values, depth, build})
    case _ _:
      Fail{C.failure(C.InvalidJson{})}

def next_step(scanned: ScannedToken, parser: Parser) -> Result<&2, &2, C.Failure, ParseStep>:
  match scanned parser:
    case ScannedToken{TEnd{}, bytes} Parser{RootEnd{}, Nil{}, root, values, depth, build}:
      Done{Parsed{root}}
    case ScannedToken{token, rest} p:
      do Result<&2, &2, C.Failure, ParseStep>:
        next : Parser <- advance(token, p)
        return Parsing{rest, next}

def parse_loop(fuel: Nat, step: ParseStep) -> Result<&2, &2, C.Failure, C.Json>:
  match fuel step:
    case _ Parsed{value}:
      Done{value}
    case 0n _:
      Fail{C.failure(C.ResourceLimit{})}
    case 1n+p Parsing{bytes, parser}:
      do Result<&2, &2, C.Failure, C.Json>:
        +trimmed : List<&2, U32> = whitespace(bytes)
        +ready : Parser <- reserve(parser, trimmed)
        scanned : ScannedToken <- lex(trimmed, token_keep(ready))
        next : ParseStep <- next_step(scanned, ready)
        parse_loop(p, next)

def parse_pass(bytes: List<&2, U32>, count: U32, budget: C.Budget, build: Bool) -> Result<&2, &2, C.Failure, C.Json>:
  match budget:
    case C.Budget{max_bytes, values, depth, changes, work}:
      parse_loop(2n+U32.to_nat(count), Parsing{bytes, Parser{Value{}, Nil{}, C.JMissing{}, values, depth, build}})

def preflight(+bytes: List<&2, U32>, budget: C.Budget) -> Result<&2, &2, C.Failure, U32>:
  match budget:
    case C.Budget{+max_bytes, values, depth, changes, work}:
      do Result<&2, &2, C.Failure, U32>:
        +count : U32 <- bytes_count(bytes, max_bytes, 0)
        utf_check(bytes, Utf{0n, 0, 128, 191})
        value : C.Json <- parse_pass(bytes, count, C.Budget{max_bytes, values, depth, changes, work}, False{})
        return count

def check(bytes: List<&2, U32>, budget: C.Budget) -> Result<&2, &2, C.Failure, Unit>:
  do Result<&2, &2, C.Failure, Unit>:
    count : U32 <- preflight(bytes, budget)
    return Unit{}

def parse(+bytes: List<&2, U32>, +budget: C.Budget) -> Result<&2, &2, C.Failure, C.Json>:
  do Result<&2, &2, C.Failure, C.Json>:
    count : U32 <- preflight(bytes, budget)
    parse_pass(bytes, count, budget, True{})

type Measure is Data:
  Measure{bytes_left: U32, values_left: U32}

def measure_add(+amount: U32, state: Measure) -> Result<&2, &2, C.Failure, Measure>:
  match state:
    case Measure{+bytes, values}:
      do Result<&2, &2, C.Failure, Measure>:
        C.require((amount <= bytes : U32), C.PayloadTooLarge{})
        return Measure{(bytes - amount : U32), values}

def measure_begin(entering: Bool, depth: U32, state: Measure, overhead: U32) -> Result<&2, &2, C.Failure, Measure>:
  match entering state:
    case False{} s:
      Done{s}
    case True{} Measure{bytes, +values}:
      do Result<&2, &2, C.Failure, Measure>:
        C.require(Bool.and((values > 0 : U32), (depth > 0 : U32)), C.ResourceLimit{})
        measure_add(overhead, Measure{bytes, (values - 1 : U32)})

def scalar_bytes(+x: U32) -> U32:
  Bool.pick(U32, (x < 32 : U32),
    Bool.pick(U32, Bool.or(U32.is_eq(x, 8), Bool.or(U32.is_eq(x, 9),
      Bool.or(U32.is_eq(x, 10), Bool.or(U32.is_eq(x, 12), U32.is_eq(x, 13))))), 2, 6),
    Bool.pick(U32, Bool.or(U32.is_eq(x, 34), U32.is_eq(x, 92)), 2,
      Bool.pick(U32, (x < 128 : U32), 1,
        Bool.pick(U32, (x < 2048 : U32), 2, Bool.pick(U32, (x < 65536 : U32), 3, 4)))))

def measure_string(s: String, state: Measure) -> Result<&2, &2, C.Failure, Measure>:
  match s:
    case SNil{}:
      Done{state}
    case SCon{Chr{+x}, t}:
      do Result<&2, &2, C.Failure, Measure>:
        C.require(scalar_valid(x), C.InvalidValue{})
        next : Measure <- measure_add(scalar_bytes(x), state)
        measure_string(t, next)

def writer_number(result: Result<&2, &2, C.Failure, Unit>) -> Result<&2, &2, C.Failure, Unit>:
  match result:
    case Done{value}:
      Done{value}
    case Fail{failure}:
      Fail{C.failure(C.InvalidValue{})}

def measure_raw(s: String, state: Measure) -> Result<&2, &2, C.Failure, Measure>:
  match s:
    case SNil{}:
      Done{state}
    case SCon{h, t}:
      do Result<&2, &2, C.Failure, Measure>:
        next : Measure <- measure_add(1, state)
        measure_raw(t, next)

def unique_found(found: Set() & Bool, key: String) -> Result<&2, &2, C.Failure, Set()>:
  match found:
    case Tuple{keys, exists}:
      do Result<&2, &2, C.Failure, Set()>:
        C.require(Bool.not(exists), C.InvalidValue{})
        return Set.add(keys, key)

def unique_key(+key: String, keys: Set()) -> Result<&2, &2, C.Failure, Set()>:
  unique_found(Set.has(keys, key), key)

def comma_size(a, -A: Kind(a), xs: List<a, A>) -> U32:
  match xs:
    case Nil{}:
      0
    case Con{h, t}:
      1

def measure(value: C.Json, entering: Bool, +depth: U32, state: Measure, keys: Set()) -> Result<&2, &2, C.Failure, Measure>:
  match value:
    case C.JMissing{}:
      do Result<&2, &2, C.Failure, Measure>:
        next : Measure <- measure_begin(entering, depth, state, 0)
        Fail{C.failure(C.InvalidValue{})}
    case C.JNull{}:
      measure_begin(entering, depth, state, 4)
    case C.JBool{b}:
      measure_begin(entering, depth, state, Bool.pick(U32, b, 4, 5))
    case C.JNum{+raw}:
      do Result<&2, &2, C.Failure, Measure>:
        next : Measure <- measure_begin(entering, depth, state, 0)
        writer_number(number_walk(raw, NumberState{NumberStart{}, 0}, 128))
        measure_raw(raw, next)
    case C.JStr{s}:
      do Result<&2, &2, C.Failure, Measure>:
        next : Measure <- measure_begin(entering, depth, state, 2)
        measure_string(s, next)
    case C.JArr{Nil{}}:
      measure_begin(entering, depth, state, 2)
    case C.JArr{Con{h, +t}}:
      do Result<&2, &2, C.Failure, Measure>:
        next : Measure <- measure_begin(entering, depth, state, 2)
        child : Measure <- measure(h, True{}, (depth - 1 : U32), next, Set.new())
        separated : Measure <- measure_add(comma_size(&2, C.Json, t), child)
        measure(C.JArr{t}, False{}, depth, separated, Set.new())
    case C.JObj{Nil{}}:
      measure_begin(entering, depth, state, 2)
    case C.JObj{Con{C.Member{+key, v}, +t}}:
      do Result<&2, &2, C.Failure, Measure>:
        next : Measure <- measure_begin(entering, depth, state, 2)
        quoted : Measure <- measure_add(2, next)
        named : Measure <- measure_string(key, quoted)
        colon : Measure <- measure_add(1, named)
        unique : Set() <- unique_key(key, keys)
        child : Measure <- measure(v, True{}, (depth - 1 : U32), colon, Set.new())
        separated : Measure <- measure_add(comma_size(&2, C.Member, t), child)
        measure(C.JObj{t}, False{}, depth, separated, unique)

def hex_ascii(+x: U32) -> U32:
  (x + Bool.pick(U32, (x < 10 : U32), 48, 87) : U32)

def emit_char(+x: U32, +acc: List<&2, U32>) -> List<&2, U32>:
  C.choose(List<&2, U32>, Bool.or(U32.is_eq(x, 34), U32.is_eq(x, 92)),
    _ => Con{x, Con{92, acc}},
    _ => C.choose(List<&2, U32>, (x < 32 : U32),
      _ => C.choose(List<&2, U32>, Bool.or(U32.is_eq(x, 8), Bool.or(U32.is_eq(x, 9),
        Bool.or(U32.is_eq(x, 10), Bool.or(U32.is_eq(x, 12), U32.is_eq(x, 13))))),
        _ => Con{Bool.pick(U32, U32.is_eq(x, 8), 98,
          Bool.pick(U32, U32.is_eq(x, 9), 116,
          Bool.pick(U32, U32.is_eq(x, 10), 110,
          Bool.pick(U32, U32.is_eq(x, 12), 102, 114)))), Con{92, acc}},
        _ => Con{hex_ascii((x % 16 : U32)), Con{hex_ascii((x / 16 : U32)), Con{48, Con{48, Con{117, Con{92, acc}}}}}}),
      _ => C.choose(List<&2, U32>, (x < 128 : U32),
        _ => Con{x, acc},
        _ => C.choose(List<&2, U32>, (x < 2048 : U32),
          _ => Con{(128 + x % 64 : U32), Con{(192 + x / 64 : U32), acc}},
          _ => C.choose(List<&2, U32>, (x < 65536 : U32),
            _ => Con{(128 + x % 64 : U32), Con{(128 + x / 64 % 64 : U32), Con{(224 + x / 4096 : U32), acc}}},
            _ => Con{(128 + x % 64 : U32), Con{(128 + x / 64 % 64 : U32),
              Con{(128 + x / 4096 % 64 : U32), Con{(240 + x / 262144 : U32), acc}}}})))))

def emit_string(s: String, acc: List<&2, U32>) -> List<&2, U32>:
  match s:
    case SNil{}:
      Con{34, acc}
    case SCon{Chr{x}, t}:
      emit_string(t, emit_char(x, acc))

def emit_raw(s: String, acc: List<&2, U32>) -> List<&2, U32>:
  match s:
    case SNil{}:
      acc
    case SCon{Chr{x}, t}:
      emit_raw(t, Con{x, acc})

def emit(value: C.Json, entering: Bool, +acc: List<&2, U32>) -> List<&2, U32>:
  match value:
    case C.JMissing{}:
      acc
    case C.JNull{}:
      Con{108, Con{108, Con{117, Con{110, acc}}}}
    case C.JBool{b}:
      Bool.pick(List<&2, U32>, b,
        Con{101, Con{117, Con{114, Con{116, acc}}}},
        Con{101, Con{115, Con{108, Con{97, Con{102, acc}}}}})
    case C.JNum{raw}:
      emit_raw(raw, acc)
    case C.JStr{s}:
      emit_string(s, Con{34, acc})
    case C.JArr{Nil{}}:
      Con{93, Bool.pick(List<&2, U32>, entering, Con{91, acc}, acc)}
    case C.JArr{Con{h, +t}}:
      +child = emit(h, True{}, Bool.pick(List<&2, U32>, entering, Con{91, acc}, acc))
      emit(C.JArr{t}, False{}, Bool.pick(List<&2, U32>, U32.is_eq(comma_size(&2, C.Json, t), 1), Con{44, child}, child))
    case C.JObj{Nil{}}:
      Con{125, Bool.pick(List<&2, U32>, entering, Con{123, acc}, acc)}
    case C.JObj{Con{C.Member{key, v}, +t}}:
      named = emit_string(key, Con{34, Bool.pick(List<&2, U32>, entering, Con{123, acc}, acc)})
      +child = emit(v, True{}, Con{58, named})
      emit(C.JObj{t}, False{}, Bool.pick(List<&2, U32>, U32.is_eq(comma_size(&2, C.Member, t), 1), Con{44, child}, child))

def encode(+value: C.Json, budget: C.Budget) -> Result<&2, &2, C.Failure, List<&2, U32>>:
  match budget:
    case C.Budget{bytes, values, depth, changes, work}:
      do Result<&2, &2, C.Failure, List<&2, U32>>:
        measured : Measure <- measure(value, True{}, depth, Measure{bytes, values}, Set.new())
        return List.reverse(&2, U32, emit(value, True{}, Nil{}))
