package main

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"testing"

	// Register the Core boundary's supported formats for this non-HTTP consumer.
	_ "github.com/atlas-field-systems/atlas-core/httpcontract"
	"github.com/atlas-field-systems/atlas-core/tests/contractfixture/generated/contract"
)

// Non-HTTP consumers have no HTTP operation. Their schema and serialization
// boundary therefore needs focused checks using the assembled Protocol source.
func TestCanonicalMessageConsumers(t *testing.T) {
	spec, err := contract.GetSwagger()
	if err != nil {
		t.Fatal(err)
	}
	if err := spec.Validate(context.Background()); err != nil {
		t.Fatal(err)
	}
	encoded, err := os.ReadFile("../../../tests/contract/message-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name                    string          `json:"name"`
		Schema                  string          `json:"schema"`
		Valid                   bool            `json:"valid"`
		Body                    json.RawMessage `json:"body"`
		ExpectedLatitude        float64         `json:"expected_latitude"`
		ExpectedLongitude       float64         `json:"expected_longitude"`
		ExpectedCommitID        string          `json:"expected_commit_id"`
		ExpectedResourceVersion string          `json:"expected_resource_version"`
		ExpectedEntityVersion   string          `json:"expected_entity_version"`
	}
	if err := json.Unmarshal(encoded, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			schema, ok := spec.Components.Schemas[fixture.Schema]
			if !ok {
				t.Fatalf("canonical message schema %s missing", fixture.Schema)
			}
			var value interface{}
			if err := json.Unmarshal(fixture.Body, &value); err != nil {
				t.Fatal(err)
			}
			err := schema.Value.VisitJSON(value)
			if (err == nil) != fixture.Valid {
				t.Fatalf("canonical %s valid=%t, got %v", fixture.Schema, fixture.Valid, err)
			}
			if !fixture.Valid {
				return
			}
			checkPosition := func(position contract.Position) {
				t.Helper()
				if position.Latitude != fixture.ExpectedLatitude || position.Longitude != fixture.ExpectedLongitude {
					t.Fatalf("generated Position changed coordinate precision or axis interpretation: %+v", position)
				}
			}
			var encoded []byte
			switch fixture.Schema {
			case "FixturePluginDispatch":
				var dispatch contract.FixturePluginDispatch
				if err := json.Unmarshal(fixture.Body, &dispatch); err != nil {
					t.Fatal(err)
				}
				checkPosition(dispatch.Input)
				encoded, err = json.Marshal(dispatch)
			case "FixtureChangeMessage":
				var change contract.FixtureChangeMessage
				if err := json.Unmarshal(fixture.Body, &change); err != nil {
					t.Fatal(err)
				}
				if change.CommitId != fixture.ExpectedCommitID || change.ResourceVersion != fixture.ExpectedResourceVersion {
					t.Fatal("generated change consumer changed decimal tokens")
				}
				// Decode and encode the concrete generated variant too. Leaving
				// only the union's raw bytes would not exercise its typed Position.
				tag, discriminatorErr := change.Resource.Discriminator()
				if discriminatorErr != nil {
					t.Fatal(discriminatorErr)
				}
				switch tag {
				case "asset":
					asset, err := change.Resource.AsFixtureMessageAsset()
					if err != nil {
						t.Fatal(err)
					}
					checkPosition(asset.Position)
					if asset.Version != fixture.ExpectedEntityVersion {
						t.Fatal("generated Asset consumer changed its decimal version")
					}
					if err := change.Resource.FromFixtureMessageAsset(asset); err != nil {
						t.Fatal(err)
					}
				case "track":
					track, err := change.Resource.AsFixtureMessageTrack()
					if err != nil {
						t.Fatal(err)
					}
					checkPosition(track.Position)
					if track.Version != fixture.ExpectedEntityVersion {
						t.Fatal("generated Track consumer changed its decimal version")
					}
					if err := change.Resource.FromFixtureMessageTrack(track); err != nil {
						t.Fatal(err)
					}
				case "geofeature":
					geofeature, err := change.Resource.AsFixtureMessageGeofeature()
					if err != nil {
						t.Fatal(err)
					}
					checkPosition(geofeature.Position)
					if geofeature.Version != fixture.ExpectedEntityVersion {
						t.Fatal("generated Geofeature consumer changed its decimal version")
					}
					if err := change.Resource.FromFixtureMessageGeofeature(geofeature); err != nil {
						t.Fatal(err)
					}
				default:
					t.Fatalf("unknown generated Entity discriminator %q", tag)
				}
				encoded, err = json.Marshal(change)
			default:
				t.Fatalf("unknown canonical message consumer %s", fixture.Schema)
			}
			if err != nil {
				t.Fatal(err)
			}
			var decoded interface{}
			if err := json.Unmarshal(encoded, &decoded); err != nil {
				t.Fatal(err)
			}
			if err := schema.Value.VisitJSON(decoded); err != nil {
				t.Fatalf("generated serialization no longer satisfies %s: %v", fixture.Schema, err)
			}
			if !reflect.DeepEqual(decoded, value) {
				t.Fatalf("generated serialization changed independently authored payload: %s", encoded)
			}
		})
	}
}
