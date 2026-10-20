package atlas

import (
	"encoding/json"
	"testing"
)

func queueExchange(t *testing.T, name string) exchange {
	t.Helper()
	for _, sample := range readFixture[[]exchange](t, "exchanges.json") {
		if sample.Name == name {
			return sample
		}
	}
	t.Fatalf("missing exchange %s", name)
	return exchange{}
}

func queueJSON(t *testing.T, value interface{}) json.RawMessage {
	t.Helper()
	wire, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return wire
}

func queueFields(t *testing.T, wire json.RawMessage) map[string]json.RawMessage {
	t.Helper()
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(wire, &fields); err != nil {
		t.Fatal(err)
	}
	return fields
}

func TestTaskQueueProjectionBoundaries(t *testing.T) {
	queue := json.RawMessage(`{"asset_id":"` + fixtureDataset + `","revision":"4","task_ids":[],"confirmed_revision":null}`)
	for _, operation := range []string{"GetAsset", "GetAssignedTasks"} {
		t.Run(operation, func(t *testing.T) {
			sample := queueExchange(t, operation)
			envelope := queueFields(t, sample.Response)
			data := queueFields(t, envelope["data"])
			if operation == "GetAssignedTasks" {
				data["items"] = json.RawMessage(`[]`)
			}
			delete(data, "queue_revision")
			for _, variant := range []string{"complete", "missing queue", "missing confirmation", "duplicate IDs", "case duplicate IDs"} {
				t.Run(variant, func(t *testing.T) {
					data["task_queue"] = queue
					switch variant {
					case "missing queue":
						delete(data, "task_queue")
					case "missing confirmation":
						fields := queueFields(t, queue)
						delete(fields, "confirmed_revision")
						data["task_queue"] = queueJSON(t, fields)
					case "duplicate IDs", "case duplicate IDs":
						fields := queueFields(t, queue)
						second := fixtureDataset
						if variant == "case duplicate IDs" {
							second = "a0b1c2d3-e4f5-4a67-8b90-c1d2e3f4a5b6"
						}
						fields["task_ids"] = queueJSON(t, []string{fixtureDataset, second})
						data["task_queue"] = queueJSON(t, fields)
					}
					envelope["data"] = queueJSON(t, data)
					sample.Response = queueJSON(t, envelope)
					_, err := ValidateResponse(operation, exchangeResponse(t, sample), ResponseContext{DatasetID: fixtureDataset}, DefaultLimits())
					if (err == nil) != (variant == "complete") {
						t.Fatalf("queue projection validation: %v", err)
					}
				})
			}
		})
	}
}
