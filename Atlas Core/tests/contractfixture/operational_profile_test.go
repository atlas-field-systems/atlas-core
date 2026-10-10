package main

import (
	"encoding/json"
	"testing"

	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	_ "github.com/atlas-field-systems/atlas-core/httpcontract"
)

// These narrow non-HTTP checks qualify the new shared schema representation;
// operational Task and telemetry decisions still require real route workflows.
func TestOperationalSchemaProfile(t *testing.T) {
	spec, err := protocol.GetSwagger()
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, schema, wire string
		valid              bool
	}{
		{"unknown heading", "TelemetryPatch", `{"heading_deg":null}`, true},
		{"zero heading", "TelemetryPatch", `{"heading_deg":0}`, true},
		{"last representable heading", "TelemetryPatch", `{"heading_deg":359.99999999999994}`, true},
		{"exclusive upper heading", "TelemetryPatch", `{"heading_deg":360}`, false},
		{"negative heading", "TelemetryPatch", `{"heading_deg":-1}`, false},
		{"complete position", "TelemetryPatch", `{"position":{"latitude":10,"longitude":20}}`, true},
		{"incomplete position", "TelemetryPatch", `{"position":{"latitude":10}}`, false},
		{"source spelling", "NullableSourceInstant", `"2026-10-09T10:00:00.500+00:00"`, true},
		{"invalid source spelling", "NullableSourceInstant", `"not-a-date"`, false},
	}
	for _, fixture := range cases {
		t.Run(fixture.name, func(t *testing.T) {
			var body interface{}
			if err := json.Unmarshal([]byte(fixture.wire), &body); err != nil {
				t.Fatal(err)
			}
			err := spec.Components.Schemas[fixture.schema].Value.VisitJSON(body)
			if (err == nil) != fixture.valid {
				t.Fatalf("valid=%t, got %v", fixture.valid, err)
			}
		})
	}
}
