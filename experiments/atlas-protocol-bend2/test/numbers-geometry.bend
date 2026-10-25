import Base
import ../numbers.bend as N

def determinant(+ax: N.Exact, +ay: N.Exact, bx: N.Exact, by: N.Exact,
    cx: N.Exact, cy: N.Exact) -> N.Exact:
  N.sub(N.mul(N.sub(bx, ax), N.sub(cy, ay)), N.mul(N.sub(by, ay), N.sub(cx, ax)))

def orientation(ax: String, ay: String, bx: String, by: String,
    cx: String, cy: String) -> Maybe<&2, N.Exact>:
  do Maybe<&2, N.Exact>:
    a_x : N.Exact <- N.read(ax)
    a_y : N.Exact <- N.read(ay)
    b_x : N.Exact <- N.read(bx)
    b_y : N.Exact <- N.read(by)
    c_x : N.Exact <- N.read(cx)
    c_y : N.Exact <- N.read(cy)
    return determinant(a_x, a_y, b_x, b_y, c_x, c_y)
