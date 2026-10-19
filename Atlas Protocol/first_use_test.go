package atlas_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"

	atlas "atlas/protocol"
	"github.com/getkin/kin-openapi/openapi3"
)

type hostPattern struct{ re *regexp.Regexp }

func (p hostPattern) MatchString(value string) bool {
	return p.re.MatchString(strings.TrimSuffix(value, "\n"))
}

func hostCompiler(pattern string) (openapi3.RegexMatcher, error) {
	re, err := regexp.Compile(pattern)
	return hostPattern{re}, err
}

func TestFirstUseCoexistsWithOtherValidators(t *testing.T) {
	mode := os.Getenv("ATLAS_FIRST_USE_CHILD")
	if mode == "" {
		binary, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		for _, phase := range []string{"before", "after", "writer-before", "writer-after", "refuse-before", "refuse-after", "writer-refuse-before", "writer-refuse-after", "reverse"} {
			t.Run(phase, func(t *testing.T) {
				cmd := exec.Command(binary, "-test.run=^TestFirstUseCoexistsWithOtherValidators$", "-test.timeout=30s")
				cmd.Env = append(os.Environ(), "ATLAS_FIRST_USE_CHILD="+phase)
				if output, err := cmd.CombinedOutput(); err != nil {
					t.Fatalf("fresh process: %v\n%s", err, output)
				}
			})
		}
		return
	}
	raw, err := os.ReadFile("openapi.json")
	if err != nil {
		t.Fatal(err)
	}
	hostDoc, err := openapi3.NewLoader().LoadFromData(raw)
	if err != nil {
		t.Fatal(err)
	}
	checkAtlas := func() {
		t.Helper()
		for _, sample := range []struct {
			schema, wire string
			valid        bool
		}{
			{"Timestamp", `"2026-10-18T01:02:03.123400000+05:30"`, true},
			{"Timestamp", `"2026-02-30T00:00:00Z"`, false},
			{"Timestamp", `"2026-10-18t01:02:03z"`, false},
			{"Counter", `"18446744073709551615"`, true},
			{"Counter", `"18446744073709551616"`, false},
			{"Counter", `"01"`, false},
			{"PluginSchemaReference", `{"uri":"https://plugin.invalid/input","sha256":"0000000000000000000000000000000000000000000000000000000000000000"}`, true},
			{"PluginSchemaReference", `{"uri":"relative","sha256":"0000000000000000000000000000000000000000000000000000000000000000"}`, false},
			{"Identifier", `"A0B1C2D3-E4F5-4A67-8B90-C1D2E3F4A5B6"`, true},
			{"Identifier", `"00000000-0000-0000-0000-000000000002"`, true},
			{"Identifier", `"01890a5d-ac96-774b-bcce-b302099a8057"`, true},
			{"Identifier", `"00000000-0000-0000-0000-00000000000x"`, false},
			{"ErrorDetails", `{"retry_after_seconds":5}`, true},
			{"ErrorDetails", `{"retry_after_seconds":9007199254740992}`, false},
			{"ErrorDetails", `{"retry_after_seconds":1e-400}`, false},
			{"Position", `{"latitude":1.5,"longitude":2.5}`, true},
			{"Position", `{"latitude":91,"longitude":2.5}`, false},
			{"EntityListQuery", `{"names":["Camera","Camera"]}`, false},
			{"EntityListQuery", `{"names":["Camera","camera"]}`, true},
			{"EntityListQuery", `{"aliases":["cam","cam"]}`, false},
			{"EntityListQuery", `{"aliases":["cam","other"]}`, true},
			{"TaskListQuery", `{"states":["pending","pending"]}`, false},
			{"TaskListQuery", `{"states":["pending","in_progress"]}`, true},
			{"MoveToSupport", `{"command":"move_to","scheduling":["queued","queued"]}`, false},
			{"MoveToSupport", `{"command":"move_to","scheduling":["queued","immediate"]}`, true},
			{"Capabilities", `{"commands":[{"command":"move_to","scheduling":["queued"]},{"scheduling":["queued"],"command":"move_to"}]}`, false},
			{"Capabilities", `{"commands":[{"command":"move_to","scheduling":["queued"]},{"scheduling":["immediate"],"command":"pause"}]}`, true},
			{"ContentType", `"text/plain\n"`, false},
			{"ContentType", `"text/plain"`, true},
			{"Geometry", `{"type":"Point","coordinates":[0,90]}`, true},
			{"Geometry", `{"type":"Point","coordinates":[0,90,1]}`, false},
			{"GeometryObservation", `{"geometry":{"type":"Point","coordinates":[0,90]},"observed_at":null}`, true},
			{"GeometryObservation", `{"geometry":{"type":"Point","coordinates":[0,90,1]},"observed_at":null}`, false},
			{"PointGeometry", `{"type":"LineString","coordinates":[[0,0],[1,1]]}`, false},
			{"PluginPayload", `[1,1,{"type":"Point","coordinates":[0,0,0]},null]`, true},
		} {
			err := atlas.ValidateJSON(sample.schema, []byte(sample.wire), atlas.DefaultLimits())
			if (err == nil) != sample.valid {
				t.Errorf("Protocol %s %s: %v", sample.schema, sample.wire, err)
			}
		}
		const dataset = "A0B1C2D3-E4F5-4A67-8B90-C1D2E3F4A5B6"
		for _, sample := range []struct {
			operation, path, query, secret string
			valid                          bool
		}{
			{"GetHealth", "/health", "", strings.Repeat("A", 43), true},
			{"GetHealth", "/health", "", strings.Repeat("A", 43) + "\n", false},
			{"GetHealth", "/health", "", strings.Repeat("A", 42) + "+", false},
			{"GetAsset", "/assets/" + dataset, "", strings.Repeat("A", 43), true},
			{"GetAsset", "/assets/00000000-0000-0000-0000-000000000002", "", strings.Repeat("A", 43), true},
			{"GetAsset", "/assets/01890a5d-ac96-774b-bcce-b302099a8057", "", strings.Repeat("A", 43), true},
			{"GetAsset", "/assets/00000000-0000-0000-0000-00000000000x", "", strings.Repeat("A", 43), false},
			{"GetAssetByAlias", "/assets/by-alias", "alias=" + url.QueryEscape("camera\n"), strings.Repeat("A", 43), false},
			{"GetAssetByAlias", "/assets/by-alias", "alias=camera", strings.Repeat("A", 43), true},
			{"ListAssets", "/assets", "names=" + url.QueryEscape(`["Camera","Camera"]`), strings.Repeat("A", 43), false},
			{"ListAssets", "/assets", "names=" + url.QueryEscape(`["Camera","camera"]`), strings.Repeat("A", 43), true},
			{"ListAssets", "/assets", "aliases=" + url.QueryEscape(`["cam","cam"]`), strings.Repeat("A", 43), false},
			{"ListTasks", "/tasks", "states=" + url.QueryEscape(`["pending","pending"]`), strings.Repeat("A", 43), false},
		} {
			req, err := http.NewRequest("GET", "https://atlas.invalid"+sample.path+"?"+sample.query, nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Authorization", "Bearer "+sample.secret)
			req.Header.Set("Atlas-Dataset-ID", dataset)
			req.Header.Set("Atlas-Protocol-Version", "0.1.0")
			_, err = atlas.ValidateRequest(sample.operation, req, dataset, atlas.DefaultLimits())
			if (err == nil) != sample.valid {
				t.Errorf("Protocol HTTP %s %s: %v", sample.operation, sample.path+"?"+sample.query, err)
			}
		}
		for _, suffix := range []string{"", `\n`} {
			frame := []byte(`{"type":"authenticate","dataset_id":"` + dataset + `","protocol_version":"0.1.0","api_key":"` + strings.Repeat("A", 43) + suffix + `"}`)
			err := atlas.ValidateFrame("client", frame, atlas.FrameContext{DatasetID: dataset}, atlas.DefaultLimits())
			if (err == nil) != (suffix == "") {
				t.Errorf("Protocol authenticate suffix %q: %v", suffix, err)
			}
		}
	}
	checkHostPatterns := func() {
		t.Helper()
		for name, text := range map[string]string{
			"Identifier": "A0B1C2D3-E4F5-4A67-8B90-C1D2E3F4A5B6", "Timestamp": "2026-10-18T01:02:03Z",
			"Counter": "0", "PositiveCounter": "1", "Alias": "camera", "Name": "Camera",
			"Digest": strings.Repeat("0", 64), "ContentType": "text/plain", "APIKeySecret": "token",
		} {
			schema := &openapi3.Schema{Type: &openapi3.Types{"string"}, Pattern: hostDoc.Components.Schemas[name].Value.Pattern}
			if err := schema.VisitJSON(text+"\n", openapi3.SetSchemaRegexCompiler(hostCompiler)); err != nil {
				t.Errorf("host %s newline policy changed: %v", name, err)
			}
			if err := schema.VisitJSON("", openapi3.SetSchemaRegexCompiler(hostCompiler)); err == nil {
				t.Errorf("host %s no longer refuses its invalid value", name)
			}
		}
	}
	if mode == "reverse" {
		checkAtlas()
		checkHostPatterns()
		return
	}
	if strings.HasSuffix(mode, "after") {
		checkAtlas()
	}
	type format struct{ kind, name string }
	formats := map[format]bool{}
	var authored interface{}
	if err := json.Unmarshal(raw, &authored); err != nil {
		t.Fatal(err)
	}
	var collect func(interface{})
	collect = func(value interface{}) {
		switch value := value.(type) {
		case map[string]interface{}:
			if name, ok := value["format"].(string); ok {
				kinds, ok := value["type"].([]interface{})
				if !ok {
					kinds = []interface{}{value["type"]}
				}
				for _, kind := range kinds {
					if kind, ok := kind.(string); ok && kind != "null" {
						formats[format{kind, name}] = true
					}
				}
			}
			for _, child := range value {
				collect(child)
			}
		case []interface{}:
			for _, child := range value {
				collect(child)
			}
		}
	}
	collect(authored)
	unique := !strings.Contains(mode, "refuse")
	if err := hostDoc.Validate(context.Background(), openapi3.SetRegexCompiler(hostCompiler), openapi3.DisableSchemaDefaultsValidation(), openapi3.DisableExamplesValidation()); err != nil {
		t.Fatal(err)
	}
	register := func() {
		openapi3.RegisterArrayUniqueItemsChecker(func([]interface{}) bool { return unique })
		for f := range formats {
			switch f.kind {
			case "string":
				openapi3.DefineStringFormatValidator(f.name, openapi3.NewCallbackValidator(func(s string) error {
					if s != "outside-atlas" {
						return fmt.Errorf("other consumer's format")
					}
					return nil
				}))
			case "integer":
				openapi3.DefineIntegerFormatValidator(f.name, openapi3.NewRangeFormatValidator(int64(-99999), int64(-99999)))
			case "number":
				openapi3.DefineNumberFormatValidator(f.name, openapi3.NewRangeFormatValidator(-99999.0, -99999.0))
			default:
				t.Fatalf("unhandled format kind %s", f.kind)
			}
		}
		for _, name := range []string{"APIKeySecret", "Alias", "ContentType"} {
			if err := hostDoc.Components.Schemas[name].Value.Validate(context.Background(), openapi3.SetRegexCompiler(hostCompiler)); err != nil {
				t.Error(err)
			}
		}
	}
	checkHost := func() {
		t.Helper()
		checkHostPatterns()
		array := &openapi3.Schema{Type: &openapi3.Types{"array"}, UniqueItems: true}
		for _, values := range [][]interface{}{{"same", "same"}, {"one", "two"}} {
			if err := array.VisitJSON(values); (err == nil) != unique {
				t.Errorf("host uniqueness policy changed: %v", err)
			}
		}
		for f := range formats {
			schema := &openapi3.Schema{Type: &openapi3.Types{f.kind}, Format: f.name}
			var accepted, refused interface{} = float64(-99999), float64(5)
			if f.kind == "string" {
				accepted, refused = "outside-atlas", "2026-10-18T01:02:03Z"
			}
			if err := schema.VisitJSON(accepted); err != nil {
				t.Errorf("host %s/%s changed: %v", f.kind, f.name, err)
			}
			if err := schema.VisitJSON(refused); err == nil {
				t.Errorf("host %s/%s no longer refuses its invalid value", f.kind, f.name)
			}
		}
	}
	register()
	checkHost()
	if strings.HasPrefix(mode, "writer") {
		stop, ready := make(chan struct{}), make(chan struct{})
		var worker sync.WaitGroup
		worker.Go(func() {
			register()
			close(ready)
			for {
				select {
				case <-stop:
					return
				default:
					register()
					runtime.Gosched()
				}
			}
		})
		<-ready
		checkAtlas()
		close(stop)
		worker.Wait()
	} else {
		checkAtlas()
	}
	checkHost()
}
