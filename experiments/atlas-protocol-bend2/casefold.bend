import Base
import ./common.bend as C
import ./unicode-data.bend as U

def lookup(table: U.Table, +code: U32) -> String:
  match table:
    case U.Empty{}:
      String.from_list([Char.from_u32(code)])
    case U.Node{+key, text, left, right}:
      C.choose(String, U32.is_eq(key, code), _ => text,
        _ => C.choose(String, U32.is_lt(code, key),
          _ => lookup(left, code), _ => lookup(right, code)))

def fold_with(text: String, +table: U.Table) -> String:
  match text:
    case SNil{}:
      ""
    case SCon{h, t}:
      lookup(table, Char.to_u32(h)) ++ fold_with(t, table)

def fold(text: String) -> String:
  fold_with(text, U.table())
