import Base

# Little-endian radix-65536 limbs. Internal operations keep the top limb nonzero.
type Magnitude is Data:
  MagZero{}
  Limb{low: U32, rest: Magnitude}

# read returns binary64 * 2^1074. Arithmetic operates on these signed integers;
# a product therefore has scale 2^2148. A zero may retain its input sign.
type Exact is Data:
  Exact{negative: Bool, magnitude: Magnitude}

def mag_single_if(n: U32, empty: Bool) -> Magnitude:
  match empty:
    case True{}:
      MagZero{}
    case False{}:
      Limb{n, MagZero{}}

def mag_single(+n: U32) -> Magnitude:
  mag_single_if(n, U32.is_zero(n))

def mag_put(n: U32, rest: Magnitude) -> Magnitude:
  match rest:
    case MagZero{}:
      mag_single(n)
    case Limb{h, t}:
      Limb{n, Limb{h, t}}

def mag_zero(a: Magnitude) -> Bool:
  match a:
    case MagZero{}:
      True{}
    case Limb{h, t}:
      False{}

def mag_small_add(a: Magnitude, carry: U32) -> Magnitude:
  match a:
    case MagZero{}:
      mag_single(carry)
    case Limb{h, t}:
      +s = (h + carry : U32)
      mag_put((s .&. 65535 : U32), mag_small_add(t, U32.shrn(s, 16n)))

def mag_add(a: Magnitude, b: Magnitude, carry: U32) -> Magnitude:
  match a b:
    case MagZero{} _:
      mag_small_add(b, carry)
    case Limb{h, t} MagZero{}:
      +s = (h + carry : U32)
      mag_put((s .&. 65535 : U32), mag_small_add(t, U32.shrn(s, 16n)))
    case Limb{x, xs} Limb{y, ys}:
      +s = (x + y + carry : U32)
      mag_put((s .&. 65535 : U32), mag_add(xs, ys, U32.shrn(s, 16n)))

# The caller establishes a >= b. Wrapped U32 subtraction exposes the borrow.
def mag_sub(a: Magnitude, b: Magnitude, borrow: U32) -> Magnitude:
  match a b:
    case MagZero{} _:
      MagZero{}
    case Limb{x, xs} MagZero{}:
      +d = (x - borrow : U32)
      mag_put((d .&. 65535 : U32), mag_sub(xs, MagZero{}, U32.shrn(d, 31n)))
    case Limb{x, xs} Limb{y, ys}:
      +d = (x - y - borrow : U32)
      mag_put((d .&. 65535 : U32), mag_sub(xs, ys, U32.shrn(d, 31n)))

def mag_cmp_low(a: U32, b: U32, high: Cmp) -> Cmp:
  match high:
    case LT{}:
      LT{}
    case EQ{}:
      U32.cmp(a, b)
    case GT{}:
      GT{}

def mag_cmp(a: Magnitude, b: Magnitude) -> Cmp:
  match a b:
    case MagZero{} MagZero{}:
      EQ{}
    case MagZero{} Limb{h, t}:
      LT{}
    case Limb{h, t} MagZero{}:
      GT{}
    case Limb{x, xs} Limb{y, ys}:
      mag_cmp_low(x, y, mag_cmp(xs, ys))

# k and carry are at most 65535, so every intermediate fits in U32.
def mag_small_mul(a: Magnitude, +k: U32, carry: U32) -> Magnitude:
  match a:
    case MagZero{}:
      mag_single(carry)
    case Limb{h, t}:
      +s = (h * k + carry : U32)
      mag_put((s .&. 65535 : U32), mag_small_mul(t, k, U32.shrn(s, 16n)))

def mag_words(n: Nat, a: Magnitude) -> Magnitude:
  match n:
    case 0n:
      a
    case 1n+p:
      mag_put(0, mag_words(p, a))

def mag_mul(a: Magnitude, +b: Magnitude) -> Magnitude:
  match a:
    case MagZero{}:
      MagZero{}
    case Limb{h, t}:
      mag_add(mag_small_mul(b, h, 0), mag_put(0, mag_mul(t, b)), 0)

def mag_shl(+n: U32, a: Magnitude) -> Magnitude:
  mag_words(U32.to_nat(U32.shrn(n, 4n)),
    mag_small_mul(a, U32.shln(1, U32.to_nat((n .&. 15 : U32))), 0))

def mag_half_cell(+h: U32, pair: Magnitude & U32) -> Magnitude & U32:
  (q, carry) = pair
  (mag_put((U32.shr(h) + U32.shln(carry, 15n) : U32), q), (h .&. 1 : U32))

def mag_half(a: Magnitude) -> Magnitude & U32:
  match a:
    case MagZero{}:
      (MagZero{}, 0)
    case Limb{h, t}:
      mag_half_cell(h, mag_half(t))

def mag_half_value(pair: Magnitude & U32) -> Magnitude:
  (q, r) = pair
  q

def mag_drop_words(n: Nat, a: Magnitude) -> Magnitude:
  match n a:
    case 0n _:
      a
    case 1n+p MagZero{}:
      MagZero{}
    case 1n+p Limb{h, t}:
      mag_drop_words(p, t)

def mag_shr_bits(n: Nat, a: Magnitude) -> Magnitude:
  match n:
    case 0n:
      a
    case 1n+p:
      mag_half_value(mag_half(mag_shr_bits(p, a)))

def mag_shr(+n: U32, a: Magnitude) -> Magnitude:
  mag_shr_bits(U32.to_nat((n .&. 15 : U32)),
    mag_drop_words(U32.to_nat(U32.shrn(n, 4n)), a))

def mag_bits_cell(h: U32, tail_bits: U32) -> U32:
  match tail_bits:
    case U32{+w}:
      Bool.pick(U32, U32.is_zero(U32{w}),
        (U32.from_nat(U32.log2(h)) + 1 : U32), (U32{w} + 16 : U32))

def mag_bits(a: Magnitude) -> U32:
  match a:
    case MagZero{}:
      0
    case Limb{h, t}:
      mag_bits_cell(h, mag_bits(t))

def mag_odd(a: Magnitude) -> Bool:
  match a:
    case MagZero{}:
      False{}
    case Limb{h, t}:
      U32.is_ne((h .&. 1 : U32), 0)

def mag_u32(a: Magnitude) -> U32:
  match a:
    case MagZero{}:
      0
    case Limb{h, t}:
      h

def div_bit_choice(+r: Magnitude, +d: Magnitude, q: U32, c: Cmp) -> Magnitude & U32:
  match c:
    case LT{}:
      (r, q)
    case EQ{}:
      (MagZero{}, (q + 1 : U32))
    case GT{}:
      (mag_sub(r, d, 0), (q + 1 : U32))

def div_bits(n: Nat, +digit: U32, +d: Magnitude, state: Magnitude & U32) -> Magnitude & U32:
  match n:
    case 0n:
      state
    case 1n+ +p:
      (r, q) = state
      +next = mag_small_add(mag_small_mul(r, 2, 0), (U32.shrn(digit, p) .&. 1 : U32))
      div_bits(p, digit, d, div_bit_choice(next, d, U32.shl(q), mag_cmp(next, d)))

def div_cell_result(q: Magnitude, pair: Magnitude & U32) -> Magnitude & Magnitude:
  (next_r, digit) = pair
  (mag_put(digit, q), next_r)

def div_cell(h: U32, d: Magnitude, pair: Magnitude & Magnitude) -> Magnitude & Magnitude:
  (q, r) = pair
  div_cell_result(q, div_bits(16n, h, d, (r, 0)))

# Binary long division, sixteen input bits per limb. d is nonzero.
def mag_divmod(a: Magnitude, +d: Magnitude) -> Magnitude & Magnitude:
  match a:
    case MagZero{}:
      (MagZero{}, MagZero{})
    case Limb{h, t}:
      div_cell(h, d, mag_divmod(t, d))

def mag_pow10(n: Nat, a: Magnitude) -> Magnitude:
  match n:
    case 0n:
      a
    case 1n+p:
      mag_pow10(p, mag_small_mul(a, 10, 0))

def reverse_cmp(c: Cmp) -> Cmp:
  match c:
    case LT{}:
      GT{}
    case EQ{}:
      EQ{}
    case GT{}:
      LT{}

def signed_cmp(negative_a: Bool, negative_b: Bool, c: Cmp) -> Cmp:
  match negative_a negative_b:
    case False{} False{}:
      c
    case False{} True{}:
      GT{}
    case True{} False{}:
      LT{}
    case True{} True{}:
      reverse_cmp(c)

def cmp(a: Exact, b: Exact) -> Cmp:
  match a b:
    case Exact{sa, +x} Exact{sb, +y}:
      signed_cmp(sa && Bool.not(mag_zero(x)), sb && Bool.not(mag_zero(y)), mag_cmp(x, y))

def equal(a: Exact, b: Exact) -> Bool:
  Cmp.is_eq(cmp(a, b))

def is_zero(a: Exact) -> Bool:
  match a:
    case Exact{s, x}:
      mag_zero(x)

def zero() -> Exact:
  Exact{False{}, MagZero{}}

def negate(a: Exact) -> Exact:
  match a:
    case Exact{s, x}:
      Exact{Bool.not(s), x}

def add_opposite(sa: Bool, sb: Bool, x: Magnitude, y: Magnitude, order: Cmp) -> Exact:
  match order:
    case LT{}:
      Exact{sb, mag_sub(y, x, 0)}
    case EQ{}:
      zero()
    case GT{}:
      Exact{sa, mag_sub(x, y, 0)}

def add_signs(+sa: Bool, sb: Bool, +x: Magnitude, +y: Magnitude, same: Bool) -> Exact:
  match same:
    case True{}:
      Exact{sa, mag_add(x, y, 0)}
    case False{}:
      add_opposite(sa, sb, x, y, mag_cmp(x, y))

def add(a: Exact, b: Exact) -> Exact:
  match a b:
    case Exact{+sa, x} Exact{+sb, y}:
      add_signs(sa, sb, x, y, Bool.not(Bool.xor(sa, sb)))

def sub(a: Exact, b: Exact) -> Exact:
  add(a, negate(b))

def mul(a: Exact, b: Exact) -> Exact:
  match a b:
    case Exact{sa, x} Exact{sb, y}:
      Exact{Bool.xor(sa, sb), mag_mul(x, y)}

type Phase is Data:
  Start{}
  Signed{}
  IntZero{}
  IntMore{}
  Dot{}
  Fraction{}
  ExpStart{}
  ExpSigned{}
  ExpMore{}
  Invalid{}

type Input is Data:
  Digit{value: U32}
  Minus{}
  Plus{}
  Point{}
  Marker{}
  Other{}

type Scan is Data:
  Scan{negative: Bool, coefficient: Magnitude, fraction: U32,
    significant: U32, trailing: U32, exp_negative: Bool, exponent: U32}

# power is the decimal exponent plus 10128, keeping bounded counters unsigned.
type Decimal is Data:
  Decimal{negative: Bool, coefficient: Magnitude, power: U32,
    significant: U32, trailing: U32}

def input_kind(code: U32, digit: Bool, minus: Bool, plus: Bool, point: Bool, marker: Bool) -> Input:
  match digit minus plus point marker:
    case True{} _ _ _ _:
      Digit{(code - 48 : U32)}
    case False{} True{} _ _ _:
      Minus{}
    case False{} False{} True{} _ _:
      Plus{}
    case False{} False{} False{} True{} _:
      Point{}
    case False{} False{} False{} False{} True{}:
      Marker{}
    case False{} False{} False{} False{} False{}:
      Other{}

def input(c: Char) -> Input:
  +n = Char.to_u32(c)
  input_kind(n, (n >= 48 : U32) && (n <= 57 : U32),
    U32.is_eq(n, 45), U32.is_eq(n, 43), U32.is_eq(n, 46),
    U32.is_eq(n, 101) || U32.is_eq(n, 69))

def scan_digit(s: Scan, +d: U32, fraction: Bool) -> Scan:
  match s:
    case Scan{negative, c, f, +significant, trailing, en, e}:
      Scan{negative, mag_small_add(mag_small_mul(c, 10, 0), d),
        (f + Bool.to_u32(fraction) : U32),
        Bool.pick(U32, U32.is_zero(significant) && U32.is_zero(d), 0, (significant + 1 : U32)),
        Bool.pick(U32, U32.is_zero(d), (trailing + 1 : U32), 0), en, e}

def scan_negative(s: Scan) -> Scan:
  match s:
    case Scan{negative, c, f, n, t, en, e}:
      Scan{True{}, c, f, n, t, en, e}

def scan_exp_negative(s: Scan) -> Scan:
  match s:
    case Scan{negative, c, f, n, t, en, e}:
      Scan{negative, c, f, n, t, True{}, e}

def scan_exp_digit(s: Scan, d: U32) -> Scan:
  match s:
    case Scan{negative, c, f, n, t, en, e}:
      Scan{negative, c, f, n, t, en, U32.min(10001, (e * 10 + d : U32))}

def first_digit(s: Scan, +d: U32) -> Phase & Scan:
  (Bool.pick(Phase, U32.is_zero(d), IntZero{}, IntMore{}), scan_digit(s, d, False{}))

def token_step(phase: Phase, c: Input, s: Scan) -> Phase & Scan:
  match phase c:
    case Start{} Minus{}:
      (Signed{}, scan_negative(s))
    case Start{} Digit{d}:
      first_digit(s, d)
    case Signed{} Digit{d}:
      first_digit(s, d)
    case IntMore{} Digit{d}:
      (IntMore{}, scan_digit(s, d, False{}))
    case IntZero{} Point{}:
      (Dot{}, s)
    case IntMore{} Point{}:
      (Dot{}, s)
    case Dot{} Digit{d}:
      (Fraction{}, scan_digit(s, d, True{}))
    case Fraction{} Digit{d}:
      (Fraction{}, scan_digit(s, d, True{}))
    case IntZero{} Marker{}:
      (ExpStart{}, s)
    case IntMore{} Marker{}:
      (ExpStart{}, s)
    case Fraction{} Marker{}:
      (ExpStart{}, s)
    case ExpStart{} Plus{}:
      (ExpSigned{}, s)
    case ExpStart{} Minus{}:
      (ExpSigned{}, scan_exp_negative(s))
    case ExpStart{} Digit{d}:
      (ExpMore{}, scan_exp_digit(s, d))
    case ExpSigned{} Digit{d}:
      (ExpMore{}, scan_exp_digit(s, d))
    case ExpMore{} Digit{d}:
      (ExpMore{}, scan_exp_digit(s, d))
    case _ _:
      (Invalid{}, s)

def scan_decimal(s: Scan, valid: Bool) -> Maybe<&2, Decimal>:
  match s valid:
    case Scan{negative, c, f, n, t, en, +e} True{}:
      Some{Decimal{negative, c, (Bool.pick(U32, en, (10128 - e : U32), (10128 + e : U32)) - f : U32), n, t}}
    case _ False{}:
      None{}

def finish(s: Scan, phase: Phase) -> Maybe<&2, Decimal>:
  match s phase:
    case Scan{negative, c, f, n, t, en, +e} IntZero{}:
      scan_decimal(Scan{negative, c, f, n, t, en, e}, (e <= 10000 : U32))
    case Scan{negative, c, f, n, t, en, +e} IntMore{}:
      scan_decimal(Scan{negative, c, f, n, t, en, e}, (e <= 10000 : U32))
    case Scan{negative, c, f, n, t, en, +e} Fraction{}:
      scan_decimal(Scan{negative, c, f, n, t, en, e}, (e <= 10000 : U32))
    case Scan{negative, c, f, n, t, en, +e} ExpMore{}:
      scan_decimal(Scan{negative, c, f, n, t, en, e}, (e <= 10000 : U32))
    case _ _:
      None{}

def scan(fuel: Nat, raw: String, state: Phase & Scan) -> Maybe<&2, Decimal>:
  match fuel raw state:
    case 0n SNil{} Tuple{phase, s}:
      finish(s, phase)
    case 0n SCon{h, t} _:
      None{}
    case 1n+p SNil{} Tuple{phase, s}:
      finish(s, phase)
    case 1n+p SCon{h, t} Tuple{phase, s}:
      scan(p, t, token_step(phase, input(h), s))

def parse(raw: String) -> Maybe<&2, Decimal>:
  scan(128n, raw, (Start{}, Scan{False{}, MagZero{}, 0, 0, 0, False{}, 0}))

def token_valid_result(result: Maybe<&2, Decimal>) -> Bool:
  match result:
    case None{}:
      False{}
    case Some{d}:
      True{}

def token_valid(raw: String) -> Bool:
  token_valid_result(parse(raw))

type Ratio is Data:
  Ratio{negative: Bool, numerator: Magnitude, denominator: Magnitude, integer: Bool}

def ratio_power(s: Bool, c: Magnitude, +p: U32, integer: Bool, positive: Bool) -> Ratio:
  match positive:
    case True{}:
      Ratio{s, mag_shl(1074, mag_pow10(U32.to_nat((p - 10128 : U32)), c)), mag_single(1), integer}
    case False{}:
      Ratio{s, mag_shl(1074, c), mag_pow10(U32.to_nat((10128 - p : U32)), mag_single(1)), integer}

def ratio_range(s: Bool, c: Magnitude, +p: U32, t: U32, valid: Bool) -> Maybe<&2, Ratio>:
  match valid:
    case False{}:
      None{}
    case True{}:
      Some{ratio_power(s, c, p, (p + t >= 10128 : U32), (p >= 10128 : U32))}

def ratio(d: Decimal) -> Maybe<&2, Ratio>:
  match d:
    case Decimal{s, MagZero{}, p, n, t}:
      Some{Ratio{s, MagZero{}, mag_single(1), True{}}}
    case Decimal{s, Limb{h, rest}, +p, n, t}:
      +order = (p + n : U32)
      ratio_range(s, Limb{h, rest}, p, t, (order >= 9805 : U32) && (order <= 10437 : U32))

def maximum() -> Magnitude:
  mag_shl(2045, Limb{65535, Limb{65535, Limb{65535, Limb{31, MagZero{}}}}})

def ratio_cmp(r: Ratio, bound: Exact) -> Cmp:
  match r bound:
    case Ratio{s, +n, d, i} Exact{sb, +b}:
      signed_cmp(s && Bool.not(mag_zero(n)), sb && Bool.not(mag_zero(b)), mag_cmp(n, mag_mul(b, d)))

def round_increment(+q: Magnitude, order: Cmp) -> Magnitude:
  match order:
    case LT{}:
      q
    case EQ{}:
      mag_small_add(q, Bool.to_u32(mag_odd(q)))
    case GT{}:
      mag_small_add(q, 1)

def round_quotient(+d: Magnitude, pair: Magnitude & Magnitude) -> Magnitude:
  (q, r) = pair
  round_increment(q, mag_cmp(mag_small_mul(r, 2, 0), d))

def round_shift(+span: U32, lower: Bool) -> U32:
  Bool.pick(U32, (span <= 52 : U32), 0, (span - 52 - Bool.to_u32(lower) : U32))

def rounded_nonzero(s: Bool, +n: Magnitude, valid: Bool) -> Maybe<&2, Exact>:
  match valid:
    case False{}:
      None{}
    case True{}:
      Some{Exact{s, n}}

def round_ratio(s: Bool, +n: Magnitude, +d: Magnitude) -> Maybe<&2, Exact>:
  +span = (U32.max(mag_bits(n), mag_bits(d)) - mag_bits(d) : U32)
  +shift = round_shift(span, Cmp.is_lt(mag_cmp(n, mag_shl(span, d))))
  +denominator = mag_shl(shift, d)
  +rounded = mag_shl(shift, round_quotient(denominator, mag_divmod(n, denominator)))
  rounded_nonzero(s, rounded, Bool.not(mag_zero(rounded)))

def read_range(s: Bool, n: Magnitude, d: Magnitude, valid: Bool) -> Maybe<&2, Exact>:
  match n valid:
    case MagZero{} _:
      Some{Exact{s, MagZero{}}}
    case Limb{h, t} False{}:
      None{}
    case Limb{h, t} True{}:
      round_ratio(s, Limb{h, t}, d)

def read_ratio(r: Ratio) -> Maybe<&2, Exact>:
  match r:
    case Ratio{s, +n, +d, i}:
      read_range(s, n, d, Cmp.is_le(mag_cmp(n, mag_mul(maximum(), d))))

def read(raw: String) -> Maybe<&2, Exact>:
  do Maybe<&2, Exact>:
    decimal : Decimal <- parse(raw)
    rational : Ratio <- ratio(decimal)
    read_ratio(rational)

type Bound is Data:
  Unbounded{}
  Bound{value: Exact}

def bound_value(value: Maybe<&2, Exact>) -> Maybe<&2, Bound>:
  match value:
    case None{}:
      None{}
    case Some{x}:
      Some{Bound{x}}

def bound(raw: String) -> Maybe<&2, Bound>:
  match raw:
    case SNil{}:
      Some{Unbounded{}}
    case SCon{h, t}:
      bound_value(read(SCon{h, t}))

def lower_cmp(+c: Cmp, exclusive: Bool) -> Bool:
  Cmp.is_gt(c) || (Cmp.is_eq(c) && Bool.not(exclusive))

def upper_cmp(+c: Cmp, exclusive: Bool) -> Bool:
  Cmp.is_lt(c) || (Cmp.is_eq(c) && Bool.not(exclusive))

def lower(+r: Ratio, value: Exact, minimum: Bound, +exclusive: Bool) -> Bool:
  match minimum:
    case Unbounded{}:
      True{}
    case Bound{+b}:
      lower_cmp(ratio_cmp(r, b), exclusive) && lower_cmp(cmp(value, b), exclusive)

def upper(+r: Ratio, value: Exact, maximum: Bound, +exclusive: Bool) -> Bool:
  match maximum:
    case Unbounded{}:
      True{}
    case Bound{+b}:
      upper_cmp(ratio_cmp(r, b), exclusive) && upper_cmp(cmp(value, b), exclusive)

def ratio_integer(r: Ratio) -> Bool:
  match r:
    case Ratio{s, n, d, integer}:
      integer

def safe_integer(value: Exact) -> Bool:
  match value:
    case Exact{s, x}:
      Cmp.is_le(mag_cmp(x, mag_shl(1074,
        Limb{65535, Limb{65535, Limb{65535, Limb{31, MagZero{}}}}})))

type ParsedNumber is Data:
  ParsedNumber{ratio: Ratio, value: Exact}

def accept_checks(data: ParsedNumber, minimum: Bound, maximum: Bound,
    integer: Bool, exclusive_min: Bool, exclusive_max: Bool) -> Bool:
  match data:
    case ParsedNumber{+r, +value}:
      lower(r, value, minimum, exclusive_min) && upper(r, value, maximum, exclusive_max) &&
        (Bool.not(integer) || (ratio_integer(r) && safe_integer(value)))

def accepted_read(+r: Ratio) -> Maybe<&2, ParsedNumber>:
  do Maybe<&2, ParsedNumber>:
    value : Exact <- read_ratio(r)
    return ParsedNumber{r, value}

# Bounds name binary64 endpoints, as in the existing numeric Domain.
def accept_maybe(raw: String, minimum: String, maximum: String, integer: Bool,
    exclusive_min: Bool, exclusive_max: Bool) -> Maybe<&2, Bool>:
  do Maybe<&2, Bool>:
    decimal : Decimal <- parse(raw)
    rational : Ratio <- ratio(decimal)
    data : ParsedNumber <- accepted_read(rational)
    low : Bound <- bound(minimum)
    high : Bound <- bound(maximum)
    return accept_checks(data, low, high, integer, exclusive_min, exclusive_max)

def accept_result(value: Maybe<&2, Bool>) -> Bool:
  match value:
    case None{}:
      False{}
    case Some{ok}:
      ok

def accept(raw: String, min: String, max: String, integer: Bool,
    exclusive_min: Bool, exclusive_max: Bool) -> Bool:
  accept_result(accept_maybe(raw, min, max, integer, exclusive_min, exclusive_max))

# Midpoints are doubled scaled integers. Powers of two have a smaller gap below.
type Interval is Data:
  Interval{low: Magnitude, high: Magnitude, closed: Bool}

def interval(+n: Magnitude) -> Interval:
  +bits = mag_bits(n)
  +shift = (U32.max(bits, 53) - 53 : U32)
  +step = mag_shl(shift, mag_single(1))
  +binade = (shift > 0 : U32) && Cmp.is_eq(mag_cmp(n, mag_shl((bits - 1 : U32), mag_single(1))))
  +twice = mag_small_mul(n, 2, 0)
  Interval{mag_sub(twice, Bool.pick(Magnitude, binade, mag_shr(1, step), step), 0),
    mag_add(twice, step, 0), Bool.not(mag_odd(mag_shr(shift, n)))}

def candidate_range(n: Magnitude, +d: Magnitude, window: Interval) -> Bool:
  match window:
    case Interval{low, high, +closed}:
      +twice = mag_small_mul(n, 2, 0)
      lower_cmp(mag_cmp(twice, mag_mul(low, d)), Bool.not(closed)) &&
        upper_cmp(mag_cmp(twice, mag_mul(high, d)), Bool.not(closed))

# Formatting powers use bias 400. The search needs only -340 through +308.
def candidate_power(c: Magnitude, +p: U32, window: Interval, positive: Bool) -> Bool:
  match positive:
    case True{}:
      candidate_range(mag_shl(1074, mag_pow10(U32.to_nat((p - 400 : U32)), c)), mag_single(1), window)
    case False{}:
      candidate_range(mag_shl(1074, c), mag_pow10(U32.to_nat((400 - p : U32)), mag_single(1)), window)

def candidate(c: Magnitude, +p: U32, window: Interval) -> Bool:
  candidate_power(c, p, window, (p >= 400 : U32))

type Normal is Data:
  Normal{numerator: Magnitude, denominator: Magnitude, power: U32}

type NormalStep is Data:
  Normalizing{value: Normal}
  Normalized{value: Normal}

def normal_choice(n: Magnitude, d: Magnitude, +power: U32, below: Bool, above: Bool) -> NormalStep:
  match below above:
    case True{} _:
      Normalizing{Normal{mag_small_mul(n, 10, 0), d, (power - 1 : U32)}}
    case False{} True{}:
      Normalizing{Normal{n, mag_small_mul(d, 10, 0), (power + 1 : U32)}}
    case False{} False{}:
      Normalized{Normal{n, d, power}}

def normal_step(value: Normal) -> NormalStep:
  match value:
    case Normal{+n, +d, p}:
      normal_choice(n, d, p, Cmp.is_lt(mag_cmp(n, d)), Cmp.is_ge(mag_cmp(n, mag_small_mul(d, 10, 0))))

def normalize(fuel: Nat, state: NormalStep) -> Maybe<&2, Normal>:
  match fuel state:
    case _ Normalized{value}:
      Some{value}
    case 0n Normalizing{value}:
      None{}
    case 1n+p Normalizing{value}:
      normalize(p, normal_step(value))

type Short is Data:
  Short{coefficient: Magnitude, power: U32}

type DecimalState is Data:
  DecimalState{numerator: Magnitude, coefficient: Magnitude, power: U32}

type FormatStep is Data:
  MoreDigits{state: DecimalState}
  Shortest{value: Short}

def choose_candidate(low: Magnitude, high: Magnitude, order: Cmp,
    low_valid: Bool, high_valid: Bool) -> Maybe<&2, Magnitude>:
  match low_valid high_valid:
    case False{} False{}:
      None{}
    case True{} False{}:
      Some{low}
    case False{} True{}:
      Some{high}
    case True{} True{}:
      Some{round_increment(low, order)}

def digit_choice(low: Magnitude, remainder: Magnitude, +power: U32,
    choice: Maybe<&2, Magnitude>) -> FormatStep:
  match choice:
    case None{}:
      MoreDigits{DecimalState{mag_small_mul(remainder, 10, 0), low, (power - 1 : U32)}}
    case Some{c}:
      Shortest{Short{c, power}}

def digit_result(+d: Magnitude, +window: Interval, previous: Magnitude,
    +power: U32, pair: Magnitude & Magnitude) -> FormatStep:
  (digit, +remainder) = pair
  +low = mag_add(mag_small_mul(previous, 10, 0), digit, 0)
  +high = mag_small_add(low, 1)
  digit_choice(low, remainder, power, choose_candidate(low, high,
    mag_cmp(mag_small_mul(remainder, 2, 0), d), candidate(low, power, window), candidate(high, power, window)))

def digit_step(+d: Magnitude, window: Interval, state: DecimalState) -> FormatStep:
  match state:
    case DecimalState{n, c, power}:
      digit_result(d, window, c, power, mag_divmod(n, d))

def shortest(fuel: Nat, +d: Magnitude, +window: Interval, step: FormatStep) -> Maybe<&2, Short>:
  match fuel step:
    case _ Shortest{value}:
      Some{value}
    case 0n MoreDigits{state}:
      None{}
    case 1n+p MoreDigits{state}:
      shortest(p, d, window, digit_step(d, window, state))

def shortest_normal(window: Interval, normal: Normal) -> Maybe<&2, Short>:
  match normal:
    case Normal{n, d, power}:
      shortest(17n, d, window, MoreDigits{DecimalState{n, MagZero{}, power}})

type StripStep is Data:
  StripMore{value: Short}
  StripDone{value: Short}

def strip_result(c: Magnitude, +power: U32, pair: Magnitude & Magnitude) -> StripStep:
  match pair:
    case Tuple{q, MagZero{}}:
      StripMore{Short{q, (power + 1 : U32)}}
    case Tuple{q, Limb{h, t}}:
      StripDone{Short{c, power}}

def strip_step(value: Short) -> StripStep:
  match value:
    case Short{+c, power}:
      strip_result(c, power, mag_divmod(c, mag_single(10)))

def strip(fuel: Nat, step: StripStep) -> Short:
  match fuel step:
    case _ StripDone{value}:
      value
    case 0n StripMore{value}:
      value
    case 1n+p StripMore{value}:
      strip(p, strip_step(value))

def digits_next(text: String, pair: Magnitude & Magnitude) -> Magnitude & String:
  (q, r) = pair
  (q, SCon{Chr{(48 + mag_u32(r) : U32)}, text})

def digits(fuel: Nat, state: Magnitude & String) -> String:
  match fuel state:
    case 0n Tuple{c, text}:
      text
    case 1n+p Tuple{MagZero{}, text}:
      text
    case 1n+p Tuple{Limb{h, t}, text}:
      digits(p, digits_next(text, mag_divmod(Limb{h, t}, mag_single(10))))

def zeros(n: Nat) -> String:
  match n:
    case 0n:
      ""
    case 1n+p:
      SCon{'0', zeros(p)}

def plain_positive(+text: String, +length: U32, +point: U32, pad: Bool) -> String:
  match pad:
    case True{}:
      text ++ zeros(U32.to_nat((point - length : U32)))
    case False{}:
      String.take(text, U32.to_nat(point)) ++ "." ++ String.drop(text, U32.to_nat(point))

def scientific_tail(text: String) -> String:
  match text:
    case SNil{}:
      ""
    case SCon{h, t}:
      "." ++ SCon{h, t}

def scientific(text: String, exponent: String) -> String:
  match text:
    case SNil{}:
      ""
    case SCon{h, t}:
      SCon{h, scientific_tail(t) ++ "e" ++ exponent}

def render_order(+text: String, +length: U32, +order: U32, fixed: Bool, positive: Bool) -> String:
  match fixed positive:
    case True{} True{}:
      +point = (order - 399 : U32)
      plain_positive(text, length, point, (point >= length : U32))
    case True{} False{}:
      "0." ++ zeros(U32.to_nat((399 - order : U32))) ++ text
    case False{} True{}:
      scientific(text, "+" ++ U32.show((order - 400 : U32)))
    case False{} False{}:
      scientific(text, "-" ++ U32.show((400 - order : U32)))

def render_digits(+text: String, power: U32) -> String:
  +length = U32.from_nat(String.length(text))
  +order = (power + length - 1 : U32)
  render_order(text, length, order, (order >= 394 : U32) && (order <= 420 : U32), (order >= 400 : U32))

def render(value: Short) -> String:
  match value:
    case Short{c, p}:
      render_digits(digits(18n, (c, "")), p)

def signed_format(negative: Bool, text: String) -> String:
  match negative:
    case False{}:
      text
    case True{}:
      "-" ++ text

def format_value(value: Exact) -> Maybe<&2, String>:
  match value:
    case Exact{s, MagZero{}}:
      Some{"0"}
    case Exact{s, Limb{+h, +t}}:
      do Maybe<&2, String>:
        normal : Normal <- normalize(326n, Normalizing{Normal{Limb{h, t}, mag_shl(1074, mag_single(1)), 400}})
        short : Short <- shortest_normal(interval(Limb{h, t}), normal)
        return signed_format(s, render(strip(18n, StripMore{short})))

def format_read(value: Maybe<&2, Exact>) -> Maybe<&2, String>:
  match value:
    case None{}:
      None{}
    case Some{x}:
      format_value(x)

def format_result(value: Maybe<&2, String>) -> String:
  match value:
    case None{}:
      ""
    case Some{text}:
      text

# Invalid tokens have no canonical number and return the empty string.
def format(raw: String) -> String:
  format_result(format_read(read(raw)))
