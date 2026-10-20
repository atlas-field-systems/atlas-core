package atlas

import (
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"math/bits"
)

type coordinate struct{ x, y float64 }
type exactCoordinate struct {
	coordinate
	rx, ry big.Int
}
type geometryArithmetic struct {
	dx1, dy1, dx2, dy2, left, right big.Int
}

func geometry(value interface{}) error {
	object, ok := value.(map[string]interface{})
	if !ok {
		return fmt.Errorf("invalid_geometry")
	}
	kind, ok := object["type"].(string)
	if !ok {
		return fmt.Errorf("invalid_geometry")
	}
	if kind != "Point" && kind != "LineString" && kind != "Polygon" {
		return fmt.Errorf("unsupported_geometry")
	}
	raw, ok := object["coordinates"].([]interface{})
	if !ok {
		return fmt.Errorf("invalid_geometry")
	}
	pairs := raw
	if kind == "Polygon" {
		if len(raw) > 1 {
			return fmt.Errorf("unsupported_geometry")
		}
		if len(raw) != 1 {
			return fmt.Errorf("invalid_geometry")
		}
		pairs, ok = raw[0].([]interface{})
		if !ok {
			return fmt.Errorf("invalid_geometry")
		}
	}
	if kind == "Point" {
		pairs = []interface{}{raw}
	}
	if len(pairs) > 1024 {
		return fmt.Errorf("geometry_limit_exceeded")
	}
	if kind == "LineString" && len(pairs) < 2 || kind == "Polygon" && len(pairs) < 4 {
		return fmt.Errorf("invalid_geometry")
	}
	points := make([]coordinate, 0, len(pairs))
	minLongitude, maxLongitude := 180.0, -180.0
	for _, pair := range pairs {
		pair, ok := pair.([]interface{})
		if !ok {
			return fmt.Errorf("invalid_geometry")
		}
		if len(pair) > 2 {
			return fmt.Errorf("unsupported_geometry")
		}
		if len(pair) != 2 {
			return fmt.Errorf("invalid_geometry")
		}
		xn, xok := pair[0].(json.Number)
		yn, yok := pair[1].(json.Number)
		x, _ := xn.Float64()
		y, _ := yn.Float64()
		if !xok || !yok || !isFinite(x) || !isFinite(y) || x < -180 || x > 180 || y < -90 || y > 90 {
			return fmt.Errorf("invalid_geometry")
		}
		points = append(points, coordinate{x, y})
		minLongitude = math.Min(minLongitude, x)
		maxLongitude = math.Max(maxLongitude, x)
	}
	if kind != "Point" && minLongitude == -180 && maxLongitude == 180 {
		return fmt.Errorf("unsupported_geometry")
	}
	for i := 1; i < len(points); i++ {
		a, b := points[i-1], points[i]
		if math.Abs(b.x-a.x) > 180 {
			return fmt.Errorf("unsupported_geometry")
		}
		if kind == "Polygon" && a.x != b.x && a.y == b.y && math.Abs(a.y) == 90 {
			return fmt.Errorf("unsupported_geometry")
		}
		if kind == "Polygon" && a == b {
			return fmt.Errorf("invalid_geometry")
		}
	}
	if kind != "Polygon" {
		return nil
	}
	if points[0] != points[len(points)-1] {
		return fmt.Errorf("invalid_geometry")
	}
	scale := 0
	for _, point := range points {
		_, x := geometryNumber(point.x)
		_, y := geometryNumber(point.y)
		scale = min(scale, x, y)
	}
	polygon := make([]exactCoordinate, len(points))
	for i, point := range points {
		polygon[i].coordinate = point
		setGeometryInteger(&polygon[i].rx, point.x, scale)
		setGeometryInteger(&polygon[i].ry, point.y, scale)
	}
	var exact geometryArithmetic
	for i := 0; i < len(polygon)-1; i++ {
		for j := i + 1; j < len(polygon)-1; j++ {
			if j == i+1 {
				if exact.orientation(&polygon[i], &polygon[j], &polygon[j+1]) == 0 && (between(points[i], points[j], points[j+1]) || between(points[j+1], points[i], points[j])) {
					return fmt.Errorf("invalid_geometry")
				}
				continue
			}
			if i == 0 && j == len(polygon)-2 {
				continue
			}
			if exact.intersects(&polygon[i], &polygon[i+1], &polygon[j], &polygon[j+1]) {
				return fmt.Errorf("invalid_geometry")
			}
		}
	}
	var area big.Int
	for i := 0; i < len(polygon)-1; i++ {
		a, b := &polygon[i], &polygon[i+1]
		exact.left.Mul(&a.rx, &b.ry)
		exact.right.Mul(&b.rx, &a.ry)
		exact.left.Sub(&exact.left, &exact.right)
		area.Add(&area, &exact.left)
	}
	if area.Sign() <= 0 {
		return fmt.Errorf("invalid_geometry")
	}
	return nil
}
func isFinite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

func geometryNumber(value float64) (int64, int) {
	raw := math.Float64bits(value)
	mantissa, exponent := raw&((1<<52)-1), int(raw>>52&2047)
	power := -1074
	if exponent != 0 {
		mantissa |= 1 << 52
		power = exponent - 1075
	}
	if mantissa == 0 {
		return 0, 0
	}
	shift := bits.TrailingZeros64(mantissa)
	coefficient := int64(mantissa >> shift)
	if raw>>63 != 0 {
		coefficient = -coefficient
	}
	return coefficient, power + shift
}

// Finite coordinates bounded by 180 degrees need at most 1082 bits at a shared scale of 2^-1074.
func setGeometryInteger(target *big.Int, value float64, scale int) {
	coefficient, exponent := geometryNumber(value)
	target.SetInt64(coefficient)
	if coefficient != 0 {
		target.Lsh(target, uint(exponent-scale))
	}
}

func (work *geometryArithmetic) orientation(a, b, c *exactCoordinate) int {
	left := (b.x - a.x) * (c.y - a.y)
	right := (b.y - a.y) * (c.x - a.x)
	det := left - right
	if math.Abs(det) > (math.Abs(left)+math.Abs(right))*1e-14 {
		if det > 0 {
			return 1
		}
		return -1
	}
	work.dx1.Sub(&b.rx, &a.rx)
	work.dy2.Sub(&c.ry, &a.ry)
	work.dy1.Sub(&b.ry, &a.ry)
	work.dx2.Sub(&c.rx, &a.rx)
	work.left.Mul(&work.dx1, &work.dy2)
	work.right.Mul(&work.dy1, &work.dx2)
	return work.left.Cmp(&work.right)
}
func between(p, a, b coordinate) bool {
	return p.x >= math.Min(a.x, b.x) && p.x <= math.Max(a.x, b.x) && p.y >= math.Min(a.y, b.y) && p.y <= math.Max(a.y, b.y)
}
func (work *geometryArithmetic) intersects(a, b, c, d *exactCoordinate) bool {
	if math.Max(a.x, b.x) < math.Min(c.x, d.x) || math.Max(c.x, d.x) < math.Min(a.x, b.x) || math.Max(a.y, b.y) < math.Min(c.y, d.y) || math.Max(c.y, d.y) < math.Min(a.y, b.y) {
		return false
	}
	abC, abD, cdA, cdB := work.orientation(a, b, c), work.orientation(a, b, d), work.orientation(c, d, a), work.orientation(c, d, b)
	return abC*abD < 0 && cdA*cdB < 0 || abC == 0 && between(c.coordinate, a.coordinate, b.coordinate) || abD == 0 && between(d.coordinate, a.coordinate, b.coordinate) || cdA == 0 && between(a.coordinate, c.coordinate, d.coordinate) || cdB == 0 && between(b.coordinate, c.coordinate, d.coordinate)
}
