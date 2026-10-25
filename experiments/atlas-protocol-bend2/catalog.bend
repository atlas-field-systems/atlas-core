import Base
import ./common.bend as C
import ./numbers.bend as N

def plain_name(+name: String) -> String:
  +without_ref = C.choose(String, String.starts_with(name, "#/components/schemas/"),
    _ => String.drop(name, 21n), _ => name)
  C.choose(String, String.eq(without_ref, "Wss.ClientFrame"), _ => "ClientFrame",
    _ => C.choose(String, String.eq(without_ref, "Wss.ServerFrame"), _ => "ServerFrame", _ => without_ref))

def resolve(registry: List<&2, C.Member>, name: String) -> C.Json:
  C.lookup(registry, plain_name(name))

def bound(+raw: String) -> String:
  C.choose(String, Nat.is_gt(String.length(raw), 128n),
    _ => C.choose(String, String.starts_with(raw, "-"),
      _ => "-1.7976931348623157e308", _ => "1.7976931348623157e308"), _ => raw)

def numeric(raw: String, minimum: String, maximum: String, integer: Bool,
    exclusive_minimum: Bool, exclusive_maximum: Bool) -> Bool:
  N.accept(raw, bound(minimum), bound(maximum), integer, exclusive_minimum, exclusive_maximum)
