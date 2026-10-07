package plugindispatch_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/atlas-field-systems/atlas-core/plugindispatch"
)

func TestArrayResourceBoundsFollowCanonicalSchema(t *testing.T) {
	encoded, err := os.ReadFile("../../Atlas Protocol/plugin-dispatch.json")
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &document); err != nil {
		t.Fatal(err)
	}
	var limits map[string]json.RawMessage
	if err := json.Unmarshal(document["x-limits"], &limits); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"max_effects", "max_outputs", "max_receipts"} {
		delete(limits, key)
	}
	document["x-limits"] = encodedJSON(t, limits)
	var definitions map[string]json.RawMessage
	if err := json.Unmarshal(document["$defs"], &definitions); err != nil {
		t.Fatal(err)
	}
	for _, change := range []struct {
		definition, property string
		bound                int
	}{{"evidence", "effects", 1}, {"evidence", "outputs", 2}, {"ready", "receipts", 3}} {
		var definition, properties, array map[string]json.RawMessage
		if err := json.Unmarshal(definitions[change.definition], &definition); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(definition["properties"], &properties); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(properties[change.property], &array); err != nil {
			t.Fatal(err)
		}
		array["maxItems"] = encodedJSON(t, change.bound)
		properties[change.property] = encodedJSON(t, array)
		definition["properties"] = encodedJSON(t, properties)
		definitions[change.definition] = encodedJSON(t, definition)
	}
	document["$defs"] = encodedJSON(t, definitions)
	path := filepath.Join(t.TempDir(), "contract.json")
	if err := os.WriteFile(path, encodedJSON(t, document), 0o600); err != nil {
		t.Fatal(err)
	}
	contract, err := plugindispatch.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if contract.Limits.MaxEffects != 1 || contract.Limits.MaxOutputs != 2 || contract.Limits.MaxReceipts != 3 {
		t.Fatal("resource policy ignored the authored array bounds", contract.Limits)
	}
	request := plugindispatch.Request{Kind: "evidence", Token: "private-fixture-token", Binding: plugindispatch.Binding{PluginID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", PrincipalID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", DatasetID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", CoreRunID: "run", RuntimeGeneration: "runtime"}}
	request.Evidence = &plugindispatch.Evidence{Execution: plugindispatch.Dispatch{Binding: request.Binding, OperationID: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", Release: plugindispatch.Release{PackageID: "fixture", Version: "1", ImageDigest: "fixture"}, CapabilityID: "double", InputVersion: "1", Input: json.RawMessage(`1`), InputDigest: plugindispatch.Digest([]byte(`1`))}, Sequence: "1", Effects: []plugindispatch.Effect{{ID: "first", Description: "first"}}}
	request.Evidence.Revision = plugindispatch.Revision(*request.Evidence)
	if _, err := contract.Encode(request); err != nil {
		t.Fatal("exactly bounded evidence was rejected", err)
	}
	request.Evidence.Effects = append(request.Evidence.Effects, plugindispatch.Effect{ID: "second", Description: "second"})
	request.Evidence.Revision = plugindispatch.Revision(*request.Evidence)
	if _, err := contract.Encode(request); err == nil {
		t.Fatal("wire validation accepted excess effects")
	}
}

func encodedJSON[T any](t *testing.T, value T) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}
