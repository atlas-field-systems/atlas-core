package atlas_test

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"testing"

	atlas "atlas/protocol"
	"github.com/getkin/kin-openapi/openapi3"
)

func TestFirstUseCoexistsWithOtherValidators(t *testing.T) {
	mode := os.Getenv("ATLAS_FIRST_USE_CHILD")
	if mode == "" {
		binary, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		for _, phase := range []string{"before", "after", "writer-before", "writer-after"} {
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
		} {
			err := atlas.ValidateJSON(sample.schema, []byte(sample.wire), atlas.DefaultLimits())
			if (err == nil) != sample.valid {
				t.Errorf("Protocol %s %s: %v", sample.schema, sample.wire, err)
			}
		}
	}
	if mode == "after" || mode == "writer-after" {
		checkAtlas()
	}
	type format struct{ kind, name string }
	formats := map[format]bool{}
	raw, err := os.ReadFile("openapi.json")
	if err != nil {
		t.Fatal(err)
	}
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
	register := func() {
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
	}
	checkHost := func() {
		t.Helper()
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
	if mode == "writer-before" || mode == "writer-after" {
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
