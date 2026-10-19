package atlas_test

import (
	"fmt"
	"os"
	"os/exec"
	"sync"
	"testing"

	atlas "atlas/protocol"
	"github.com/getkin/kin-openapi/openapi3"
)

func TestFirstUseCoexistsWithOtherValidators(t *testing.T) {
	if os.Getenv("ATLAS_FIRST_USE_CHILD") != "1" {
		binary, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(binary, "-test.run=^TestFirstUseCoexistsWithOtherValidators$", "-test.timeout=30s")
		cmd.Env = append(os.Environ(), "ATLAS_FIRST_USE_CHILD=1")
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("fresh process: %v\n%s", err, output)
		}
		return
	}
	for _, format := range []string{"date-time", "uri", "uint64-decimal"} {
		openapi3.DefineStringFormatValidator(format, openapi3.NewCallbackValidator(func(s string) error {
			if s != "outside-atlas" {
				return fmt.Errorf("other consumer's format")
			}
			return nil
		}))
	}
	stop := make(chan struct{})
	ready := make(chan struct{}, 8)
	errors := make(chan error, 8)
	var workers sync.WaitGroup
	for range 8 {
		workers.Go(func() {
			schemas := []*openapi3.Schema{
				openapi3.NewStringSchema().WithFormat("date-time"),
				openapi3.NewStringSchema().WithFormat("uri"),
				openapi3.NewStringSchema().WithFormat("uint64-decimal"),
			}
			ready <- struct{}{}
			for {
				for _, schema := range schemas {
					if err := schema.VisitJSON("outside-atlas"); err != nil {
						errors <- err
						return
					}
				}
				select {
				case <-stop:
					return
				default:
				}
			}
		})
	}
	for range 8 {
		<-ready
	}
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
	} {
		err := atlas.ValidateJSON(sample.schema, []byte(sample.wire), atlas.DefaultLimits())
		if (err == nil) != sample.valid {
			t.Errorf("Protocol %s %s: %v", sample.schema, sample.wire, err)
		}
	}
	close(stop)
	workers.Wait()
	close(errors)
	for err := range errors {
		t.Errorf("another consumer's validator changed: %v", err)
	}
	for _, format := range []string{"date-time", "uri", "uint64-decimal"} {
		schema := openapi3.NewStringSchema().WithFormat(format)
		if err := schema.VisitJSON("outside-atlas"); err != nil {
			t.Errorf("%s overwritten after first use: %v", format, err)
		}
		if err := schema.VisitJSON("2026-10-18T01:02:03Z"); err == nil {
			t.Errorf("%s no longer uses the other consumer's validator", format)
		}
	}
}
