import Base
import ./common.bend as C
import ./exchanges.bend as E
import ./json.bend as J
import ./scalar-rules.bend as S

def invalid(path: String, message: String) -> C.Failure:
  C.Failure{C.InvalidHttp{}, [C.Issue{path, message}]}

def require(ok: Bool, path: String, message: String) -> Result<&2, &2, C.Failure, Unit>:
  match ok:
    case True{}:
      Done{Unit{}}
    case False{}:
      Fail{invalid(path, message)}

def lower(text: String) -> String:
  match text:
    case SNil{}:
      ""
    case SCon{h, t}:
      +n = Char.to_u32(h)
      SCon{Chr{Bool.pick(U32, S.between(n, 65, 90), (n + 32 : U32), n)}, lower(t)}

def header_space(+n: U32) -> Bool:
  U32.is_eq(n, 9) || U32.is_eq(n, 10) || U32.is_eq(n, 13) || U32.is_eq(n, 32)

def regex_space(+n: U32) -> Bool:
  S.between(n, 9, 13) || U32.is_eq(n, 32) || U32.is_eq(n, 160) || U32.is_eq(n, 5760) ||
    S.between(n, 8192, 8202) || S.between(n, 8232, 8233) || U32.is_eq(n, 8239) ||
    U32.is_eq(n, 8287) || U32.is_eq(n, 12288) || U32.is_eq(n, 65279)

def trim_start(~space: U32 -> Bool, text: String) -> String:
  match text:
    case SNil{}:
      ""
    case SCon{+h, +t}:
      C.choose(String, space(Char.to_u32(h)), _ => trim_start(~space, t), _ => SCon{h, t})

def trim(~space: U32 -> Bool, text: String) -> String:
  String.reverse(trim_start(~space, String.reverse(trim_start(~space, text))))

def append_header(prior: C.Json, next: String) -> C.Json:
  match prior:
    case C.JMissing{}:
      C.JStr{next}
    case C.JStr{value}:
      C.JStr{value ++ ", " ++ next}
    case _:
      C.JMissing{}

def find_header(xs: List<&2, C.Json>, +name: String, +acc: C.Json) -> C.Json:
  match xs:
    case Nil{}:
      acc
    case Con{+h, t}:
      +next = C.choose(C.Json, String.eq(lower(C.string(C.get(h, "name"))), name),
        _ => append_header(acc, trim(~(n => header_space(n)), C.string(C.get(h, "value")))), _ => acc)
      find_header(t, name, next)

def header(headers: C.Json, name: String) -> C.Json:
  find_header(C.items(headers), lower(name), C.JMissing{})

def header_message(value: C.Json) -> String:
  Bool.pick(String, E.missing(value), "missing", "invalid")

def context_header(+headers: C.Json, +name: String, uuid: Bool) -> Result<&2, &2, C.Failure, String>:
  +value = header(headers, name)
  +text = C.string(value)
  do Result<&2, &2, C.Failure, String>:
    require(C.choose(Bool, uuid, _ => S.uuid(text),
      _ => S.well_formed(text) && Bool.not(String.is_empty(text)) && Nat.is_le(String.length(text), 4194304n)),
      "header." ++ name, header_message(value))
    return text

def authorization(headers: C.Json) -> Result<&2, &2, C.Failure, Unit>:
  +value = header(headers, "Authorization")
  +text = C.string(value)
  require(String.starts_with(text, "Bearer ") && S.secret(String.drop(text, 7n)),
    "header.Authorization", header_message(value))

def uncompressed(headers: C.Json) -> Result<&2, &2, C.Failure, Unit>:
  require(E.missing(header(headers, "Content-Encoding")), "header.Content-Encoding", "unsupported")

def media_token(text: String) -> Bool:
  match text:
    case SNil{}:
      True{}
    case SCon{h, t}:
      +n = Char.to_u32(h)
      Bool.not(regex_space(n) || U32.is_eq(n, 59)) && media_token(t)

def charset(+text: String) -> Bool:
  +suffix = trim_start(~(n => regex_space(n)), String.drop(text, 7n))
  String.starts_with(text, "charset") && String.starts_with(suffix, "=") &&
    (String.eq(trim_start(~(n => regex_space(n)), String.drop(suffix, 1n)), "utf-8") ||
      String.eq(trim_start(~(n => regex_space(n)), String.drop(suffix, 1n)), "\"utf-8\""))

def media_parts(parts: List<&2, String>) -> Maybe<&2, String>:
  match parts:
    case Con{a, Nil{}}:
      +value = trim(~(n => regex_space(n)), a)
      C.choose(Maybe<&2, String>, Bool.not(String.is_empty(value)) && media_token(value), _ => Some{value}, _ => None{})
    case Con{a, Con{b, Nil{}}}:
      +value = trim(~(n => regex_space(n)), a)
      C.choose(Maybe<&2, String>, Bool.not(String.is_empty(value)) && media_token(value) && charset(trim(~(n => regex_space(n)), b)),
        _ => Some{value}, _ => None{})
    case _:
      None{}

def media_result(value: Maybe<&2, String>) -> Result<&2, &2, C.Failure, String>:
  match value:
    case Some{v}:
      Done{v}
    case None{}:
      Fail{invalid("media", "invalid")}

def media(headers: C.Json) -> Result<&2, &2, C.Failure, String>:
  +value = header(headers, "Content-Type")
  do Result<&2, &2, C.Failure, String>:
    require(E.present(value) && Bool.not(String.is_empty(C.string(value))), "media", "missing")
    media_result(media_parts(String.split(lower(C.string(value)), ';')))

def length(headers: C.Json, actual: U32) -> Result<&2, &2, C.Failure, Unit>:
  +value = header(headers, "Content-Length")
  require(E.missing(value) || String.eq(C.string(value), U32.show(actual)), "header.Content-Length", "invalid")

def same_dataset(value: C.Json, +dataset: C.Json) -> Bool:
  match value:
    case C.JObj{Nil{}}:
      True{}
    case C.JObj{Con{C.Member{+k, +v}, t}}:
      (Bool.not(String.eq(k, "dataset_id")) || C.equal(v, dataset)) &&
        same_dataset(v, dataset) && same_dataset(C.JObj{t}, dataset)
    case C.JArr{Nil{}}:
      True{}
    case C.JArr{Con{h, t}}:
      same_dataset(h, dataset) && same_dataset(C.JArr{t}, dataset)
    case _:
      True{}

def correlation_members(+headers: C.Json) -> List<&2, C.Member>:
  +request = header(headers, "Atlas-Request-ID")
  +attempt = header(headers, "Atlas-Attempt-ID")
  List.append(&2, C.Member,
    Bool.pick(List<&2, C.Member>, S.new_id(C.string(request)), [E.field("requestId", request)], Nil{}),
    Bool.pick(List<&2, C.Member>, S.new_id(C.string(attempt)), [E.field("attemptId", attempt)], Nil{}))

def correlation(headers: C.Json) -> C.Json:
  C.JObj{correlation_members(headers)}

def byte_values(xs: List<&2, C.Json>, +remaining: U32, acc: List<&2, U32>) -> Result<&2, &2, C.Failure, List<&2, U32>>:
  match xs:
    case Nil{}:
      Done{List.reverse(&2, U32, acc)}
    case Con{+h, t}:
      do Result<&2, &2, C.Failure, List<&2, U32>>:
        C.require(U32.is_gt(remaining, 0), C.PayloadTooLarge{})
        +value : U32 = E.uint(h, 256)
        C.require(U32.is_le(value, 255), C.InvalidHttp{})
        byte_values(t, (remaining - 1 : U32), Con{value, acc})

def bytes(value: C.Json, max: U32) -> Result<&2, &2, C.Failure, List<&2, U32>>:
  match value:
    case C.JArr{xs}:
      byte_values(xs, max, Nil{})
    case _:
      Fail{C.failure(C.InvalidHttp{})}

def max_bytes(budget: C.Budget) -> U32:
  match budget:
    case C.Budget{bytes, values, depth, changes, work}:
      bytes

def body_count(xs: List<&2, C.Json>, count: U32) -> U32:
  match xs:
    case Nil{}:
      count
    case Con{h, t}:
      body_count(t, (count + 1 : U32))

def body_length(value: C.Json) -> U32:
  body_count(C.items(value), 0)

def path_characters(text: String) -> Bool:
  match text:
    case SNil{}:
      True{}
    case SCon{h, t}:
      +n = Char.to_u32(h)
      (S.hex(n) || U32.is_eq(n, 45)) && path_characters(t)

def content_path(+path: String) -> Result<&2, &2, C.Failure, C.Json>:
  +id = String.take(String.drop(path, 9n), 36n)
  +suffix = String.drop(path, 45n)
  do Result<&2, &2, C.Failure, C.Json>:
    require(String.starts_with(path, "/objects/") && Nat.is_eq(String.length(id), 36n) && path_characters(id) &&
      (String.eq(suffix, "/content?disposition=inline") || String.eq(suffix, "/content?disposition=attachment")), "path", "mismatch")
    return C.JObj{[E.field("object_id", C.JStr{id}), E.field("disposition", C.JStr{String.drop(suffix, 21n)})]}

def multipart_chars(text: String, +quoted: Bool) -> Bool:
  match text:
    case SNil{}:
      True{}
    case SCon{+h, t}:
      +n = Char.to_u32(h)
      (S.between(n, 48, 57) || S.between(n, 65, 90) || S.between(n, 97, 122) ||
        String.contains(Bool.pick(String, quoted, "'()+_,./:=? -", "'+_.-"), String.from_list([h]))) && multipart_chars(t, quoted)

def boundary_value(+text: String) -> Bool:
  +count = String.length(text)
  C.choose(Bool, String.starts_with(text, "\"") && String.ends_with(text, "\""),
    _ => (count >= 3n : Nat) && (count <= 72n : Nat) &&
      multipart_chars(String.take(String.drop(text, 1n), Nat.sub(count, 2n)), True{}) &&
      Bool.not(String.eq(String.take(String.drop(text, Nat.sub(count, 2n)), 1n), " ")),
    _ => (count >= 1n : Nat) && (count <= 70n : Nat) && multipart_chars(text, False{}))

def multipart(+text: String) -> Bool:
  +suffix = trim_start(~(n => regex_space(n)), String.drop(text, 20n))
  String.starts_with(lower(text), "multipart/form-data;") && String.starts_with(lower(suffix), "boundary=") &&
    boundary_value(String.drop(suffix, 9n))

def parsed_path(value: Result<&2, &2, C.Failure, C.Json>) -> Result<&2, &2, C.Failure, C.Json>:
  match value:
    case Done{x}:
      Done{x}
    case Fail{failure}:
      Fail{invalid("path", "invalid")}

def get_request(
    ~validate: String -> String -> C.Json -> C.Json -> Result<&2, &2, C.Failure, C.Json>,
    +operation: String, +incoming: C.Json, +definition: C.Json) -> Result<&2, &2, C.Failure, C.Json>:
  +headers = C.get(incoming, "headers")
  +transport = C.string(C.get(definition, "transport"))
  do Result<&2, &2, C.Failure, C.Json>:
    require(U32.is_zero(body_length(C.get(incoming, "body"))) && Bool.not(C.has(incoming, "uploadDescriptor")), "body", "unsupported")
    length(headers, 0)
    require(Bool.not(String.eq(transport, "reference")) ||
      C.equal(header(headers, "Accept"), C.JStr{"application/vnd.oai.openapi+json"}) ||
      C.equal(header(headers, "Accept"), C.JStr{"text/html"}), "media", "unsupported")
    value : C.Json <- C.choose(Result<&2, &2, C.Failure, C.Json>, String.eq(transport, "content"),
      _ => content_path(C.string(C.get(incoming, "path"))),
      _ => do Result<&2, &2, C.Failure, C.Json>:
        require(E.same_field(incoming, "path", definition, "path"), "path", "mismatch")
        return C.JObj{Nil{}})
    parsed_path(validate("Request." ++ operation, "http_request", value, C.JObj{Nil{}}))

def read_request(
    ~read: String -> String -> List<&2, U32> -> C.Json -> Result<&2, &2, C.Failure, C.Json>,
    ~validate: String -> String -> C.Json -> C.Json -> Result<&2, &2, C.Failure, C.Json>,
    ~budget: String -> C.Json -> Result<&2, &2, C.Failure, C.Budget>,
    +operation: String, +incoming: C.Json, +lower_budget: C.Json) -> Result<&2, &2, C.Failure, C.Json>:
  +definition = E.binding(operation)
  +headers = C.get(incoming, "headers")
  +transport = C.string(C.get(definition, "transport"))
  do Result<&2, &2, C.Failure, C.Json>:
    +effective : C.Budget <- budget("http_request", lower_budget)
    C.require(E.present(definition), C.InvalidHttp{})
    uncompressed(headers)
    require(E.same_field(incoming, "method", definition, "method"), "method", "mismatch")
    authorization(headers)
    +dataset : C.Json <- C.choose(Result<&2, &2, C.Failure, C.Json>, C.equal(C.get(definition, "discovery"), C.JBool{True{}}),
      _ => Done{C.JMissing{}},
      _ => do Result<&2, &2, C.Failure, C.Json>:
        value : String <- context_header(headers, "Atlas-Dataset-ID", True{})
        version : String <- context_header(headers, "Atlas-Protocol-Version", False{})
        require(String.eq(version, C.protocol_version()), "header.Atlas-Protocol-Version", "mismatch")
        return C.JStr{value})
    C.choose(Result<&2, &2, C.Failure, C.Json>, C.equal(C.get(definition, "method"), C.JStr{"GET"}),
      _ => get_request(~validate, operation, incoming, definition),
      _ => do Result<&2, &2, C.Failure, C.Json>:
        require(E.same_field(incoming, "path", definition, "path"), "path", "mismatch")
        +body : C.Json <- C.choose(Result<&2, &2, C.Failure, C.Json>, String.eq(transport, "upload"),
          _ => do Result<&2, &2, C.Failure, C.Json>:
            require(multipart(C.string(header(headers, "Content-Type"))) && Bool.not(C.has(incoming, "body")), "media", "invalid")
            return C.get(incoming, "uploadDescriptor"),
          _ => do Result<&2, &2, C.Failure, C.Json>:
            media_type : String <- media(headers)
            require(C.equal(C.JStr{media_type}, C.get(definition, "requestMedia")), "media", "unsupported")
            return C.get(incoming, "body"))
        require(E.present(body), "body", "missing")
        C.choose(Result<&2, &2, C.Failure, Unit>, String.eq(transport, "upload"),
          _ => Done{Unit{}}, _ => length(headers, body_length(body)))
        raw : List<&2, U32> <- bytes(body, max_bytes(effective))
        +value : C.Json <- read("Request." ++ operation, "http_request", raw, lower_budget)
        C.require(E.missing(dataset) || same_dataset(value, dataset), C.InvalidHttp{})
        return value)

def budget_json(value: C.Budget) -> C.Json:
  match value:
    case C.Budget{bytes, values, depth, changes, work}:
      C.JObj{[E.field("maxBytes", C.JNum{U32.show(bytes)}), E.field("maxValues", C.JNum{U32.show(values)}),
        E.field("maxDepth", C.JNum{U32.show(depth)}), E.field("maxChanges", C.JNum{U32.show(changes)}),
        E.field("maxGeometryWork", C.JNum{U32.show(work)})]}

def message_budget(base: C.Budget, +limits: C.Json) -> C.Budget:
  match base:
    case C.Budget{+bytes, +values, depth, +changes, work}:
      C.Budget{U32.min(bytes, E.uint(C.get(limits, "max_message_bytes"), bytes)),
        U32.min(values, E.uint(C.get(limits, "max_json_values"), values)), depth,
        U32.min(changes, E.uint(C.get(limits, "max_changes"), changes)), work}

def response_lower(+operation: String, +request: C.Json, +base: C.Budget, +lower_budget: C.Json) -> C.Json:
  C.choose(C.Json, (String.eq(operation, "ReadSnapshot") || String.eq(operation, "ReadChanges")) &&
    E.present(request) && Bool.not(C.has(request, "page_token")),
    _ => budget_json(message_budget(base, request)), _ => lower_budget)

def decode_char(utf: J.Utf, acc: String) -> J.Utf & String:
  match utf:
    case J.Utf{0n, +scalar, lo, hi}:
      (J.Utf{0n, scalar, lo, hi}, SCon{Chr{scalar}, acc})
    case u:
      (u, acc)

def decode_utf8(xs: List<&2, U32>, state: J.Utf & String) -> Result<&2, &2, C.Failure, String>:
  match xs state:
    case Nil{} Tuple{utf, acc}:
      do Result<&2, &2, C.Failure, String>:
        J.utf_end(utf)
        return String.reverse(acc)
    case Con{b, t} Tuple{utf, acc}:
      do Result<&2, &2, C.Failure, String>:
        next : J.Utf <- J.utf_step(b, utf)
        decode_utf8(t, decode_char(next, acc))

def utf8(+bytes: List<&2, U32>) -> Result<&2, &2, C.Failure, String>:
  do Result<&2, &2, C.Failure, String>:
    J.utf_check(bytes, J.Utf{0n, 0, 128, 191})
    decode_utf8(bytes, (J.Utf{0n, 0, 128, 191}, ""))

def content_header(value: C.Json) -> C.Json:
  match value:
    case C.JMissing{}:
      C.JNull{}
    case x:
      x

def parsed_content(result: Result<&2, &2, C.Failure, C.Json>) -> Result<&2, &2, C.Failure, C.Json>:
  match result:
    case Done{x}:
      Done{x}
    case Fail{failure}:
      Fail{C.failure(C.InvalidHttp{})}

def content_response(
    ~validate: String -> String -> C.Json -> C.Json -> Result<&2, &2, C.Failure, C.Json>,
    +request: C.Json, +received: C.Json) -> Result<&2, &2, C.Failure, C.Json>:
  +headers = C.get(received, "headers")
  do Result<&2, &2, C.Failure, C.Json>:
    C.require(E.present(request) && Bool.not(C.has(received, "body")), C.InvalidHttp{})
    +descriptor : C.Json <- parsed_content(validate("ContentDescriptor", "http_response",
      C.JObj{[E.field("object_id", C.get(request, "object_id")),
        E.field("byte_length", content_header(header(headers, "Content-Length"))),
        E.field("sha256", content_header(header(headers, "Atlas-Content-SHA256"))),
        E.field("content_type", content_header(header(headers, "Content-Type"))),
        E.field("disposition", content_header(header(headers, "Content-Disposition")))]}, C.JObj{Nil{}}))
    C.require(E.same_field(request, "disposition", descriptor, "disposition"), C.InvalidHttp{})
    return C.JObj{[E.field("kind", C.JStr{"content"}), E.field("status", C.get(received, "status")), E.field("descriptor", descriptor)]}

def reference_response(+received: C.Json, +context: C.Json, +effective: C.Budget) -> Result<&2, &2, C.Failure, C.Json>:
  +headers = C.get(received, "headers")
  +body = C.get(received, "body")
  do Result<&2, &2, C.Failure, C.Json>:
    C.require(E.present(body) && U32.is_le(body_length(body), max_bytes(effective)), C.PayloadTooLarge{})
    +media_type : String <- media(headers)
    C.require((String.eq(media_type, "application/vnd.oai.openapi+json") || String.eq(media_type, "text/html")) &&
      (Bool.not(C.has(context, "referenceMedia")) || C.equal(C.get(context, "referenceMedia"), C.JStr{media_type})), C.InvalidHttp{})
    length(headers, body_length(body))
    +raw : List<&2, U32> <- bytes(body, max_bytes(effective))
    document : String <- utf8(raw)
    C.choose(Result<&2, &2, C.Failure, Unit>, String.eq(media_type, "application/vnd.oai.openapi+json"),
      _ => J.check(raw, effective), _ => Done{Unit{}})
    return C.JObj{[E.field("kind", C.JStr{"reference"}), E.field("status", C.get(received, "status")),
      E.field("media", C.JStr{media_type}), E.field("document", C.JStr{document})]}

def error_context(+envelope: C.Json, +version: String) -> Bool:
  +error = C.get(envelope, "error")
  +mismatch = C.equal(C.get(error, "code"), C.JStr{"protocol_mismatch"})
  (Bool.not(mismatch && C.has(error, "details")) ||
    C.equal(C.get(C.get(error, "details"), "protocol_version"), C.JStr{version})) &&
    (String.eq(version, C.protocol_version()) || mismatch)

def json_response(
    ~read: String -> String -> List<&2, U32> -> C.Json -> Result<&2, &2, C.Failure, C.Json>,
    ~fold: String -> String,
    +operation: String, +received: C.Json, +request: C.Json, +lower_budget: C.Json,
    dataset: String, +version: String, +success: Bool, +status: U32, +effective: C.Budget) -> Result<&2, &2, C.Failure, C.Json>:
  +headers = C.get(received, "headers")
  +body = C.get(received, "body")
  do Result<&2, &2, C.Failure, C.Json>:
    C.require(E.present(body), C.InvalidHttp{})
    media_type : String <- media(headers)
    C.require(String.eq(media_type, "application/json"), C.InvalidHttp{})
    length(headers, body_length(body))
    raw : List<&2, U32> <- bytes(body, max_bytes(effective))
    +envelope : C.Json <- read(Bool.pick(String, success, "Success." ++ operation, "Exchange.ErrorEnvelope." ++ U32.show(status)),
      "http_response", raw, response_lower(operation, request, effective, lower_budget))
    C.require(same_dataset(envelope, C.JStr{dataset}), C.InvalidHttp{})
    C.choose(Result<&2, &2, C.Failure, Unit>, success,
      _ => E.check_response(~fold, operation, request, envelope, status, version),
      _ => C.require(error_context(envelope, version), C.InvalidHttp{}))
    return C.JObj{[E.field("kind", C.JStr{Bool.pick(String, success, "success", "error")}),
      E.field("status", C.get(received, "status")), E.field("body", envelope)]}

def read_response(
    ~read: String -> String -> List<&2, U32> -> C.Json -> Result<&2, &2, C.Failure, C.Json>,
    ~validate: String -> String -> C.Json -> C.Json -> Result<&2, &2, C.Failure, C.Json>,
    ~budget: String -> C.Json -> Result<&2, &2, C.Failure, C.Budget>,
    ~fold: String -> String,
    +operation: String, +received: C.Json, +context: C.Json) -> Result<&2, &2, C.Failure, C.Json>:
  +definition = E.binding(operation)
  +headers = C.get(received, "headers")
  +lower_budget = C.get(context, "budget")
  +status = E.uint(C.get(received, "status"), 0)
  +success = E.includes(C.items(C.get(definition, "successStatuses")), C.JNum{U32.show(status)})
  +transport = C.string(C.get(definition, "transport"))
  do Result<&2, &2, C.Failure, C.Json>:
    +effective : C.Budget <- budget("http_response", lower_budget)
    C.require(E.present(definition), C.InvalidHttp{})
    uncompressed(headers)
    +dataset : String <- context_header(headers, "Atlas-Dataset-ID", True{})
    +version : String <- context_header(headers, "Atlas-Protocol-Version", False{})
    C.require(Bool.not(success) || (String.eq(version, C.protocol_version()) &&
      (Bool.not(C.has(context, "datasetId")) || C.equal(C.get(context, "datasetId"), C.JStr{dataset}))), C.InvalidHttp{})
    +request : C.Json <- C.choose(Result<&2, &2, C.Failure, C.Json>, success && C.has(context, "request"),
      _ => validate("Request." ++ operation, "http_request", C.get(context, "request"), lower_budget),
      _ => Done{C.JMissing{}})
    C.choose(Result<&2, &2, C.Failure, C.Json>, success && String.eq(transport, "content"),
      _ => content_response(~validate, request, received),
      _ => C.choose(Result<&2, &2, C.Failure, C.Json>, success && String.eq(transport, "reference"),
        _ => reference_response(received, context, effective),
        _ => json_response(~read, ~fold, operation, received, request, lower_budget, dataset, version, success, status, effective)))
