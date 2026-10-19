package atlas

import (
	"fmt"
	"math"
	"math/big"
)

type coordinate struct{ x, y float64 }

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
		x, xok := pair[0].(float64)
		y, yok := pair[1].(float64)
		if !xok || !yok || !isFinite(x) || !isFinite(y) || x < -180 || x > 180 || y < -90 || y > 90 {
			return fmt.Errorf("invalid_geometry")
		}
		points = append(points, coordinate{x, y})
	}
	for i := 1; i < len(points); i++ {
		if math.Abs(points[i].x-points[i-1].x) > 180 {
			return fmt.Errorf("unsupported_geometry")
		}
		if kind == "Polygon" && points[i] == points[i-1] {
			return fmt.Errorf("invalid_geometry")
		}
	}
	if kind != "Polygon" {
		return nil
	}
	if points[0] != points[len(points)-1] {
		return fmt.Errorf("invalid_geometry")
	}
	for i := 0; i < len(points)-1; i++ {
		for j := i + 1; j < len(points)-1; j++ {
			if j == i+1 {
				if orientation(points[i], points[j], points[j+1]) == 0 && (between(points[i], points[j], points[j+1]) || between(points[j+1], points[i], points[j])) {
					return fmt.Errorf("invalid_geometry")
				}
				continue
			}
			if i == 0 && j == len(points)-2 {
				continue
			}
			if intersects(points[i], points[i+1], points[j], points[j+1]) {
				return fmt.Errorf("invalid_geometry")
			}
		}
	}
	area := new(big.Rat)
	for i := 0; i < len(points)-1; i++ {
		a, b := points[i], points[i+1]
		cross := new(big.Rat).Sub(new(big.Rat).Mul(rat(a.x), rat(b.y)), new(big.Rat).Mul(rat(b.x), rat(a.y)))
		area.Add(area, cross)
	}
	if area.Sign() <= 0 {
		return fmt.Errorf("invalid_geometry")
	}
	return nil
}
func isFinite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }
func rat(v float64) *big.Rat  { return new(big.Rat).SetFloat64(v) }
func orientation(a, b, c coordinate) int {
	left := (b.x - a.x) * (c.y - a.y)
	right := (b.y - a.y) * (c.x - a.x)
	det := left - right
	if math.Abs(det) > (math.Abs(left)+math.Abs(right))*1e-14 {
		if det > 0 {
			return 1
		}
		return -1
	}
	x := new(big.Rat).Mul(new(big.Rat).Sub(rat(b.x), rat(a.x)), new(big.Rat).Sub(rat(c.y), rat(a.y)))
	y := new(big.Rat).Mul(new(big.Rat).Sub(rat(b.y), rat(a.y)), new(big.Rat).Sub(rat(c.x), rat(a.x)))
	return x.Sub(x, y).Sign()
}
func between(p, a, b coordinate) bool {
	return p.x >= math.Min(a.x, b.x) && p.x <= math.Max(a.x, b.x) && p.y >= math.Min(a.y, b.y) && p.y <= math.Max(a.y, b.y)
}
func intersects(a, b, c, d coordinate) bool {
	abC, abD, cdA, cdB := orientation(a, b, c), orientation(a, b, d), orientation(c, d, a), orientation(c, d, b)
	return abC*abD < 0 && cdA*cdB < 0 || abC == 0 && between(c, a, b) || abD == 0 && between(d, a, b) || cdA == 0 && between(a, c, d) || cdB == 0 && between(b, c, d)
}
