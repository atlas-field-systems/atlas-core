package httpcontract_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/httpcontract"
	"github.com/getkin/kin-openapi/openapi3"
)

// Callers may compose body wrappers. Required presence must survive wrapping;
// zero-length chunked content remains a deliberately supplied stream.
func TestRequiredBinaryBodySurvivesWrapping(t *testing.T) {
	spec, err := openapi3.NewLoader().LoadFromData([]byte(`{"openapi":"3.0.3","info":{"title":"Independent binary adapter","version":"0.1.0"},"paths":{"/content":{"put":{"operationId":"replaceContent","requestBody":{"required":true,"content":{"application/octet-stream":{"schema":{"type":"string","format":"binary"}}}},"responses":{"200":{"description":"accepted"}}},"get":{"responses":{"200":{"description":"selected bytes"}}}}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if err = spec.Validate(context.Background()); err != nil {
		t.Fatal(err)
	}
	selected := []byte{0, 255, 65, 0, 13, 10, 128}
	var effects atomic.Int32
	adapter, err := httpcontract.ValidateBinaryRequests(spec, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut {
			body, err := io.ReadAll(r.Body)
			if err != nil {
				httpcontract.RequestError(w, r, err)
				return
			}
			selected = body
			effects.Add(1)
		}
		if _, err := w.Write(selected); err != nil {
			t.Errorf("write selected content: %v", err)
		}
	}), "replaceContent", 1024, 4096)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 4096)
		adapter.ServeHTTP(w, r)
	}))
	defer server.Close()
	client := &http.Client{Timeout: 5 * time.Second}
	missing, err := http.NewRequest(http.MethodPut, server.URL+"/content", nil)
	if err != nil {
		t.Fatal(err)
	}
	missing.Header.Set("Content-Type", "application/octet-stream")
	response, err := client.Do(missing)
	if err != nil {
		t.Fatal(err)
	}
	var rejection protocol.Error
	decodeErr := json.NewDecoder(response.Body).Decode(&rejection)
	response.Body.Close()
	if response.StatusCode != 400 {
		t.Fatalf("bodyless wrapped PUT returned %d with %d effects", response.StatusCode, effects.Load())
	}
	if decodeErr != nil || rejection.Error.Code != "invalid_request" {
		t.Fatalf("expected typed rejection: %v %+v", decodeErr, rejection)
	}
	read, err := client.Get(server.URL + "/content")
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(read.Body)
	read.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(body, []byte{0, 255, 65, 0, 13, 10, 128}) || effects.Load() != 0 {
		t.Fatalf("missing body changed selected bytes: %v effects %d", body, effects.Load())
	}
	empty, err := http.NewRequest(http.MethodPut, server.URL+"/content", io.NopCloser(bytes.NewReader(nil)))
	if err != nil {
		t.Fatal(err)
	}
	empty.ContentLength = -1
	empty.Header.Set("Content-Type", "application/octet-stream")
	accepted, err := client.Do(empty)
	if err != nil {
		t.Fatal(err)
	}
	accepted.Body.Close()
	if accepted.StatusCode != 200 || effects.Load() != 1 {
		t.Fatalf("explicit empty chunked body: status %d effects %d", accepted.StatusCode, effects.Load())
	}
}
