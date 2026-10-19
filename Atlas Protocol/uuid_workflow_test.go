package atlas

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestUUIDArrayWorkflow(t *testing.T) {
	count := 0
	for _, sample := range readFixture[[]fixture](t, "cases.json") {
		if !strings.HasPrefix(sample.Name, "UUID array ") {
			continue
		}
		operation := "EditObject"
		if sample.Schema == "SetTaskOrderRequest" {
			operation = "SetTaskOrder"
		}
		for _, exchange := range readFixture[[]exchange](t, "exchanges.json") {
			if exchange.Name != operation {
				continue
			}
			exchange.Request = sample.Value
			_, err := ValidateRequest(operation, exchangeRequest(t, exchange), fixtureDataset, DefaultLimits())
			if (err == nil) != sample.Valid {
				t.Errorf("%s HTTP validation: %v", sample.Name, err)
			}
			count++
		}
	}
	if count != 4 {
		t.Fatalf("expected four Task/Object UUID workflows, got %d", count)
	}
	roundTrip[EntityListQuery](t, "EntityListQuery", []byte(`{"names":["Camera","camera"]}`))
	roundTrip[PluginPayload](t, "PluginPayload", json.RawMessage(`["`+fixtureDataset+`","`+strings.ToLower(fixtureDataset)+`"]`))
}
