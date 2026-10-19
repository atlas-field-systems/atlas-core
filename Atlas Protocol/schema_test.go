package atlas

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"strings"
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

func TestContractRulePreparation(t *testing.T) {
	mode := os.Getenv("ATLAS_PREPARATION_CHILD")
	if mode == "" {
		binary, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		for _, mode := range []string{"inline", "invalid-inline", "invalid-header", "invalid-identifier", "opaque-pattern", "opaque-unique", "opaque-nested-pattern", "opaque-nested-unique"} {
			t.Run(mode, func(t *testing.T) {
				cmd := exec.Command(binary, "-test.run=^TestContractRulePreparation$", "-test.timeout=30s")
				cmd.Env = append(os.Environ(), "ATLAS_PREPARATION_CHILD="+mode)
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
	switch mode {
	case "inline", "invalid-inline":
		for _, p := range doc.Paths.Value("/assets/{asset_id}").Get.Parameters {
			if p.Value.In == "path" {
				pattern := `^A`
				if mode == "invalid-inline" {
					pattern = `[`
				}
				p.Value.Schema = &openapi3.SchemaRef{Value: openapi3.NewStringSchema().WithPattern(pattern)}
			}
		}
	case "invalid-identifier":
		doc.Components.Schemas["Identifier"].Value.Pattern = `[`
	case "invalid-header":
		for _, p := range doc.Paths.Value("/objects").Post.Parameters {
			if p.Value.Name == "Atlas-Object-Descriptor" {
				p.Value.Schema.Value.Pattern = `[`
			}
		}
	default:
		if !strings.HasPrefix(mode, "opaque-") {
			t.Fatal("unknown preparation probe")
		}
		opaque := doc.Components.Schemas["PluginPayload"].Value
		if strings.Contains(mode, "nested") {
			opaque.Properties = openapi3.Schemas{"nested": {Value: &openapi3.Schema{}}}
			opaque = opaque.Properties["nested"].Value
		}
		if strings.HasSuffix(mode, "pattern") {
			opaque.Pattern = `^contract-owned$`
		} else {
			opaque.UniqueItems = true
		}
	}
	document, err = json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if mode != "inline" {
		err := ValidateJSON("Position", []byte(`{"latitude":1,"longitude":2}`), DefaultLimits())
		if err == nil {
			t.Fatal("invalid or skipped contract rule silently published")
		}
		if strings.HasPrefix(mode, "invalid-") && !strings.Contains(err.Error(), "pattern") {
			t.Fatalf("missing pattern construction diagnostic: %v", err)
		}
		return
	}
	for _, id := range []string{fixtureDataset, strings.ToLower(fixtureDataset)} {
		req, err := http.NewRequest("GET", "https://atlas.invalid/assets/"+id, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+strings.Repeat("A", 43))
		req.Header.Set("Atlas-Dataset-ID", fixtureDataset)
		req.Header.Set("Atlas-Protocol-Version", "0.1.0")
		limits := DefaultLimits()
		limits.MaxJSONBytes = 2
		_, err = ValidateRequest("GetAsset", req, fixtureDataset, limits)
		if (err == nil) != (id == fixtureDataset) {
			t.Errorf("inline path pattern or scalar body budget: %v", err)
		}
	}
}

func TestPreparedRulesRefuseMissingState(t *testing.T) {
	mode := os.Getenv("ATLAS_MISSING_RULE_CHILD")
	if mode == "" {
		binary, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		for _, mode := range []string{"root", "candidate", "node", "branch", "not", "pattern", "string", "geometry"} {
			t.Run(mode, func(t *testing.T) {
				cmd := exec.Command(binary, "-test.run=^TestPreparedRulesRefuseMissingState$", "-test.timeout=30s")
				cmd.Env = append(os.Environ(), "ATLAS_MISSING_RULE_CHILD="+mode)
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
	definition := openapi3.NewStringSchema().WithPattern(`^a$`)
	doc.Components.Schemas["PreparationPatternProbe"] = &openapi3.SchemaRef{Value: definition}
	pattern := &openapi3.SchemaRef{Ref: "#/components/schemas/PreparationPatternProbe", Value: definition}
	probe := &openapi3.Schema{AnyOf: openapi3.SchemaRefs{pattern, {Value: &openapi3.Schema{}}}}
	if mode == "not" || mode == "pattern" {
		probe = &openapi3.Schema{Not: pattern}
	}
	doc.Components.Schemas["PreparationProbe"] = &openapi3.SchemaRef{Value: probe}
	document, err = json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateJSON("PreparationProbe", []byte(`"b"`), DefaultLimits()); err != nil {
		t.Fatal("valid control", err)
	}
	c, err := loadContract()
	if err != nil {
		t.Fatal(err)
	}
	schema := c.Components.Schemas["PreparationProbe"].Value
	switch mode {
	case "root":
		delete(c.schemas, schema)
	case "candidate", "node":
		shape := c.schemas[schema]
		if mode == "candidate" {
			shape.candidate = nil
		} else {
			shape.node = nil
		}
		c.schemas[schema] = shape
	case "branch", "not":
		delete(c.schemas, c.Components.Schemas["PreparationPatternProbe"].Value)
	case "pattern":
		delete(c.patterns, `^a$`)
	case "string":
		delete(c.schemas, c.Components.Schemas["APIKeySecret"].Value)
		req, err := http.NewRequest("GET", "https://atlas.invalid/health", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+strings.Repeat("A", 43))
		if _, err := ValidateRequest("GetHealth", req, "", DefaultLimits()); err == nil {
			t.Fatal("missing scalar preparation accepted")
		}
		return
	case "geometry":
		delete(c.schemas, c.Components.Schemas["Geometry"].Value)
		if err := ValidateJSON("Geometry", []byte(`{"type":"Point","coordinates":[1,2]}`), DefaultLimits()); err == nil {
			t.Fatal("missing Geometry preparation accepted")
		}
		return
	default:
		t.Fatal("unknown missing rule probe")
	}
	if err := ValidateJSON("PreparationProbe", []byte(`"b"`), DefaultLimits()); err == nil {
		t.Fatal("missing contract rule accepted")
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
