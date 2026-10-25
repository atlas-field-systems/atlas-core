import Base
import ./api.bend as Api
import ./common.bend as C
import ./json.bend as J
import ./budget.bend as B
import ./http.bend as H

type Command is Data:
  JsonCommand{write: Bool, schema: String, path: String, boundary: String, budget: Maybe<&2, String>}
  CheckCommand{path: String, boundary: String, budget: Maybe<&2, String>}
  WssCommand{server: Bool, path: String, context: Maybe<&2, String>}
  HttpRequestCommand{operation: String, path: String, budget: Maybe<&2, String>}
  HttpResponseCommand{operation: String, path: String, context: Maybe<&2, String>}
  CatalogCommand{}
  SchemasCommand{}
  ReferenceCommand{}
  HelpCommand{}
  UsageCommand{}

def usage() -> String:
  "atlas-protocol read SCHEMA FILE [BOUNDARY] [BUDGET_FILE]\natlas-protocol write SCHEMA FILE [BOUNDARY] [BUDGET_FILE]\natlas-protocol check FILE [BOUNDARY] [BUDGET_FILE]\natlas-protocol wss-client FILE [CONTEXT_FILE]\natlas-protocol wss-server FILE [CONTEXT_FILE]\natlas-protocol http-request OPERATION DESCRIPTOR_FILE [BUDGET_FILE]\natlas-protocol http-response OPERATION DESCRIPTOR_FILE [CONTEXT_FILE]\natlas-protocol catalog\natlas-protocol schemas\natlas-protocol reference\natlas-protocol help\nBOUNDARY defaults to http_request.\n"

def json_arguments(args: List<&2, String>, write: Bool) -> Command:
  match args:
    case Con{schema, Con{path, Nil{}}}:
      JsonCommand{write, schema, path, "http_request", None{}}
    case Con{schema, Con{path, Con{boundary, Nil{}}}}:
      JsonCommand{write, schema, path, boundary, None{}}
    case Con{schema, Con{path, Con{boundary, Con{budget, Nil{}}}}}:
      JsonCommand{write, schema, path, boundary, Some{budget}}
    case _:
      UsageCommand{}

def check_arguments(args: List<&2, String>) -> Command:
  match args:
    case Con{path, Nil{}}:
      CheckCommand{path, "http_request", None{}}
    case Con{path, Con{boundary, Nil{}}}:
      CheckCommand{path, boundary, None{}}
    case Con{path, Con{boundary, Con{budget, Nil{}}}}:
      CheckCommand{path, boundary, Some{budget}}
    case _:
      UsageCommand{}

def wss_arguments(args: List<&2, String>, server: Bool) -> Command:
  match args:
    case Con{path, Nil{}}:
      WssCommand{server, path, None{}}
    case Con{path, Con{context, Nil{}}}:
      WssCommand{server, path, Some{context}}
    case _:
      UsageCommand{}

def http_arguments(args: List<&2, String>, response: Bool) -> Command:
  match args:
    case Con{+operation, Con{+path, Nil{}}}:
      Bool.pick(Command, response, HttpResponseCommand{operation, path, None{}},
        HttpRequestCommand{operation, path, None{}})
    case Con{+operation, Con{+path, Con{+context, Nil{}}}}:
      Bool.pick(Command, response, HttpResponseCommand{operation, path, Some{context}},
        HttpRequestCommand{operation, path, Some{context}})
    case _:
      UsageCommand{}

def no_arguments(args: List<&2, String>, command: Command) -> Command:
  match args:
    case Nil{}:
      command
    case _:
      UsageCommand{}

def arguments(args: List<&2, String>) -> Command:
  match args:
    case Nil{}:
      UsageCommand{}
    case Con{+name, +rest}:
      C.choose(Command, String.eq(name, "read"), _ => json_arguments(rest, False{}),
        _ => C.choose(Command, String.eq(name, "write"), _ => json_arguments(rest, True{}),
        _ => C.choose(Command, String.eq(name, "check"), _ => check_arguments(rest),
        _ => C.choose(Command, String.eq(name, "wss-client"), _ => wss_arguments(rest, False{}),
        _ => C.choose(Command, String.eq(name, "wss-server"), _ => wss_arguments(rest, True{}),
        _ => C.choose(Command, String.eq(name, "http-request"), _ => http_arguments(rest, False{}),
        _ => C.choose(Command, String.eq(name, "http-response"), _ => http_arguments(rest, True{}),
        _ => C.choose(Command, String.eq(name, "catalog"), _ => no_arguments(rest, CatalogCommand{}),
        _ => C.choose(Command, String.eq(name, "schemas"), _ => no_arguments(rest, SchemasCommand{}),
        _ => C.choose(Command, String.eq(name, "reference"), _ => no_arguments(rest, ReferenceCommand{}),
        _ => C.choose(Command, String.eq(name, "help"), _ => no_arguments(rest, HelpCommand{}),
        _ => UsageCommand{})))))))))))

def budget_bytes(budget: C.Budget) -> U32:
  match budget:
    case C.Budget{bytes, values, depth, changes, work}:
      bytes

def failure_code(failure: C.Failure) -> C.Code:
  match failure:
    case C.Failure{code, issues}:
      code

def io_failure(message: String) -> C.Failure:
  C.Failure{C.InvalidValue{}, [C.Issue{"$", message}]}

def checked_read(result: Result<&1, &1, U32 & String, List<&2, U32>>,
    +cap: U32, +size: U32) -> Result<&2, &2, C.Failure, List<&2, U32>>:
  match result:
    case Fail{error}:
      Fail{io_failure("Unable to read input file.")}
    case Done{+bytes}:
      do Result<&2, &2, C.Failure, List<&2, U32>>:
        count : U32 <- J.bytes_count(bytes, cap, 0)
        C.require((count <= size : U32), C.InvalidValue{})
        return bytes

def read_closed(read: File & Result<&1, &1, U32 & String, List<&2, U32>>,
    cap: U32, size: U32) -> IO(Result<&2, &2, C.Failure, List<&2, U32>>):
  (owned, result) = read
  do IO<Result<&2, &2, C.Failure, List<&2, U32>>>:
    File.close(owned)
    return checked_read(result, cap, size)

def read_within(over: Bool, file: File, +cap: U32, size: U32) -> IO(Result<&2, &2, C.Failure, List<&2, U32>>):
  match over:
    case True{}:
      do IO<Result<&2, &2, C.Failure, List<&2, U32>>>:
        File.close(file)
        return Fail{C.failure(C.PayloadTooLarge{})}
    case False{}:
      do IO<Result<&2, &2, C.Failure, List<&2, U32>>>:
        read : File & Result<&1, &1, U32 & String, List<&2, U32>> <- File.read_bytes(file, (cap + 1 : U32))
        read_closed(read, cap, size)

def read_sized(result: Result<&1, &1, U32 & String, U32>, file: File,
    +cap: U32) -> IO(Result<&2, &2, C.Failure, List<&2, U32>>):
  match result:
    case Fail{error}:
      do IO<Result<&2, &2, C.Failure, List<&2, U32>>>:
        File.close(file)
        return Fail{io_failure("Unable to measure input file.")}
    case Done{+size}:
      read_within((size > cap : U32), file, cap, size)

def read_measured(sized: File & Result<&1, &1, U32 & String, U32>, cap: U32) -> IO(Result<&2, &2, C.Failure, List<&2, U32>>):
  (owned, size) = sized
  read_sized(size, owned, cap)

def read_opened(result: Result<&1, &1, U32 & String, File>, cap: U32) -> IO(Result<&2, &2, C.Failure, List<&2, U32>>):
  match result:
    case Fail{error}:
      IO.pure(Result<&2, &2, C.Failure, List<&2, U32>>, Fail{io_failure("Unable to open input file.")})
    case Done{file}:
      do IO<Result<&2, &2, C.Failure, List<&2, U32>>>:
        sized : File & Result<&1, &1, U32 & String, U32> <- File.size(file)
        read_measured(sized, cap)

def read_file(path: String, cap: U32) -> IO(Result<&2, &2, C.Failure, List<&2, U32>>):
  do IO<Result<&2, &2, C.Failure, List<&2, U32>>>:
    opened : Result<&1, &1, U32 & String, File> <- File.open(path, "r")
    read_opened(opened, cap)

def issue_json(fuel: Nat, issues: List<&2, C.Issue>) -> List<&2, C.Json>:
  match fuel issues:
    case 1n+p Con{C.Issue{path, message}, rest}:
      Con{C.JObj{[C.Member{"path", C.JStr{String.take(path, 128n)}},
        C.Member{"message", C.JStr{String.take(message, 256n)}}]}, issue_json(p, rest)}
    case _ _:
      Nil{}

def error_json(failure: C.Failure) -> C.Json:
  match failure:
    case C.Failure{code, issues}:
      C.JObj{[C.Member{"code", C.JStr{C.code_name(code)}},
        C.Member{"issues", C.JArr{issue_json(4n, issues)}}]}

def line(bytes: List<&2, U32>) -> List<&2, U32>:
  List.append(&2, U32, bytes, [10])

def reject_text(-A: Data, result: Result<&2, &2, C.Failure, String>, code: String) -> IO(A):
  match result:
    case Done{text}:
      IO.die(A, 1, text)
    case Fail{error}:
      IO.die(A, 1, "{\"code\":\"" ++ code ++ "\",\"issues\":[{\"path\":\"$\",\"message\":\"Unable to encode diagnostic.\"}]}")

def reject(-A: Data, +failure: C.Failure) -> IO(A):
  reject_text(A, H.utf8(List.reverse(&2, U32, J.emit(error_json(failure), True{}, Nil{}))),
    C.code_name(failure_code(failure)))

def unwrap(-A: Data, result: Result<&2, &2, C.Failure, A>) -> IO(A):
  match result:
    case Done{value}:
      IO.pure(A, value)
    case Fail{failure}:
      reject(A, failure)

def output(bytes: List<&2, U32>) -> IO(Unit):
  do IO<Unit>:
    text : String <- unwrap(String, H.utf8(line(bytes)))
    IO.write(text)

def json_output(value: C.Json) -> IO(Unit):
  do IO<Unit>:
    bytes : List<&2, U32> <- unwrap(List<&2, U32>, J.encode(value, C.Budget{25165824, 4300000, 64, 1000, 4194304}))
    output(bytes)

def input(path: String, cap: U32) -> IO(List<&2, U32>):
  do IO<List<&2, U32>>:
    result : Result<&2, &2, C.Failure, List<&2, U32>> <- read_file(path, cap)
    unwrap(List<&2, U32>, result)

def json_file(path: String, +budget: C.Budget) -> IO(C.Json):
  do IO<C.Json>:
    bytes : List<&2, U32> <- input(path, budget_bytes(budget))
    unwrap(C.Json, J.parse(bytes, budget))

def optional_context(path: Maybe<&2, String>) -> IO(C.Json):
  match path:
    case None{}:
      IO.pure(C.Json, C.JObj{Nil{}})
    case Some{file}:
      json_file(file, C.Budget{1048576, 65536, 64, 1000, 4194304})

def read_or_write(write: Bool, +schema: String, +boundary: String,
    bytes: List<&2, U32>, +lower: C.Json, budget: C.Budget) -> IO(Unit):
  match write:
    case False{}:
      do IO<Unit>:
        value : C.Json <- unwrap(C.Json, Api.read_json(schema, boundary, bytes, lower))
        json_output(value)
    case True{}:
      do IO<Unit>:
        value : C.Json <- unwrap(C.Json, J.parse(bytes, budget))
        encoded : List<&2, U32> <- unwrap(List<&2, U32>, Api.write_json(schema, boundary, value, lower))
        output(encoded)

def execute(command: Command) -> IO(Unit):
  match command:
    case JsonCommand{write, schema, +path, +boundary, budget_file}:
      do IO<Unit>:
        +lower : C.Json <- optional_context(budget_file)
        +budget : C.Budget <- unwrap(C.Budget, B.effective(boundary, lower))
        bytes : List<&2, U32> <- input(path, budget_bytes(budget))
        read_or_write(write, schema, boundary, bytes, lower, budget)
    case CheckCommand{path, +boundary, budget_file}:
      do IO<Unit>:
        +lower : C.Json <- optional_context(budget_file)
        budget : C.Budget <- unwrap(C.Budget, B.effective(boundary, lower))
        bytes : List<&2, U32> <- input(path, budget_bytes(budget))
        unwrap(Unit, Api.check_json(bytes, boundary, lower))
        json_output(C.JNull{})
    case WssCommand{+server, path, context_file}:
      do IO<Unit>:
        +context : C.Json <- optional_context(context_file)
        boundary : String = Bool.pick(String, server, "wss_data", "wss_control")
        budget : C.Budget <- unwrap(C.Budget, B.effective(boundary, C.get(context, "budget")))
        +bytes : List<&2, U32> <- input(path, budget_bytes(budget))
        value : C.Json <- unwrap(C.Json, C.choose(Result<&2, &2, C.Failure, C.Json>, server,
          _ => Api.read_wss_server(bytes, context), _ => Api.read_wss_client(bytes, context)))
        json_output(value)
    case HttpRequestCommand{operation, path, budget_file}:
      do IO<Unit>:
        lower : C.Json <- optional_context(budget_file)
        incoming : C.Json <- json_file(path, C.Budget{25165824, 4300000, 64, 1000, 4194304})
        value : C.Json <- unwrap(C.Json, Api.read_http_request(operation, incoming, lower))
        json_output(value)
    case HttpResponseCommand{operation, path, context_file}:
      do IO<Unit>:
        context : C.Json <- optional_context(context_file)
        received : C.Json <- json_file(path, C.Budget{25165824, 4300000, 64, 1000, 4194304})
        value : C.Json <- unwrap(C.Json, Api.read_http(operation, received, context))
        json_output(value)
    case CatalogCommand{}:
      json_output(Api.exchange_catalog())
    case SchemasCommand{}:
      json_output(Api.schema_names())
    case ReferenceCommand{}:
      json_output(Api.reference_document())
    case HelpCommand{}:
      output(List.reverse(&2, U32, J.emit_raw(usage(), Nil{})))
    case UsageCommand{}:
      IO.die(Unit, 2, usage())

def copy_args(args: List<String>) -> List<&2, String>:
  match args:
    case Nil{}:
      Nil{}
    case Con{head, tail}:
      Con{head, copy_args(tail)}

def program(args: List<&2, String>) -> IO(Unit):
  match args:
    case Con{program_name, rest}:
      execute(arguments(rest))
    case Nil{}:
      execute(UsageCommand{})

def main() -> IO(Unit):
  do IO<Unit>:
    args : List<String> <- IO.args()
    program(copy_args(args))
