package main

import (
	"context"
	"encoding/json"
	"testing"

	"atlas.example/protocol-proof/generated/contract"
)

// Non-HTTP messages have no generated HTTP handler. These focused checks prove
// that both languages use the same canonical schemas at that missing boundary.
func TestNonHTTPMessageSchemas(t *testing.T) {
	spec, err := contract.GetSwagger()
	if err != nil {
		t.Fatal(err)
	}
	if err := spec.Validate(context.Background()); err != nil {
		t.Fatal(err)
	}
	var fixture map[string]json.RawMessage
	if err := json.Unmarshal(fixtures, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, schema string
		valid        bool
	}{
		{"valid_event", "ChangeEvent", true}, {"invalid_event", "ChangeEvent", false},
		{"valid_dispatch", "PluginDispatch", true}, {"invalid_dispatch", "PluginDispatch", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			var value interface{}
			if err := json.Unmarshal(fixture[test.name], &value); err != nil {
				t.Fatal(err)
			}
			err := spec.Components.Schemas[test.schema].Value.VisitJSON(value)
			if (err == nil) != test.valid {
				t.Fatalf("schema %s valid=%t, error=%v", test.schema, test.valid, err)
			}
		})
	}
	var event contract.ChangeEvent
	if err := json.Unmarshal(fixture["valid_event"], &event); err != nil {
		t.Fatal(err)
	}
	if event.CommitId != "9007199254740993" {
		t.Fatal("decimal token changed")
	}
	encoded, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	var value interface{}
	if err := json.Unmarshal(encoded, &value); err != nil {
		t.Fatal(err)
	}
	if err := spec.Components.Schemas["ChangeEvent"].Value.VisitJSON(value); err != nil {
		t.Fatal(err)
	}
	var dispatch contract.PluginDispatch
	if err := json.Unmarshal(fixture["valid_dispatch"], &dispatch); err != nil {
		t.Fatal(err)
	}
	if dispatch.Input.Latitude != 3 || dispatch.Input.Longitude != 4 {
		t.Fatal("shared Position serialization changed")
	}
}
