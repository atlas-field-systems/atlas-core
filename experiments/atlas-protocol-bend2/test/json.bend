import Base
import ../common.bend as C
import ../json.bend as J

def ascii_bytes(s: String) -> List<&2, U32>:
  match s:
    case SNil{}:
      Nil{}
    case SCon{Chr{x}, t}:
      Con{x, ascii_bytes(t)}

def status(-A: Data, r: Result<&2, &2, C.Failure, A>) -> String:
  match r:
    case Done{value}:
      "ok"
    case Fail{C.Failure{code, issues}}:
      C.code_name(code)

def expect(-A: Data, r: Result<&2, &2, C.Failure, A>, wanted: String, +label: String) -> IO(Unit):
  +actual = status(A, r)
  C.choose(IO(Unit), String.eq(actual, wanted), _ => IO.print(label),
    _ => IO.die(Unit, 1, label ++ " got " ++ actual))

def assert(ok: Bool, +label: String) -> IO(Unit):
  C.choose(IO(Unit), ok, _ => IO.print(label), _ => IO.die(Unit, 1, label))

def padded(n: Nat) -> List<&2, U32>:
  List.append(&2, U32, List.replicate(U32, n, 32), [110, 117, 108, 108])

def zero_tail(n: Nat) -> List<&2, U32>:
  match n:
    case 0n:
      [48, 93]
    case 1n+p:
      Con{48, Con{44, zero_tail(p)}}

def zero_array(n: Nat) -> List<&2, U32>:
  Con{91, zero_tail(n)}

def nested(n: Nat, bytes: List<&2, U32>) -> List<&2, U32>:
  match n:
    case 0n:
      bytes
    case 1n+p:
      nested(p, Con{91, List.append(&2, U32, bytes, [93])})

def count_bytes(xs: List<&2, U32>, n: U32) -> U32:
  match xs:
    case Nil{}:
      n
    case Con{h, t}:
      count_bytes(t, (n + 1 : U32))

def encoded_size(r: Result<&2, &2, C.Failure, List<&2, U32>>, expected: U32) -> Bool:
  match r:
    case Done{bytes}:
      U32.is_eq(count_bytes(bytes, 0), expected)
    case Fail{e}:
      False{}

def roundtrip_bytes(r: Result<&2, &2, C.Failure, List<&2, U32>>, +value: C.Json) -> Bool:
  match r:
    case Fail{e}:
      False{}
    case Done{bytes}:
      +parsed = Result.default(&2, &2, C.Failure, C.Json, J.parse(bytes, C.default_budget("http_request")), C.JMissing{})
      C.equal(parsed, value)

def roundtrip(+value: C.Json) -> Bool:
  roundtrip_bytes(J.encode(value, C.default_budget("http_request")), value)

def fixture_text() -> String:
  SCon{Chr{0}, SCon{Chr{34}, SCon{Chr{92}, SCon{Chr{128512}, SNil{}}}}}

def fixture() -> C.Json:
  C.JObj{[C.Member{"text", C.JStr{fixture_text()}},
    C.Member{"number", C.JNum{"-0.0012300E+0002"}},
    C.Member{"items", C.JArr{[C.JNull{}, C.JBool{True{}}, C.JArr{Nil{}}, C.JObj{Nil{}}]}}]}

def json_nested(n: Nat, value: C.Json) -> C.Json:
  match n:
    case 0n:
      value
    case 1n+p:
      json_nested(p, C.JArr{[value]})

def main() -> IO(Unit):
  do IO<Unit>:
    expect(C.Json, J.parse(ascii_bytes("{\"a\":[null,true,false,-0.00e+2],\"b\":{}}"), C.default_budget("http_request")), "ok", "native parse")
    expect(Unit, J.check(ascii_bytes("{\"a\":1,\"\\u0061\":2}"), C.default_budget("http_request")), "invalid_json", "native duplicate escaped key")
    expect(C.Json, J.parse(ascii_bytes("\"\\ud83d\\ude00\""), C.default_budget("http_request")), "ok", "native surrogate pair")
    expect(Unit, J.check([34, 237, 160, 128, 34], C.default_budget("http_request")), "invalid_utf8", "native raw surrogate UTF8")
    expect(Unit, J.check([34, 240, 159, 152, 128, 34], C.default_budget("http_request")), "ok", "native raw supplementary scalar")
    expect(Unit, J.check([239, 187, 191, 48], C.default_budget("http_request")), "invalid_json", "native BOM retained")
    expect(Unit, J.check([255], C.Budget{0, 0, 0, 0, 0}), "payload_too_large", "native byte limit precedes UTF8")
    expect(Unit, J.check([120, 255], C.default_budget("http_request")), "invalid_utf8", "native UTF8 precedes JSON")
    expect(Unit, J.check(ascii_bytes("[1,]"), C.default_budget("http_request")), "invalid_json", "native trailing comma")
    expect(Unit, J.check(ascii_bytes("01"), C.default_budget("http_request")), "invalid_json", "native number grammar")
    expect(Unit, J.check(ascii_bytes("1e10001"), C.default_budget("http_request")), "invalid_value", "native exponent bound")
    expect(Unit, J.check(ascii_bytes("1e-10000"), C.default_budget("http_request")), "ok", "native exponent endpoint")
    expect(Unit, J.check(List.replicate(U32, 128n, 49), C.default_budget("http_request")), "ok", "native numeric token 128")
    expect(Unit, J.check(List.replicate(U32, 129n, 49), C.default_budget("http_request")), "invalid_value", "native numeric token 129")
    expect(Unit, J.check(padded(1048572n), C.default_budget("http_request")), "ok", "native request exactly 1MiB")
    expect(Unit, J.check(padded(1048573n), C.default_budget("http_request")), "payload_too_large", "native request above 1MiB")
    expect(Unit, J.check(padded(4194300n), C.default_budget("http_response")), "ok", "native response exactly 4MiB")
    expect(Unit, J.check(padded(4194301n), C.default_budget("http_response")), "payload_too_large", "native response above 4MiB")
    expect(Unit, J.check(padded(16380n), C.default_budget("wss_control")), "ok", "native control exactly 16KiB")
    expect(Unit, J.check(padded(16381n), C.default_budget("wss_control")), "payload_too_large", "native control above 16KiB")
    expect(C.Json, J.parse(nested(31n, [48]), C.default_budget("http_request")), "ok", "native scalar at depth 32")
    expect(Unit, J.check(nested(32n, [48]), C.default_budget("http_request")), "resource_limit", "native scalar at depth 33")
    expect(Unit, J.check(nested(31n, [91, 93]), C.default_budget("http_request")), "ok", "native empty container at depth 32")
    expect(Unit, J.check([48], C.Budget{10, 1, 0, 0, 0}), "resource_limit", "native root depth one")
    expect(Unit, J.check(ascii_bytes("{\"a\":0}"), C.Budget{20, 2, 2, 0, 0}), "ok", "native member names are not values")
    expect(Unit, J.check(zero_array(65534n), C.default_budget("http_request")), "ok", "native request exactly 65536 values")
    expect(Unit, J.check(zero_array(65535n), C.default_budget("http_request")), "resource_limit", "native request above 65536 values")
    expect(Unit, J.check(zero_array(262142n), C.default_budget("http_response")), "ok", "native response exactly 262144 values")
    expect(Unit, J.check(zero_array(262143n), C.default_budget("http_response")), "resource_limit", "native response above 262144 values")
    expect(List<&2, U32>, J.encode(C.JArr{List.replicate(C.Json, 65535n, C.JNull{})}, C.default_budget("http_request")), "ok", "native encode exactly 65536 values")
    expect(List<&2, U32>, J.encode(C.JArr{List.replicate(C.Json, 65536n, C.JNull{})}, C.default_budget("http_request")), "resource_limit", "native encode above 65536 values")
    expect(List<&2, U32>, J.encode(C.JArr{List.replicate(C.Json, 262143n, C.JNull{})}, C.default_budget("http_response")), "ok", "native encode exactly 262144 values")
    expect(List<&2, U32>, J.encode(C.JArr{List.replicate(C.Json, 262144n, C.JNull{})}, C.default_budget("http_response")), "resource_limit", "native encode above 262144 values")
    expect(List<&2, U32>, J.encode(json_nested(31n, C.JNull{}), C.default_budget("http_request")), "ok", "native encode depth 32")
    expect(List<&2, U32>, J.encode(json_nested(32n, C.JNull{}), C.default_budget("http_request")), "resource_limit", "native encode depth 33")
    assert(roundtrip(fixture()), "native Unicode and raw-number roundtrip")
    assert(encoded_size(J.encode(C.JStr{String.repeat("x", 1048574n)}, C.default_budget("http_request")), 1048576), "native encode exactly 1MiB")
    expect(List<&2, U32>, J.encode(C.JStr{String.repeat("x", 1048575n)}, C.default_budget("http_request")), "payload_too_large", "native encode above 1MiB")
    assert(encoded_size(J.encode(C.JStr{String.repeat("x", 4194302n)}, C.default_budget("http_response")), 4194304), "native encode exactly 4MiB")
    expect(List<&2, U32>, J.encode(C.JStr{String.repeat("x", 4194303n)}, C.default_budget("http_response")), "payload_too_large", "native encode above 4MiB")
    expect(List<&2, U32>, J.encode(C.JMissing{}, C.default_budget("http_request")), "invalid_value", "native writer rejects missing")
    expect(List<&2, U32>, J.encode(C.JStr{SCon{Chr{55296}, SNil{}}}, C.default_budget("http_request")), "invalid_value", "native writer rejects surrogate scalar")
    expect(List<&2, U32>, J.encode(C.JStr{SCon{Chr{1114112}, SNil{}}}, C.default_budget("http_request")), "invalid_value", "native writer rejects out-of-range scalar")
    expect(List<&2, U32>, J.encode(C.JNum{"01"}, C.default_budget("http_request")), "invalid_value", "native writer rejects number grammar")
    expect(List<&2, U32>, J.encode(C.JObj{[C.Member{"a", C.JNull{}}, C.Member{"a", C.JNull{}}]}, C.default_budget("http_request")), "invalid_value", "native writer rejects duplicate members")
    IO.print("native JSON checks passed")
