package atlas

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestLargePluginPayloadRoundTrip(t *testing.T) {
	limits := DefaultLimits()
	prefix := fmt.Sprintf(`{"request_id":%q,"operation_id":%q,"plugin_id":%q,"release":"independent-v1","capability":"large-input","input":`, fixtureRun, fixtureDataset, fixtureDataset)
	for _, size := range []int{100000, 100001, 500002, limits.MaxJSONBytes - len(prefix) - 1} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			raw := []byte(`"` + strings.Repeat("x", size-2) + `"`)
			payload, err := Decode[PluginPayload]("PluginPayload", raw, limits)
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := Encode("PluginPayload", payload, limits)
			if err != nil || !bytes.Equal(encoded, raw) {
				t.Fatalf("root Plugin payload round trip: %v", err)
			}
			request, err := Decode[CreateOperationRequest]("CreateOperationRequest", []byte(prefix+string(raw)+`}`), limits)
			if err != nil {
				t.Fatal(err)
			}
			encoded, err = Encode("CreateOperationRequest", request, limits)
			if err != nil {
				t.Fatalf("nested Plugin payload round trip: %v", err)
			}
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(encoded, &fields); err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(fields["input"], raw) {
				t.Fatal("nested Plugin input changed")
			}
			if _, err := Decode[CreateOperationRequest]("CreateOperationRequest", encoded, limits); err != nil {
				t.Fatal("encoded request is invalid", err)
			}
		})
	}
	for _, raw := range []string{
		`"` + strings.Repeat("x", limits.MaxJSONBytes-1) + `"`,
		`[` + strings.Repeat("0,", limits.MaxValues-1) + `0]`,
		strings.Repeat("[", limits.MaxDepth+1) + `0` + strings.Repeat("]", limits.MaxDepth+1),
	} {
		if _, err := Encode("PluginPayload", PluginPayload(raw), limits); err == nil {
			t.Fatal("oversized or excessive-work Plugin payload accepted")
		}
	}
}
