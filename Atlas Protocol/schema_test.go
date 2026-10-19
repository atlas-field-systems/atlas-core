package atlas

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
)

func TestAuthoredContract(t *testing.T) {
	if err := scan(document, DefaultLimits()); err != nil {
		t.Fatal(err)
	}
	doc, err := openapi3.NewLoader().LoadFromFile("openapi.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := doc.Validate(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestContractFormatCoverage(t *testing.T) {
	kind := os.Getenv("ATLAS_UNCOVERED_FORMAT_CHILD")
	if kind == "" {
		binary, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		for _, kind := range []string{"string", "integer", "number", "header"} {
			t.Run(kind, func(t *testing.T) {
				cmd := exec.Command(binary, "-test.run=^TestContractFormatCoverage$", "-test.timeout=30s")
				cmd.Env = append(os.Environ(), "ATLAS_UNCOVERED_FORMAT_CHILD="+kind)
				if output, err := cmd.CombinedOutput(); err != nil {
					t.Fatalf("fresh process: %v\n%s", err, output)
				}
			})
		}
		return
	}
	doc, err := openapi3.NewLoader().LoadFromData(document)
	if err != nil {
		t.Fatal(err)
	}
	switch kind {
	case "string":
		doc.Components.Schemas["Identifier"].Value.Format = "host-only"
	case "integer":
		doc.Components.Schemas["ErrorDetails"].Value.Properties["retry_after_seconds"].Value.Format = "host-only"
	case "number":
		doc.Components.Schemas["Latitude"].Value.Format = "host-only"
	case "header":
		for _, p := range doc.Paths.Value("/objects").Post.Parameters {
			if p.Value.Name == "Atlas-Object-Descriptor" {
				p.Value.Schema.Value.Format = "host-only"
			}
		}
	default:
		t.Fatal("unknown format probe")
	}
	document, err = json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateJSON("Position", []byte(`{"latitude":1.5,"longitude":2.5}`), DefaultLimits()); err == nil {
		t.Fatal("authored format without a local validator silently accepted")
	}
}
