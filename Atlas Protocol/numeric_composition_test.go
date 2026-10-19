package atlas

import (
	"encoding/json"
	"os"
	"os/exec"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
)

func TestNumericSemanticComposition(t *testing.T) {
	mode := os.Getenv("ATLAS_NUMERIC_COMPOSITION_CHILD")
	if mode == "" {
		binary, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		for _, kind := range []string{"oneOf", "anyOf", "allOf", "not", "arrays", "properties", "rollback", "duplicate", "wide"} {
			t.Run(kind, func(t *testing.T) {
				cmd := exec.Command(binary, "-test.run=^TestNumericSemanticComposition$", "-test.timeout=30s")
				cmd.Env = append(os.Environ(), "ATLAS_NUMERIC_COMPOSITION_CHILD="+kind)
				if out, err := cmd.CombinedOutput(); err != nil {
					t.Fatalf("%s: %v\n%s", kind, err, out)
				}
			})
		}
		return
	}
	doc, err := openapi3.NewLoader().LoadFromData(document)
	if err != nil {
		t.Fatal(err)
	}
	integer := openapi3.NewIntegerSchema().WithMin(0).WithMax(1000)
	doc.Components.Schemas["NumericProbeInteger"] = &openapi3.SchemaRef{Value: integer}
	ref := &openapi3.SchemaRef{Ref: "#/components/schemas/NumericProbeInteger", Value: integer}
	fractional := &openapi3.SchemaRef{Value: openapi3.NewFloat64Schema().WithMin(100).WithMax(100.5)}
	var selected *openapi3.Schema
	type probe struct {
		raw    string
		valid  bool
		growth int
	}
	tests := []probe{}
	switch mode {
	case "oneOf", "anyOf", "allOf":
		selected = &openapi3.Schema{}
		switch mode {
		case "oneOf":
			selected.OneOf = openapi3.SchemaRefs{ref, fractional}
		case "anyOf":
			selected.AnyOf = openapi3.SchemaRefs{ref, fractional}
		case "allOf":
			selected.AllOf = openapi3.SchemaRefs{ref, fractional}
		}
		tests = []probe{{`100.0000000000000000001`, mode != "allOf", 0}, {`100.0`, mode != "oneOf", 0}, {`1e-400`, false, 0}}
	case "not":
		selected = &openapi3.Schema{Type: &openapi3.Types{"number"}, Not: ref}
		tests = []probe{{`100.0000000000000000001`, true, 0}, {`100.0`, false, 0}, {`1e-400`, true, 0}}
	case "arrays":
		selected = &openapi3.Schema{Type: &openapi3.Types{"array"}, Items: ref}
		tests = []probe{{`[100.0,1e2]`, true, 0}, {`[100.0,100.0000000000000000001]`, false, 0}}
	case "properties":
		selected = &openapi3.Schema{Type: &openapi3.Types{"object"}, Properties: openapi3.Schemas{"fixed": ref}, AdditionalProperties: openapi3.AdditionalProperties{Schema: ref}}
		tests = []probe{{`{"fixed":100.0,"10":1e2,"2":1000e-1}`, true, 0}, {`{"fixed":100.0,"2":100.0000000000000000001}`, false, 0}}
	case "rollback":
		refused := &openapi3.Schema{AllOf: openapi3.SchemaRefs{ref, {Value: &openapi3.Schema{Not: &openapi3.SchemaRef{Value: &openapi3.Schema{Enum: []interface{}{float64(1000)}}}}}}}
		selected = &openapi3.Schema{AnyOf: openapi3.SchemaRefs{{Value: refused}, {Value: openapi3.NewFloat64Schema()}}}
		tests = []probe{{`1e3`, true, 0}}
	case "duplicate":
		selected = &openapi3.Schema{AnyOf: openapi3.SchemaRefs{ref, ref}}
		tests = []probe{{`1e3`, true, 1}}
	case "wide":
		selected = openapi3.NewIntegerSchema().WithMin(1e100).WithMax(1e100)
		tests = []probe{{`1e100`, true, 96}}
	default:
		t.Fatal("unknown numeric composition")
	}
	doc.Components.Schemas["EntityListQuery"].Value.Properties["page_size"] = &openapi3.SchemaRef{Value: selected}
	document, err = json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range tests {
		raw := []byte(`{"page_size":` + test.raw + `}`)
		limits := DefaultLimits()
		limits.MaxJSONBytes = len(raw) + test.growth
		if err := ValidateJSON("EntityListQuery", raw, limits); (err == nil) != test.valid {
			t.Fatalf("%s/%s: %v", mode, test.raw, err)
		}
		if test.growth > 0 {
			limits.MaxJSONBytes--
			if err := ValidateJSON("EntityListQuery", raw, limits); err == nil {
				t.Fatal("duplicate marks escaped canonical size limit")
			}
		}
	}
}
