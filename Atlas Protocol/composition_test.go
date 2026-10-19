package atlas

import (
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
)

func TestSemanticComposition(t *testing.T) {
	composition := os.Getenv("ATLAS_COMPOSITION_CHILD")
	if composition == "" {
		binary, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		for _, kind := range []string{"oneOf", "anyOf", "allOf"} {
			t.Run(kind, func(t *testing.T) {
				cmd := exec.Command(binary, "-test.run=^TestSemanticComposition$", "-test.timeout=30s")
				cmd.Env = append(os.Environ(), "ATLAS_COMPOSITION_CHILD="+kind)
				if out, err := cmd.CombinedOutput(); err != nil {
					t.Fatalf("%s: %v\n%s", kind, err, out)
				}
			})
		}
		return
	}
	// Equivalent compositions keep the independent resource fixtures unchanged.
	// Each child loads its own contract before the public boundary's first use.
	doc, err := openapi3.NewLoader().LoadFromData(document)
	if err != nil {
		t.Fatal(err)
	}
	resource := doc.Components.Schemas["ResourceImage"].Value
	alternatives := resource.OneOf
	resource.OneOf = nil
	switch composition {
	case "oneOf":
		resource.OneOf = alternatives
	case "anyOf":
		resource.AnyOf = alternatives
	case "allOf":
		resource.AllOf = openapi3.SchemaRefs{{Value: &openapi3.Schema{OneOf: alternatives}}, {Value: &openapi3.Schema{}}}
	default:
		t.Fatal("unknown composition")
	}
	document, err = json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, sample := range readFixture[[]fixture](t, "cases.json") {
		syncGeometry := strings.Contains(sample.Name, "Track geometry ") && (strings.HasPrefix(sample.Name, "snapshot ") || strings.HasPrefix(sample.Name, "commit "))
		if !syncGeometry {
			continue
		}
		count++
		var err error
		if sample.Schema == "ChangesFrame" {
			err = ValidateFrame("server", sample.Value, FrameContext{fixtureDataset, fixtureRun, true, true}, DefaultLimits())
		} else {
			err = ValidateJSON(sample.Schema, sample.Value, DefaultLimits())
		}
		if (err == nil) != sample.Valid || err != nil && !strings.Contains(err.Error(), sample.Error) {
			t.Errorf("%s: %v", sample.Name, err)
		}
	}
	if count != 8 {
		t.Fatalf("expected eight independent snapshot and commit cases, got %d", count)
	}
}
