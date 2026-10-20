package atlas

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"runtime"
	"strings"
	"testing"
	"time"
)

func geometryRing() [][2]float64 {
	ring := make([][2]float64, 0, 1024)
	for i := 0; i < 512; i++ {
		ring = append(ring, [2]float64{float64(i) / 4, 0})
	}
	for i := 510; i >= 0; i-- {
		ring = append(ring, [2]float64{float64(i) / 4, 1})
	}
	return append(ring, [2]float64{0, 0})
}

func geometrySawtooth(rotated, tiny bool) [][2]float64 {
	ring := make([][2]float64, 0, 1024)
	for k := 0; k < 255; k++ {
		b := float64(2 * k)
		ring = append(ring, [2]float64{b, 0}, [2]float64{b + 1, 0}, [2]float64{b + 201, 1}, [2]float64{b + 202, 1})
	}
	ring = append(ring, [2]float64{510, 0}, [2]float64{510, -1}, [2]float64{0, -1}, [2]float64{0, 0})
	for i, j := 0, len(ring)-1; i < j; i, j = i+1, j-1 {
		ring[i], ring[j] = ring[j], ring[i]
	}
	for i, p := range ring {
		ring[i] = [2]float64{p[0] / 8, p[1] / 8}
		if rotated {
			ring[i] = [2]float64{(p[0] - p[1]) / 8, (p[0] + p[1]) / 8}
		}
	}
	if tiny {
		ring[1][0] = math.SmallestNonzeroFloat64
	}
	return ring
}

func geometrySerpentine(tiny bool) [][2]float64 {
	ring := make([][2]float64, 0, 1024)
	d := math.Ldexp(1, -46)
	for k := 0; k < 510; k += 2 {
		a, b := float64(k)*d, float64(k+1)*d
		ring = append(ring, [2]float64{0, a}, [2]float64{64, 64 + a}, [2]float64{64, 64 + b}, [2]float64{0, b})
	}
	y := 0.0
	if tiny {
		y = math.SmallestNonzeroFloat64
	}
	return append(ring, [2]float64{0, 1}, [2]float64{-1, 1}, [2]float64{-1, y}, [2]float64{0, 0})
}

func geometryBoundaries(t *testing.T, rings [][][2]float64) []struct {
	name  string
	check func() error
} {
	t.Helper()
	marshal := func(value interface{}) []byte {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	shape := map[string]interface{}{"type": "Polygon", "coordinates": rings}
	root := marshal(shape)
	request := marshal(map[string]interface{}{
		"request_id": fixtureRun, "geofeature_id": fixtureDataset,
		"description": map[string]string{"name": "Area"}, "type": map[string]string{"kind": "search_area"}, "geometry": shape,
	})
	changes := make([]interface{}, 0, 2)
	for _, id := range []string{fixtureDataset, fixtureRun} {
		changes = append(changes, map[string]interface{}{"kind": "upsert", "resource": map[string]interface{}{
			"id": id, "version": "1", "edit_revision": "1", "alias": nil, "entity_type": "geofeature", "geometry_revision": "1",
			"description": map[string]string{"name": "Area"}, "type": map[string]string{"kind": "search_area"}, "geometry": shape,
		}})
	}
	frame := marshal(map[string]interface{}{
		"type": "changes", "dataset_id": fixtureDataset, "core_run_id": fixtureRun, "protocol_version": "0.1.0",
		"batch": map[string]interface{}{"cursor": "cursor-H", "changes": changes},
	})
	return []struct {
		name  string
		check func() error
	}{
		{"PolygonGeometry", func() error { return ValidateJSON("PolygonGeometry", root, DefaultLimits()) }},
		{"Geometry", func() error { return ValidateJSON("Geometry", root, DefaultLimits()) }},
		{"ValidateRequest", func() error {
			req, err := http.NewRequest("POST", "https://atlas.invalid/geofeatures", bytes.NewReader(request))
			if err != nil {
				return err
			}
			req.Header = headers()
			_, err = ValidateRequest("CreateGeofeature", req, fixtureDataset, DefaultLimits())
			return err
		}},
		{"ValidateFrame", func() error {
			return ValidateFrame("server", frame, FrameContext{fixtureDataset, fixtureRun, true, true}, DefaultLimits())
		}},
	}
}

func TestGeometryWorkflowBudget(t *testing.T) {
	if err := ValidateJSON("Position", []byte(`{"latitude":0,"longitude":0}`), DefaultLimits()); err != nil {
		t.Fatal(err)
	}
	for _, sample := range []struct {
		name string
		ring [][2]float64
	}{
		{"strip", geometryRing()}, {"sawtooth", geometrySawtooth(false, false)},
		{"rotated sawtooth", geometrySawtooth(true, false)}, {"subnormal sawtooth", geometrySawtooth(false, true)},
		{"serpentine", geometrySerpentine(false)}, {"subnormal serpentine", geometrySerpentine(true)},
	} {
		if len(sample.ring) != 1024 {
			t.Fatal("wrong maximum ring size", sample.name, len(sample.ring))
		}
		for _, boundary := range geometryBoundaries(t, [][][2]float64{sample.ring}) {
			t.Run(sample.name+"/"+boundary.name, func(t *testing.T) {
				runtime.GC()
				var before, after runtime.MemStats
				runtime.ReadMemStats(&before)
				start := time.Now()
				err := boundary.check()
				elapsed := time.Since(start)
				runtime.ReadMemStats(&after)
				if err != nil {
					t.Fatal("maximum collinear-rich polygon refused", err)
				}
				allocated := after.TotalAlloc - before.TotalAlloc
				t.Logf("accepted=true vertices=1024 allocated_bytes=%d allocations=%d elapsed=%v", allocated, after.Mallocs-before.Mallocs, elapsed)
				if allocated > 64<<20 {
					t.Fatalf("geometry workflow allocated %d bytes, budget %d", allocated, 64<<20)
				}
			})
		}
	}
}

func TestGeometryWorkflowTopology(t *testing.T) {
	ring := geometryRing()
	tooMany := append([][2]float64{{0, 0}, {0.125, 0}}, ring[1:]...)
	touch := geometrySerpentine(false)
	touch[3] = [2]float64{0, 0}
	for _, sample := range []struct {
		name  string
		rings [][][2]float64
		code  string
	}{
		{"exact thin triangle", [][][2]float64{{{0, 0}, {1, 1}, {2, 2.0000000000000004}, {0, 0}}}, ""},
		{"subnormal triangle", [][][2]float64{{{0, 0}, {math.SmallestNonzeroFloat64, 0}, {0, math.SmallestNonzeroFloat64}, {0, 0}}}, ""},
		{"crossing", [][][2]float64{{{0, 0}, {4, 4}, {0, 4}, {3, 0}, {0, 0}}}, "invalid_geometry"},
		{"touch", [][][2]float64{{{0, 0}, {4, 0}, {4, 4}, {2, 0}, {0, 4}, {0, 0}}}, "invalid_geometry"},
		{"serpentine touch", [][][2]float64{touch}, "invalid_geometry"},
		{"overlap", [][][2]float64{{{0, 0}, {4, 0}, {2, 0}, {4, 4}, {0, 4}, {0, 0}}}, "invalid_geometry"},
		{"clockwise", [][][2]float64{{{0, 0}, {0, 1}, {1, 1}, {1, 0}, {0, 0}}}, "invalid_geometry"},
		{"1025 entries", [][][2]float64{tooMany}, "geometry_limit_exceeded"},
		{"holes", [][][2]float64{ring, ring}, "unsupported_geometry"},
	} {
		for _, boundary := range geometryBoundaries(t, sample.rings) {
			t.Run(fmt.Sprintf("%s/%s", sample.name, boundary.name), func(t *testing.T) {
				err := boundary.check()
				if sample.code == "" && err != nil || sample.code != "" && (err == nil || !strings.Contains(err.Error(), sample.code)) {
					t.Fatalf("want %q, got %v", sample.code, err)
				}
			})
		}
	}
}
