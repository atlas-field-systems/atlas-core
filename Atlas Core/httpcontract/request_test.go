package httpcontract_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/httpcontract"
	"github.com/getkin/kin-openapi/openapi3"
)

func jsonContract(t *testing.T) *openapi3.T {
	t.Helper()
	spec, err := openapi3.NewLoader().LoadFromData([]byte(`{"openapi":"3.0.3","info":{"title":"Independent adapter boundary","version":"0.1.0"},"paths":{"/value":{"put":{"requestBody":{"required":true,"content":{"application/json":{"schema":{"type":"object","additionalProperties":{"type":"string"}}}}},"responses":{"200":{"description":"accepted"}}}}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := spec.Validate(context.Background()); err != nil {
		t.Fatal(err)
	}
	return spec
}

// The ordinary fixture adds assembly wrappers. This exercises the reusable
// adapter itself, over HTTP with both fixed-length and chunked body streams.
func TestJSONBodyBoundBeforeEffects(t *testing.T) {
	var effects atomic.Int32
	handler, err := httpcontract.ValidateRequests(jsonContract(t), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		effects.Add(1)
		w.WriteHeader(http.StatusOK)
	}), 4096)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	client := &http.Client{Timeout: 5 * time.Second}
	body := []byte(`{"value":"` + strings.Repeat("x", 65536) + `"}`)
	for _, chunked := range []bool{false, true} {
		var input io.Reader = bytes.NewReader(body)
		if chunked {
			input = io.NopCloser(bytes.NewReader(body))
		}
		request, err := http.NewRequest(http.MethodPut, server.URL+"/value", input)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		if chunked {
			request.ContentLength = -1
		}
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		var rejection protocol.Error
		decodeErr := json.NewDecoder(response.Body).Decode(&rejection)
		response.Body.Close()
		if response.StatusCode != 400 {
			t.Fatalf("chunked=%v: status=%d, effects=%d", chunked, response.StatusCode, effects.Load())
		}
		if decodeErr != nil || rejection.Error.Code != "invalid_request" {
			t.Fatalf("expected shared typed rejection: %v %+v", decodeErr, rejection)
		}
	}
	if effects.Load() != 0 {
		t.Fatalf("rejected streams dispatched %d effects", effects.Load())
	}
	for _, chunked := range []bool{false, true} {
		for _, size := range []int{4096, 4097} {
			document := `{"value":"` + strings.Repeat("x", size-12) + `"}`
			var input io.Reader = strings.NewReader(document)
			if chunked {
				input = io.NopCloser(strings.NewReader(document))
			}
			request, err := http.NewRequest(http.MethodPut, server.URL+"/value", input)
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Content-Type", "application/json")
			if chunked {
				request.ContentLength = -1
			}
			response, err := client.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			expected := http.StatusOK
			if size > 4096 {
				expected = http.StatusBadRequest
			}
			if response.StatusCode != expected {
				t.Fatalf("chunked=%v, bytes=%d: status %d, expected %d", chunked, len(document), response.StatusCode, expected)
			}
		}
	}
	if effects.Load() != 2 {
		t.Fatalf("only exact-limit bodies dispatch effects, got %d", effects.Load())
	}
}

func TestJSONBodyBoundMustBePositive(t *testing.T) {
	for _, limit := range []int64{0, -1} {
		if handler, err := httpcontract.ValidateRequests(jsonContract(t), http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}), limit); err == nil || handler != nil {
			t.Fatalf("limit %d configured an unbounded adapter", limit)
		}
	}
}
