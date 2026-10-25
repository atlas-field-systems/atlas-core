import Base
import ../common.bend as C
import ../exchanges.bend as E
import ../http.bend as H
import ../wss.bend as W

def fixture_fold(+text: String) -> String:
  C.choose(String, String.eq(text, "Straße") || String.eq(text, "STRASSE"), _ => "strasse", _ => text)

def check(operation: String, request: C.Json, envelope: C.Json, status: U32, version: String) -> Result<&2, &2, C.Failure, Unit>:
  E.check_response(~(text => fixture_fold(text)), operation, request, envelope, status, version)

def refine(name: String, value: C.Json) -> Result<&2, &2, C.Failure, Unit>:
  E.refine(name, value)

def fixed_budget(boundary: String, lower: C.Json) -> Result<&2, &2, C.Failure, C.Budget>:
  Done{C.default_budget(boundary)}

def zero_budget(boundary: String, lower: C.Json) -> Result<&2, &2, C.Failure, C.Budget>:
  Done{C.Budget{0, 0, 0, 0, 0}}

def check_wss(frame: C.Json, context: C.Json, reading_server: Bool) -> Result<&2, &2, C.Failure, Unit>:
  W.check(~fixed_budget, frame, context, reading_server)

def check_wss_zero(frame: C.Json, context: C.Json) -> Result<&2, &2, C.Failure, Unit>:
  W.check(~zero_budget, frame, context, False{})

# These callbacks instantiate the transport templates only. They never validate a fixture.
def read_stub(schema: String, boundary: String, bytes: List<&2, U32>, lower: C.Json) -> Result<&2, &2, C.Failure, C.Json>:
  Fail{C.failure(C.InvalidValue{})}

def validate_stub(schema: String, boundary: String, value: C.Json, lower: C.Json) -> Result<&2, &2, C.Failure, C.Json>:
  Fail{C.failure(C.InvalidValue{})}

def write_stub(schema: String, boundary: String, value: C.Json, lower: C.Json) -> Result<&2, &2, C.Failure, List<&2, U32>>:
  Fail{C.failure(C.InvalidValue{})}

def compile_http_request(operation: String, incoming: C.Json, lower: C.Json) -> Result<&2, &2, C.Failure, C.Json>:
  H.read_request(~read_stub, ~validate_stub, ~fixed_budget, operation, incoming, lower)

def compile_http_response(operation: String, received: C.Json, context: C.Json) -> Result<&2, &2, C.Failure, C.Json>:
  H.read_response(~read_stub, ~validate_stub, ~fixed_budget, ~(text => fixture_fold(text)), operation, received, context)

def compile_wss_read_client(bytes: List<&2, U32>, context: C.Json) -> Result<&2, &2, C.Failure, C.Json>:
  W.read_client(~read_stub, ~fixed_budget, bytes, context)

def compile_wss_read_server(bytes: List<&2, U32>, context: C.Json) -> Result<&2, &2, C.Failure, C.Json>:
  W.read_server(~read_stub, ~fixed_budget, bytes, context)

def compile_wss_write_client(value: C.Json, context: C.Json) -> Result<&2, &2, C.Failure, List<&2, U32>>:
  W.write_client(~write_stub, ~fixed_budget, value, context)

def compile_wss_write_server(value: C.Json, context: C.Json) -> Result<&2, &2, C.Failure, List<&2, U32>>:
  W.write_server(~write_stub, ~fixed_budget, value, context)

def request_headers(+headers: C.Json) -> Result<&2, &2, C.Failure, Unit>:
  do Result<&2, &2, C.Failure, Unit>:
    H.uncompressed(headers)
    H.authorization(headers)
    dataset : String <- H.context_header(headers, "Atlas-Dataset-ID", True{})
    version : String <- H.context_header(headers, "Atlas-Protocol-Version", False{})
    return Unit{}

def reference(received: C.Json, context: C.Json, max_bytes: U32) -> Result<&2, &2, C.Failure, C.Json>:
  H.reference_response(received, context, C.Budget{max_bytes, 262144, 32, 1000, 4194304})

def text_bytes(bytes: List<&2, U32>) -> Result<&2, &2, C.Failure, String>:
  H.utf8(bytes)

def media(headers: C.Json) -> Result<&2, &2, C.Failure, String>:
  H.media(headers)

def length(headers: C.Json, actual: U32) -> Result<&2, &2, C.Failure, Unit>:
  H.length(headers, actual)

def correlation(headers: C.Json) -> C.Json:
  H.correlation(headers)

def content_path(path: String) -> Result<&2, &2, C.Failure, C.Json>:
  H.content_path(path)

def multipart(text: String) -> Bool:
  H.multipart(text)

def same_dataset(value: C.Json, dataset: String) -> Bool:
  H.same_dataset(value, C.JStr{dataset})

def response_lower(operation: String, request: C.Json, lower: C.Json) -> C.Json:
  H.response_lower(operation, request, C.default_budget("http_response"), lower)

def error_context(envelope: C.Json, version: String) -> Bool:
  H.error_context(envelope, version)

def definitions() -> List<&2, C.Member>:
  E.definitions()

def names() -> List<&2, String>:
  E.names()

def schema(name: String) -> C.Json:
  E.schema(name)

def catalog() -> C.Json:
  E.catalog()
