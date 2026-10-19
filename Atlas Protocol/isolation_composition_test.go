package atlas

import (
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
)

func TestIsolatedRuleComposition(t *testing.T) {
	mode := os.Getenv("ATLAS_ISOLATION_COMPOSITION_CHILD")
	if mode == "" {
		binary, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		for _, mode := range []string{"rules", "marks", "geometry"} {
			t.Run(mode, func(t *testing.T) {
				cmd := exec.Command(binary, "-test.run=^TestIsolatedRuleComposition$", "-test.timeout=30s")
				cmd.Env = append(os.Environ(), "ATLAS_ISOLATION_COMPOSITION_CHILD="+mode)
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
	ref := func(s *openapi3.Schema) *openapi3.SchemaRef { return &openapi3.SchemaRef{Value: s} }
	unique := &openapi3.Schema{Type: &openapi3.Types{"array"}, UniqueItems: true}
	a := ref(openapi3.NewStringSchema().WithPattern(`^a`))
	b := ref(openapi3.NewStringSchema().WithPattern(`b$`))
	type sample struct {
		schema, wire string
		valid        bool
	}
	var tests []sample
	switch mode {
	case "rules":
		for name, schema := range map[string]*openapi3.Schema{
			"IdentityProbe":   unique,
			"PatternOneProbe": {OneOf: openapi3.SchemaRefs{a, b}},
			"PatternAnyProbe": {AnyOf: openapi3.SchemaRefs{a, b}},
			"PatternAllProbe": {AllOf: openapi3.SchemaRefs{a, b}},
			"PatternNotProbe": {Type: &openapi3.Types{"string"}, Not: a},
			"UniqueOneProbe":  {OneOf: openapi3.SchemaRefs{ref(unique), ref(&openapi3.Schema{Type: &openapi3.Types{"array"}, MinItems: 3})}},
			"UniqueAnyProbe":  {AnyOf: openapi3.SchemaRefs{ref(unique), ref(&openapi3.Schema{Type: &openapi3.Types{"array"}, MinItems: 3})}},
			"UniqueAllProbe":  {AllOf: openapi3.SchemaRefs{ref(unique), ref(&openapi3.Schema{Type: &openapi3.Types{"array"}})}},
			"UniqueNotProbe":  {Type: &openapi3.Types{"array"}, Not: ref(unique)},
			"PropertyProbe":   {Type: &openapi3.Types{"object"}, Properties: openapi3.Schemas{"pattern": a, "unique": ref(unique)}},
			"ItemsProbe":      {Type: &openapi3.Types{"array"}, Items: ref(&openapi3.Schema{AnyOf: openapi3.SchemaRefs{a, ref(unique)}})},
			"AdditionalProbe": {Type: &openapi3.Types{"object"}, AdditionalProperties: openapi3.AdditionalProperties{Schema: ref(&openapi3.Schema{AnyOf: openapi3.SchemaRefs{a, ref(unique)}})}},
		} {
			doc.Components.Schemas[name] = ref(schema)
		}
		for _, item := range []struct {
			wire  string
			valid bool
		}{
			{`[1,1.0]`, false}, {`[1,10e-1]`, false}, {`[0,-0.0]`, false}, {`[0,0e999]`, false},
			{`[9007199254740992,9007199254740993]`, true}, {`[100,100.0000000000000000001]`, true},
			{`[1e-400,2e-400]`, true}, {`[1e-400,1e-500]`, true}, {`[1e-400,10e-401]`, false},
			{`[1e-1000000000,10e-1000000001]`, false}, {`[1e-1000000000,1e-1000000001]`, true},
			{`[{"a":1,"b":null},{"b":null,"a":1.0}]`, false}, {`[{"a":1},{"a":1,"b":null}]`, true},
			{`[{"a":"b,c:s:d"},{"a":"b","c":"d"}]`, true}, {`["Camera","camera"]`, true},
			{`["a","\u0061"]`, false}, {`[null,false,0,"0",[],{}]`, true},
			{`[[1,2],[2,1]]`, true}, {`[[1,2],[1.0,2.0]]`, false},
			{`[-100,-1e2]`, false}, {`[-1,1]`, true}, {`[0.001,10e-4]`, false},
		} {
			tests = append(tests, sample{"IdentityProbe", item.wire, item.valid})
		}
		exponent := "1" + strings.Repeat("0", 2048)
		previous := strings.Repeat("9", 2048)
		tests = append(tests,
			sample{"IdentityProbe", `[1e-` + previous + `,10e-` + exponent + `]`, false},
			sample{"IdentityProbe", `[1e-` + previous + `,1e-` + exponent + `]`, true},
		)
		for _, s := range []sample{
			{"PatternOneProbe", `"a"`, true}, {"PatternOneProbe", `"b"`, true}, {"PatternOneProbe", `"c"`, false}, {"PatternOneProbe", `"ab"`, false},
			{"PatternAnyProbe", `"ab"`, true}, {"PatternAnyProbe", `"c"`, false},
			{"PatternAllProbe", `"ab"`, true}, {"PatternAllProbe", `"a"`, false},
			{"PatternNotProbe", `"b"`, true}, {"PatternNotProbe", `"a"`, false},
			{"UniqueOneProbe", `[1,1.0]`, false}, {"UniqueOneProbe", `[1,2]`, true}, {"UniqueOneProbe", `[1,2,3]`, false}, {"UniqueOneProbe", `[1,1.0,2]`, true},
			{"UniqueAnyProbe", `[1,1.0]`, false}, {"UniqueAnyProbe", `[1,2,3]`, true}, {"UniqueAnyProbe", `[1,1.0,2]`, true},
			{"UniqueAllProbe", `[1,1.0]`, false}, {"UniqueAllProbe", `[1,2]`, true},
			{"UniqueNotProbe", `[1,1.0]`, true}, {"UniqueNotProbe", `[1,2]`, false},
			{"PropertyProbe", `{"pattern":"a","unique":[1,2]}`, true}, {"PropertyProbe", `{"pattern":"b"}`, false}, {"PropertyProbe", `{"unique":[1,1.0]}`, false},
			{"ItemsProbe", `["a",[1,2]]`, true}, {"ItemsProbe", `["b"]`, false}, {"ItemsProbe", `[[1,1.0]]`, false},
			{"AdditionalProbe", `{"x":"a","y":[1,2]}`, true}, {"AdditionalProbe", `{"x":"b"}`, false}, {"AdditionalProbe", `{"x":[1,1.0]}`, false},
		} {
			tests = append(tests, s)
		}
	case "marks":
		integer := ref(openapi3.NewIntegerSchema().WithMin(0).WithMax(1000))
		marked := &openapi3.Schema{Type: &openapi3.Types{"object"}, Required: []string{"n", "s", "u"}, Properties: openapi3.Schemas{"n": integer, "s": a, "u": ref(unique)}}
		not := &openapi3.Schema{Not: ref(&openapi3.Schema{AllOf: openapi3.SchemaRefs{ref(marked), ref(&openapi3.Schema{Not: ref(&openapi3.Schema{})})}})}
		doc.Components.Schemas["PluginPayload"] = ref(&openapi3.Schema{AllOf: openapi3.SchemaRefs{
			ref(not), ref(&openapi3.Schema{AnyOf: openapi3.SchemaRefs{ref(marked), ref(&openapi3.Schema{})}}),
		}})
	case "geometry":
		doc.Components.Schemas["PointGeometry"].Value.Properties["type"].Value.Pattern = `^Never$`
		doc.Components.Schemas["LineGeometry"].Value.Properties["coordinates"].Value.UniqueItems = true
		geometry := doc.Components.Schemas["Geometry"]
		doc.Components.Schemas["GeometryCardinalityProbe"] = ref(&openapi3.Schema{OneOf: openapi3.SchemaRefs{geometry, geometry}})
		doc.Components.Schemas["GeometryBranchProbe"] = ref(&openapi3.Schema{AnyOf: openapi3.SchemaRefs{
			geometry, ref(&openapi3.Schema{Type: &openapi3.Types{"object"}, Properties: openapi3.Schemas{"type": a}, Required: []string{"type"}}),
		}})
		for _, s := range []sample{
			{"PointGeometry", `{"type":"Point","coordinates":[1,2]}`, false},
			{"Geometry", `{"type":"Point","coordinates":[1,2]}`, false},
			{"GeometryObservation", `{"geometry":{"type":"Point","coordinates":[1,2]},"observed_at":null}`, false},
			{"Geometry", `{"type":"LineString","coordinates":[[0,0],[0,0]]}`, false},
			{"Geometry", `{"type":"LineString","coordinates":[[0,0],[1,1]]}`, true},
			{"GeometryBranchProbe", `{"type":"Point","coordinates":[1,2]}`, false},
			{"GeometryBranchProbe", `{"type":"Point","coordinates":[1,2,3]}`, false},
			{"GeometryBranchProbe", `{"type":"LineString","coordinates":[[0,0],[1,1]]}`, true},
			{"GeometryCardinalityProbe", `{"type":"LineString","coordinates":[[0,0],[1,1]]}`, false},
		} {
			tests = append(tests, s)
		}
	default:
		t.Fatal("unknown isolation composition")
	}
	document, err = json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	for i, test := range tests {
		err := ValidateJSON(test.schema, []byte(test.wire), DefaultLimits())
		if (err == nil) != test.valid {
			t.Errorf("%s case %d valid=%v: %v", test.schema, i, test.valid, err)
		}
		if mode == "geometry" && !test.valid && test.schema != "GeometryCardinalityProbe" && (err == nil || !strings.Contains(err.Error(), "invalid_geometry") && !strings.Contains(err.Error(), "unsupported_geometry")) {
			t.Errorf("Geometry lost profile diagnostic: %v", err)
		}
	}
	if mode == "marks" {
		for _, wire := range []string{`{"n":1e3,"s":"b","u":[1]}`, `{"n":1e3,"s":"a","u":[1,1.0]}`} {
			limits := DefaultLimits()
			limits.MaxJSONBytes = len(wire)
			value, err := Decode[PluginPayload]("PluginPayload", []byte(wire), limits)
			if err != nil || string(value) != wire {
				t.Errorf("failed pattern/uniqueness or not leaked marks: %s, %v", value, err)
			}
		}
		wire := `{"n":1e3,"s":"a","u":[1,2]}`
		value, err := Decode[PluginPayload]("PluginPayload", []byte(wire), DefaultLimits())
		if err != nil || string(value) != `{"n":1000,"s":"a","u":[1,2]}` {
			t.Errorf("successful anyOf lost marks: %s, %v", value, err)
		}
	}
}
