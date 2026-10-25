import Base
import ../common.bend as C
import ../exchanges.bend as E
import ../http.bend as H
import ../json.bend as J

def rejected(result: Result<&2, &2, C.Failure, Unit>) -> Bool:
  match result:
    case Fail{C.Failure{C.InvalidHttp{}, issues}}:
      True{}
    case _:
      False{}

def verify() -> Result<&2, &2, C.Failure, Unit>:
  +request = {C.JObj{[E.field("task_id", C.JStr{"55555555-5555-4555-8555-555555555555"})]} : C.Json}
  +body = {C.JObj{[E.field("data", C.JObj{[E.field("task_id", C.JStr{"55555555-5555-4555-8555-555555555555"})]})]} : C.Json}
  do Result<&2, &2, C.Failure, Unit>:
    E.check_response(~(text => text), "GetTask", request, body, 200, "0.1.0")
    C.require(rejected(E.check_response(~(text => text), "GetTask", C.JObj{[E.field("task_id", C.JStr{"different"})]}, body, 200, "0.1.0")), C.InvalidValue{})
    +path : C.Json <- H.content_path("/objects/11111111-1111-4111-8111-111111111111/content?disposition=attachment")
    C.require(C.equal(C.get(path, "disposition"), C.JStr{"attachment"}), C.InvalidValue{})
    C.require(H.multipart("multipart/form-data; boundary=\"native boundary\""), C.InvalidValue{})
    C.require(Bool.not(H.multipart("multipart/form-data; boundary=\"trailing \"")), C.InvalidValue{})
    text : String <- H.utf8([239, 187, 191, 240, 159, 152, 128])
    C.require(String.eq(text, "﻿😀"), C.InvalidValue{})
    C.require(Nat.is_eq(List.length(&2, C.Member, E.definitions()), 208n), C.InvalidValue{})
    C.require(Nat.is_eq(List.length(&2, C.Json, C.items(E.catalog())), 66n), C.InvalidValue{})
    return Unit{}

def report(result: Result<&2, &2, C.Failure, Unit>) -> IO(Unit):
  match result:
    case Done{value}:
      IO.print("Native exchange, route, content, multipart, and UTF8 checks passed.")
    case Fail{C.Failure{code, issues}}:
      IO.die(Unit, 1, C.code_name(code))

def main() -> IO(Unit):
  report(verify())
