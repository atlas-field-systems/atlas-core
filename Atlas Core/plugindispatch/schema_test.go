package plugindispatch_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/atlas-field-systems/atlas-core/plugindispatch"
)

// Focused compiler probes supplement the separate-process capability workflow.
// A real local file and HTTP server distinguish supplied resources from retrieval.
func TestCapabilitySchemaReferencesNeverRetrieveExternalResources(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		if _, err := w.Write([]byte(`{"type":"integer"}`)); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()
	file := filepath.Join(t.TempDir(), "external.json")
	if err := os.WriteFile(file, []byte(`{"type":"integer"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, ref := range []string{"missing.json", "file://" + file, server.URL + "/schema.json"} {
		t.Run(ref, func(t *testing.T) {
			root, err := json.Marshal(map[string]string{"$ref": ref})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := plugindispatch.CompileCapabilitySchema(root, nil, ""); err == nil {
				t.Fatal("a missing bundle resource was retrieved", ref)
			}
		})
	}
	if requests.Load() != 0 {
		t.Fatal("capability compilation made network requests", requests.Load())
	}
}
