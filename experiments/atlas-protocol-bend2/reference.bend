import Base
import ./common.bend as C
import ./shapes.bend as S
import ./schemas.bend as Schemas
import ./exchanges.bend as E
import ./numbers.bend as N
import ./catalog.bend as Catalog

def object(fields: List<&2, C.Member>) -> C.Json:
  C.JObj{fields}

def field(name: String, value: C.Json) -> C.Member:
  C.Member{name, value}

def parameter(name: String, location: String, required: Bool, schema: C.Json) -> C.Json:
  object([field("name", C.JStr{name}), field("in", C.JStr{location}),
    field("required", C.JBool{required}), field("schema", schema)])

def response_header(schema: C.Json) -> C.Json:
  object([field("required", C.JBool{True{}}), field("schema", schema)])

def response_headers() -> List<&2, C.Member>:
  [field("Atlas-Dataset-ID", response_header(S.ref("Uuid"))),
   field("Atlas-Protocol-Version", response_header(S.ref("Opaque"))),
   field("Atlas-Request-ID", response_header(S.ref("NewId")))]

def json_response(schema: C.Json) -> C.Json:
  object([field("description", C.JStr{"Validated result"}),
    field("headers", object(response_headers())),
    field("content", object([field("application/json", object([field("schema", schema)]))]))])

def errors(statuses: List<&2, String>) -> List<&2, C.Member>:
  match statuses:
    case Nil{}:
      Nil{}
    case Con{+status, t}:
      Con{field(status, json_response(S.ref("Exchange.ErrorEnvelope." ++ status))), errors(t)}

def successes(statuses: List<&2, C.Json>, +operation: String) -> List<&2, C.Member>:
  match statuses:
    case Nil{}:
      Nil{}
    case Con{C.JNum{raw}, t}:
      Con{field(raw, json_response(S.ref("Success." ++ operation))), successes(t, operation)}
    case Con{x, t}:
      successes(t, operation)

def reference_response() -> C.Json:
  object([field("description", C.JStr{"Authenticated raw contract document"}),
    field("headers", object(response_headers())), field("content", object([
      field("application/vnd.oai.openapi+json", object(Nil{})),
      field("text/html", object([field("schema", S.typed("string"))]))]))])

def content_response() -> C.Json:
  object([field("description", C.JStr{"Streamed complete binary content"}),
    field("headers", object(List.append(&2, C.Member, response_headers(), [
      field("Content-Length", response_header(S.ref("ObjectLength"))),
      field("Atlas-Content-SHA256", response_header(S.ref("Sha256"))),
      field("Content-Disposition", response_header(S.enum(["inline", "attachment"])))]))),
    field("content", object([field("*/*", object([
      field("schema", S.add(S.typed("string"), [field("format", C.JStr{"binary"})]))]))]))])

def responses(+binding: C.Json) -> C.Json:
  +transport = C.string(C.get(binding, "transport"))
  accepted = C.choose(List<&2, C.Member>, String.eq(transport, "reference"),
    _ => [field("200", reference_response())],
    _ => C.choose(List<&2, C.Member>, String.eq(transport, "content"),
      _ => [field("200", content_response())],
      _ => successes(C.items(C.get(binding, "successStatuses")), C.string(C.get(binding, "operationId")))))
  object(List.append(&2, C.Member, errors(E.error_statuses()), accepted))

def parameters(+binding: C.Json) -> C.Json:
  +transport = C.string(C.get(binding, "transport"))
  +discovery = C.equal(C.get(binding, "discovery"), C.JBool{True{}})
  extra = C.choose(List<&2, C.Json>, String.eq(transport, "reference"),
    _ => [parameter("Accept", "header", True{}, S.enum(["application/vnd.oai.openapi+json", "text/html"]))],
    _ => C.choose(List<&2, C.Json>, String.eq(transport, "content"),
      _ => [parameter("object_id", "path", True{}, S.ref("Uuid")),
        parameter("disposition", "query", True{}, S.enum(["inline", "attachment"]))],
      _ => Nil{}))
  C.JArr{List.append(&2, C.Json, [
    parameter("Atlas-Dataset-ID", "header", Bool.not(discovery), S.ref("Uuid")),
    parameter("Atlas-Protocol-Version", "header", Bool.not(discovery), S.ref("Opaque")),
    parameter("Atlas-Attempt-ID", "header", False{}, S.ref("NewId"))], extra)}

def request_content(+binding: C.Json) -> C.Json:
  +schema = S.ref("Request." ++ C.string(C.get(binding, "operationId")))
  C.choose(C.Json, C.equal(C.get(binding, "transport"), C.JStr{"upload"}),
    _ => object([field("multipart/form-data", object([
      field("schema", S.closed([field("descriptor", schema),
        field("file", S.add(S.typed("string"), [field("format", C.JStr{"binary"})]))], Nil{})),
      field("encoding", object([
        field("descriptor", object([field("contentType", C.JStr{"application/json"})])),
        field("file", object([field("contentType", C.JStr{"application/octet-stream"})]))]))]))]),
    _ => object([field("application/json", object([field("schema", schema)]))]))

def operation(+binding: C.Json) -> C.Json:
  extra = C.choose(List<&2, C.Member>, C.equal(C.get(binding, "method"), C.JStr{"GET"}),
    _ => Nil{}, _ => [field("requestBody", object([
      field("required", C.JBool{True{}}), field("content", request_content(binding))]))])
  object(List.append(&2, C.Member, [
    field("operationId", C.get(binding, "operationId")), field("summary", C.get(binding, "operationId")),
    field("security", C.JArr{[object([field("bearerAuth", C.JArr{Nil{}})])]}),
    field("parameters", parameters(binding)), field("responses", responses(binding))], extra))

def paths(bindings: List<&2, C.Json>) -> List<&2, C.Member>:
  match bindings:
    case Nil{}:
      Nil{}
    case Con{+binding, t}:
      Con{field(C.string(C.get(binding, "path")), object([
        field(String.to_lower(C.string(C.get(binding, "method"))), operation(binding))])), paths(t)}

def normalized(value: C.Json) -> C.Json:
  match value:
    case C.JNum{raw}:
      C.JNum{N.format(Catalog.bound(raw))}
    case C.JArr{Nil{}}:
      C.JArr{Nil{}}
    case C.JArr{Con{h, t}}:
      C.JArr{Con{normalized(h), C.items(normalized(C.JArr{t}))}}
    case C.JObj{Nil{}}:
      C.JObj{Nil{}}
    case C.JObj{Con{C.Member{k, v}, t}}:
      C.JObj{Con{C.Member{k, normalized(v)}, C.members(normalized(C.JObj{t}))}}
    case other:
      other

def document() -> C.Json:
  normalized(object([
    field("openapi", C.JStr{"3.1.0"}),
    field("info", object([field("title", C.JStr{"Atlas Protocol"}), field("version", C.JStr{C.protocol_version()})])),
    field("paths", object(paths(C.items(E.catalog())))),
    field("components", object([
      field("schemas", object(List.append(&2, C.Member, Schemas.definitions(), E.definitions()))),
      field("securitySchemes", object([field("bearerAuth", object([
        field("type", C.JStr{"http"}), field("scheme", C.JStr{"bearer"})]))]))]))]))
