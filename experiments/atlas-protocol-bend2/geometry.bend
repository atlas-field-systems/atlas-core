import Base
import ./common.bend as C
import ./numbers.bend as N

type Point is Data:
  Point{x: N.Exact, y: N.Exact}

type Edge is Data:
  Edge{a: Point, b: Point, min_x: N.Exact, max_x: N.Exact, min_y: N.Exact, max_y: N.Exact}

def first(xs: List<&2, C.Json>) -> C.Json:
  match xs:
    case Nil{}:
      C.JMissing{}
    case Con{h, t}:
      h

def number_result(value: Maybe<&2, N.Exact>) -> Result<&2, &2, C.Failure, N.Exact>:
  match value:
    case Some{x}:
      Done{x}
    case None{}:
      Fail{C.failure(C.InvalidGeometry{})}

def number(value: C.Json) -> Result<&2, &2, C.Failure, N.Exact>:
  match value:
    case C.JNum{raw}:
      number_result(N.read(raw))
    case _:
      Fail{C.failure(C.InvalidGeometry{})}

def point(value: C.Json) -> Result<&2, &2, C.Failure, Point>:
  match value:
    case C.JArr{Con{x, Con{y, Nil{}}}}:
      do Result<&2, &2, C.Failure, Point>:
        px : N.Exact <- number(x)
        py : N.Exact <- number(y)
        return Point{px, py}
    case _:
      Fail{C.failure(C.InvalidGeometry{})}

def points(xs: List<&2, C.Json>) -> Result<&2, &2, C.Failure, List<&2, Point>>:
  match xs:
    case Nil{}:
      Done{Nil{}}
    case Con{h, t}:
      do Result<&2, &2, C.Failure, List<&2, Point>>:
        p : Point <- point(h)
        ps : List<&2, Point> <- points(t)
        return Con{p, ps}

def same(a: Point, b: Point) -> Bool:
  match a b:
    case Point{ax, ay} Point{bx, by}:
      N.equal(ax, bx) && N.equal(ay, by)

def min(+a: N.Exact, +b: N.Exact) -> N.Exact:
  C.choose(N.Exact, Cmp.is_lt(N.cmp(a, b)), _ => a, _ => b)

def max(+a: N.Exact, +b: N.Exact) -> N.Exact:
  C.choose(N.Exact, Cmp.is_gt(N.cmp(a, b)), _ => a, _ => b)

def abs(a: N.Exact) -> N.Exact:
  match a:
    case N.Exact{s, m}:
      N.Exact{False{}, m}

def integer(value: U32) -> N.Exact:
  N.Exact{False{}, N.mag_shl(1074, N.mag_single(value))}

def between(+value: N.Exact, +a: N.Exact, +b: N.Exact) -> Bool:
  Cmp.is_ge(N.cmp(value, min(a, b))) && Cmp.is_le(N.cmp(value, max(a, b)))

def on_segment(a: Point, b: Point, c: Point) -> Bool:
  match a b c:
    case Point{ax, ay} Point{bx, by} Point{cx, cy}:
      between(cx, ax, bx) && between(cy, ay, by)

def orientation(a: Point, b: Point, c: Point) -> N.Exact:
  match a b c:
    case Point{+ax, +ay} Point{bx, by} Point{cx, cy}:
      N.sub(N.mul(N.sub(bx, ax), N.sub(cy, ay)), N.mul(N.sub(by, ay), N.sub(cx, ax)))

def sign(a: N.Exact) -> Cmp:
  N.cmp(a, N.zero())

def opposite(+a: N.Exact, +b: N.Exact) -> Bool:
  Bool.not(N.is_zero(a)) && Bool.not(N.is_zero(b)) &&
    Bool.xor(Cmp.is_lt(sign(a)), Cmp.is_lt(sign(b)))

def intersects(+a: Point, +b: Point, +c: Point, +d: Point) -> Bool:
  +x = orientation(a, b, c)
  +y = orientation(a, b, d)
  +p = orientation(c, d, a)
  +q = orientation(c, d, b)
  (N.is_zero(x) && on_segment(a, b, c)) ||
    (N.is_zero(y) && on_segment(a, b, d)) ||
    (N.is_zero(p) && on_segment(c, d, a)) ||
    (N.is_zero(q) && on_segment(c, d, b)) || (opposite(x, y) && opposite(p, q))

def edge(a: Point, b: Point) -> Edge:
  match a b:
    case Point{+ax, +ay} Point{+bx, +by}:
      Edge{Point{ax, ay}, Point{bx, by}, min(ax, bx), max(ax, bx), min(ay, by), max(ay, by)}

def edges(xs: List<&2, Point>) -> List<&2, Edge>:
  match xs:
    case Con{a, Con{+b, +t}}:
      Con{edge(a, b), edges(Con{b, t})}
    case _:
      Nil{}

def edge_intersects(a: Edge, b: Edge) -> Bool:
  match a b:
    case Edge{+pa, +pb, +ax, +bx, +ay, +by} Edge{+pc, +pd, +cx, +dx, +cy, +dy}:
      C.choose(Bool, Cmp.is_lt(N.cmp(bx, cx)) || Cmp.is_lt(N.cmp(dx, ax)) ||
        Cmp.is_lt(N.cmp(by, cy)) || Cmp.is_lt(N.cmp(dy, ay)),
        _ => False{}, _ => intersects(pa, pb, pc, pd))

def no_edges(xs: List<&2, Edge>) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case Con{h, t}:
      False{}

def separated(xs: List<&2, Edge>, +a: Edge, adjacent: Bool, +closing: Bool) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case Con{+h, +t}:
      (adjacent || (closing && no_edges(t)) || Bool.not(edge_intersects(a, h))) &&
        separated(t, a, False{}, closing)

def backtrack(a: Edge, b: Edge) -> Bool:
  match a b:
    case Edge{+pa, +pb, ax, bx, ay, by} Edge{pc, +pd, cx, dx, cy, dy}:
      N.is_zero(orientation(pa, pb, pd)) && (on_segment(pa, pb, pd) || on_segment(pb, pd, pa))

def area(a: Edge) -> N.Exact:
  match a:
    case Edge{Point{ax, ay}, Point{bx, by}, x0, x1, y0, y1}:
      N.sub(N.mul(ax, by), N.mul(bx, ay))

def nonzero(a: Edge) -> Bool:
  match a:
    case Edge{pa, pb, ax, bx, ay, by}:
      Bool.not(same(pa, pb))

def next_edge(xs: List<&2, Edge>, fallback: Edge) -> Edge:
  match xs:
    case Nil{}:
      fallback
    case Con{h, t}:
      h

def topology(xs: List<&2, Edge>, +first_edge: Edge, initial: Bool, sum: N.Exact) -> Bool:
  match xs:
    case Nil{}:
      Bool.not(N.is_zero(sum))
    case Con{+h, +t}:
      nonzero(h) && Bool.not(backtrack(h, next_edge(t, first_edge))) &&
        separated(t, h, True{}, initial) && topology(t, first_edge, False{}, N.add(sum, area(h)))

def closed(xs: List<&2, Point>, +first_point: Point) -> Bool:
  match xs:
    case Nil{}:
      False{}
    case Con{h, Nil{}}:
      same(h, first_point)
    case Con{h, Con{b, t}}:
      closed(Con{b, t}, first_point)

def polygon_valid(+ps: List<&2, Point>, es: List<&2, Edge>) -> Bool:
  match ps es:
    case Con{+p, t} Con{+e, +et}:
      closed(ps, p) && topology(Con{e, et}, e, True{}, N.zero())
    case _ _:
      False{}

def path_step(a: Point, b: Point, polygon: Bool) -> Bool:
  match a b:
    case Point{+ax, +ay} Point{+bx, +by}:
      Cmp.is_gt(N.cmp(abs(N.sub(ax, bx)), integer(180))) ||
        (polygon && N.equal(abs(ay), integer(90)) && N.equal(ay, by) && Bool.not(N.equal(ax, bx)))

def supported(xs: List<&2, Point>, +previous: Point, +polygon: Bool, low: N.Exact, high: N.Exact) -> Bool:
  match xs:
    case Nil{}:
      Bool.not(N.equal(low, N.negate(integer(180))) && N.equal(high, integer(180)))
    case Con{Point{+x, +y}, t}:
      Bool.not(path_step(previous, Point{x, y}, polygon)) &&
        supported(t, Point{x, y}, polygon, min(low, x), max(high, x))

def check_points(+ps: List<&2, Point>, +polygon: Bool) -> Result<&2, &2, C.Failure, Unit>:
  match ps:
    case Nil{}:
      Fail{C.failure(C.InvalidGeometry{})}
    case Con{Point{+x, +y}, t}:
      do Result<&2, &2, C.Failure, Unit>:
        C.require(supported(t, Point{x, y}, polygon, x, x), C.UnsupportedGeometry{})
        C.choose(Result<&2, &2, C.Failure, Unit>, polygon,
          _ => C.require(polygon_valid(ps, edges(ps)), C.InvalidGeometry{}), _ => Done{Unit{}})

def path(+xs: List<&2, C.Json>, polygon: Bool) -> Result<&2, &2, C.Failure, Unit>:
  do Result<&2, &2, C.Failure, Unit>:
    C.require(Nat.is_le(List.length(&2, C.Json, xs), 1024n), C.GeometryLimitExceeded{})
    ps : List<&2, Point> <- points(xs)
    check_points(ps, polygon)

def check_geometry(+value: C.Json) -> Result<&2, &2, C.Failure, Unit>:
  +kind = C.string(C.get(value, "type"))
  +coordinates = C.get(value, "coordinates")
  C.choose(Result<&2, &2, C.Failure, Unit>, String.eq(kind, "Point"), _ => Done{Unit{}},
    _ => C.choose(Result<&2, &2, C.Failure, Unit>, String.eq(kind, "LineString"),
      _ => path(C.items(coordinates), False{}),
      _ => C.choose(Result<&2, &2, C.Failure, Unit>, String.eq(kind, "Polygon"),
        _ => do Result<&2, &2, C.Failure, Unit>:
          C.require(Nat.is_le(List.length(&2, C.Json, C.items(coordinates)), 1n), C.UnsupportedGeometry{})
          path(C.items(first(C.items(coordinates))), True{}),
        _ => Fail{C.failure(C.UnsupportedGeometry{})})))

def check(value: C.Json) -> Result<&2, &2, C.Failure, Unit>:
  check_geometry(value)

type Remaining is Data:
  Remaining{changes: U32, work: U32}

def count(value: C.Json) -> U32:
  U32.from_nat(List.length(&2, C.Json, C.items(value)))

def array(value: C.Json) -> Bool:
  match value:
    case C.JArr{xs}:
      True{}
    case _:
      False{}

def has_put(xs: List<&2, C.Json>) -> Bool:
  match xs:
    case Nil{}:
      False{}
    case Con{+h, t}:
      (C.equal(C.get(h, "kind"), C.JStr{"put"}) && C.has(h, "resource_kind")) || has_put(t)

def reserve_object(+value: C.Json, state: Remaining) -> Result<&2, &2, C.Failure, Remaining>:
  match state:
    case Remaining{+changes, +work}:
      do Result<&2, &2, C.Failure, Remaining>:
        +kind : String = C.string(C.get(value, "type"))
        +coordinates : C.Json = C.get(value, "coordinates")
        +polygon : Bool = String.eq(kind, "Polygon") && array(coordinates)
        +ring : C.Json = first(C.items(coordinates))
        C.require(Bool.not(polygon && U32.is_gt(count(coordinates), 1)), C.UnsupportedGeometry{})
        C.require(Bool.not(String.eq(kind, "LineString") && U32.is_gt(count(coordinates), 1024)), C.GeometryLimitExceeded{})
        +n : U32 = count(ring)
        C.require(Bool.not(polygon && array(ring) && U32.is_gt(n, 1024)), C.GeometryLimitExceeded{})
        +cost : U32 = Bool.pick(U32, polygon && array(ring), (n * n + 8 * n : U32), 0)
        C.require(U32.is_le(cost, work), C.ResourceLimit{})
        +change_count : U32 = count(C.get(value, "changes"))
        +items : List<&2, C.Json> = C.items(C.get(value, "items"))
        +item_count : U32 = Bool.pick(U32, has_put(items), U32.from_nat(List.length(&2, C.Json, items)), 0)
        C.require(U32.is_le(change_count, changes) && U32.is_le(item_count, (changes - change_count : U32)), C.ResourceLimit{})
        return Remaining{(changes - change_count - item_count : U32), (work - cost : U32)}

def begin(value: C.Json, entering: Bool, state: Remaining) -> Result<&2, &2, C.Failure, Remaining>:
  match entering:
    case True{}:
      reserve_object(value, state)
    case False{}:
      Done{state}

def walk(+value: C.Json, entering: Bool, state: Remaining) -> Result<&2, &2, C.Failure, Remaining>:
  match value:
    case C.JObj{Con{C.Member{k, v}, t}}:
      do Result<&2, &2, C.Failure, Remaining>:
        own : Remaining <- begin(value, entering, state)
        child : Remaining <- walk(v, True{}, own)
        walk(C.JObj{t}, False{}, child)
    case C.JArr{Con{h, t}}:
      do Result<&2, &2, C.Failure, Remaining>:
        child : Remaining <- walk(h, True{}, state)
        walk(C.JArr{t}, False{}, child)
    case _:
      Done{state}

def reserve(value: C.Json, budget: C.Budget) -> Result<&2, &2, C.Failure, Unit>:
  match budget:
    case C.Budget{bytes, values, depth, changes, work}:
      do Result<&2, &2, C.Failure, Unit>:
        remaining : Remaining <- walk(value, True{}, Remaining{changes, work})
        return Unit{}
