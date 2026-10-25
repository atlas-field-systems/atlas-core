import Base
import ./common.bend as C

type Instant is Data:
  Instant{seconds: Nat, nanoseconds: U32}

def between(+n: U32, low: U32, high: U32) -> Bool:
  U32.is_ge(n, low) && U32.is_le(n, high)

def character(value: Maybe<&2, Char>) -> U32:
  match value:
    case Some{x}:
      Char.to_u32(x)
    case None{}:
      0

def at(text: String, index: U32) -> U32:
  character(String.get(text, U32.to_nat(index)))

def well_formed(text: String) -> Bool:
  match text:
    case SNil{}:
      True{}
    case SCon{h, t}:
      +n = Char.to_u32(h)
      U32.is_le(n, 1114111) && Bool.not(between(n, 55296, 57343)) && well_formed(t)

def whitespace(+code: U32) -> Bool:
  between(code, 9, 13) || U32.is_eq(code, 32) || U32.is_eq(code, 133) ||
    U32.is_eq(code, 160) || U32.is_eq(code, 5760) || between(code, 8192, 8202) ||
    U32.is_eq(code, 8232) || U32.is_eq(code, 8233) || U32.is_eq(code, 8239) ||
    U32.is_eq(code, 8287) || U32.is_eq(code, 12288)

def nonblank(text: String) -> Bool:
  match text:
    case SNil{}:
      False{}
    case SCon{h, t}:
      Bool.not(whitespace(Char.to_u32(h))) || nonblank(t)

def digit(code: U32) -> Bool:
  between(code, 48, 57)

def hex(+code: U32) -> Bool:
  digit(code) || between(code, 97, 102)

def digits(text: String) -> Bool:
  match text:
    case SNil{}:
      True{}
    case SCon{h, t}:
      digit(Char.to_u32(h)) && digits(t)

def hex_text(text: String) -> Bool:
  match text:
    case SNil{}:
      True{}
    case SCon{h, t}:
      hex(Char.to_u32(h)) && hex_text(t)

def uuid_chars(text: String, +index: U32) -> Bool:
  match text:
    case SNil{}:
      U32.is_eq(index, 36)
    case SCon{h, t}:
      +code = Char.to_u32(h)
      expected_dash = U32.is_eq(index, 8) || U32.is_eq(index, 13) || U32.is_eq(index, 18) || U32.is_eq(index, 23)
      Bool.pick(Bool, expected_dash, U32.is_eq(code, 45), hex(code)) &&
        uuid_chars(t, (index + 1 : U32))

def uuid(text: String) -> Bool:
  uuid_chars(text, 0)

def new_id(+text: String) -> Bool:
  uuid(text) && U32.is_eq(at(text, 14), 52) &&
    (between(at(text, 19), 56, 57) || between(at(text, 19), 97, 98))

def decimal_order(+a: String, +b: String) -> Cmp:
  +x = String.length(a)
  +y = String.length(b)
  C.choose(Cmp, Nat.is_eq(x, y), _ => String.order(a, b), _ => Nat.cmp(x, y))

def counter(+text: String, maximum: String, positive: Bool) -> Bool:
  Bool.not(String.is_empty(text)) && digits(text) &&
    (U32.is_ne(at(text, 0), 48) || String.eq(text, "0")) &&
    (Bool.not(positive) || Bool.not(String.eq(text, "0"))) &&
    Bool.not(Cmp.is_gt(decimal_order(text, maximum)))

def base64url(text: String) -> Bool:
  match text:
    case SNil{}:
      True{}
    case SCon{h, t}:
      +c = Char.to_u32(h)
      (between(c, 65, 90) || between(c, 97, 122) || digit(c) ||
        U32.is_eq(c, 45) || U32.is_eq(c, 95)) && base64url(t)

def secret(+text: String) -> Bool:
  Nat.is_eq(String.length(text), 43n) && base64url(text) &&
    String.contains("AEIMQUYcgkosw048", String.drop(text, 42n))

def sha256(+text: String) -> Bool:
  Nat.is_eq(String.length(text), 64n) && hex_text(text)

def token_chars(text: String) -> Bool:
  match text:
    case SNil{}:
      False{}
    case SCon{+h, +t}:
      +c = Char.to_u32(h)
      allowed = between(c, 65, 90) || between(c, 97, 122) || digit(c) ||
        String.contains("!#$%&'*+.^_`|~-", String.from_list([h]))
      allowed && C.choose(Bool, String.is_empty(t), _ => True{}, _ => token_chars(t))

def media_parts(parts: List<&2, String>) -> Bool:
  match parts:
    case Con{a, Con{b, Nil{}}}:
      token_chars(a) && token_chars(b)
    case _:
      False{}

def content_type(+text: String) -> Bool:
  Nat.is_le(String.length(text), 255n) && media_parts(String.split(text, '/'))

def leap(+year: U32) -> Bool:
  U32.is_zero((year % 4 : U32)) &&
    (U32.is_ne((year % 100 : U32), 0) || U32.is_zero((year % 400 : U32)))

def month_days(+year: U32, +month: U32) -> U32:
  C.choose(U32, U32.is_eq(month, 2),
    _ => Bool.pick(U32, leap(year), 29, 28),
    _ => Bool.pick(U32, U32.is_eq(month, 4) || U32.is_eq(month, 6) ||
      U32.is_eq(month, 9) || U32.is_eq(month, 11), 30, 31))

def prior_month_days(count: Nat, +year: U32, +month: U32, total: U32) -> U32:
  match count:
    case 0n:
      total
    case 1n+p:
      prior_month_days(p, year, (month + 1 : U32), (total + month_days(year, month) : U32))

def component(+text: String, offset: Nat, +count: Nat) -> Maybe<&2, U32>:
  +part = String.take(String.drop(text, offset), count)
  C.choose(Maybe<&2, U32>, Nat.is_eq(String.length(part), count) && digits(part),
    _ => U32.read(part), _ => None{})

def fraction(+text: String, +length: U32) -> Maybe<&2, U32>:
  C.choose(Maybe<&2, U32>, U32.is_eq(length, 20), _ => Some{0},
    _ => do Maybe<&2, U32>:
      value : U32 <- component(text, 20n, U32.to_nat((length - 21 : U32)))
      return (value * U32.pow(10, U32.to_nat((30 - length : U32))) : U32))

def make_instant(+year: U32, month: U32, day: U32, hour: U32, minute: U32, second: U32, nanos: U32) -> Instant:
  +prior = (year - 1 : U32)
  days = (365 * prior + (prior / 4 : U32) - (prior / 100 : U32) + (prior / 400 : U32) +
    prior_month_days(U32.to_nat((month - 1 : U32)), year, 1, 0) + day - 1 : U32)
  seconds = Nat.add(Nat.mul(U32.to_nat(days), 86400n), U32.to_nat((hour * 3600 + minute * 60 + second : U32)))
  Instant{seconds, nanos}

def timestamp(+text: String) -> Maybe<&2, Instant>:
  +length = U32.from_nat(String.length(text))
  punctuation = U32.is_eq(at(text, 4), 45) && U32.is_eq(at(text, 7), 45) &&
    U32.is_eq(at(text, 10), 84) && U32.is_eq(at(text, 13), 58) && U32.is_eq(at(text, 16), 58) &&
    U32.is_eq(at(text, (length - 1 : U32)), 90) &&
    (U32.is_eq(length, 20) || (between(length, 22, 30) && U32.is_eq(at(text, 19), 46)))
  C.choose(Maybe<&2, Instant>, punctuation,
    _ => do Maybe<&2, Instant>:
      +year : U32 <- component(text, 0n, 4n)
      +month : U32 <- component(text, 5n, 2n)
      +day : U32 <- component(text, 8n, 2n)
      +hour : U32 <- component(text, 11n, 2n)
      +minute : U32 <- component(text, 14n, 2n)
      +second : U32 <- component(text, 17n, 2n)
      nanos : U32 <- fraction(text, length)
      C.choose(Maybe<&2, Instant>, between(year, 1, 9999) && between(month, 1, 12) &&
        between(day, 1, month_days(year, month)) && U32.is_le(hour, 23) &&
        U32.is_le(minute, 59) && U32.is_le(second, 59),
        _ => Some{make_instant(year, month, day, hour, minute, second, nanos)}, _ => None{}),
    _ => None{})

def timestamp_valid(result: Maybe<&2, Instant>) -> Bool:
  match result:
    case Some{x}:
      True{}
    case None{}:
      False{}

def instant_le(a: Instant, b: Instant) -> Bool:
  match a b:
    case Instant{+as, an} Instant{+bs, bn}:
      Nat.is_lt(as, bs) || (Nat.is_eq(as, bs) && U32.is_le(an, bn))

def instant_lt(+a: Instant, +b: Instant) -> Bool:
  instant_le(a, b) && Bool.not(instant_le(b, a))

def ordered_result(a: Maybe<&2, Instant>, b: Maybe<&2, Instant>, inclusive: Bool) -> Bool:
  match a b:
    case Some{+x} Some{+y}:
      Bool.pick(Bool, inclusive, instant_le(x, y), instant_lt(x, y))
    case _ _:
      False{}

def ordered(a: String, b: String, inclusive: Bool) -> Bool:
  ordered_result(timestamp(a), timestamp(b), inclusive)

def advance(a: Instant, seconds: U32, nanos: U32) -> Instant:
  match a:
    case Instant{s, n}:
      +fraction = (n + nanos : U32)
      Instant{Nat.add(s, U32.to_nat((seconds + (fraction / 1000000000 : U32) : U32))),
        (fraction % 1000000000 : U32)}

def duration_result(a: Maybe<&2, Instant>, b: Maybe<&2, Instant>,
    low_seconds: U32, low_nanos: U32, high_seconds: U32, high_nanos: U32) -> Bool:
  match a b:
    case Some{+x} Some{+y}:
      instant_le(advance(x, low_seconds, low_nanos), y) &&
        instant_le(y, advance(x, high_seconds, high_nanos))
    case _ _:
      False{}

def duration(a: String, b: String, low_seconds: U32, low_nanos: U32,
    high_seconds: U32, high_nanos: U32) -> Bool:
  duration_result(timestamp(a), timestamp(b), low_seconds, low_nanos, high_seconds, high_nanos)

def scalar(+schema: C.Json, +text: String) -> Bool:
  well_formed(text) && (Bool.not(C.has(schema, "pattern")) || nonblank(text))
