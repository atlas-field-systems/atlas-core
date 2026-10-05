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
// adapter itself, over HTTP with fixed-length and chunked streams. Non-JSON
// media exercise the supported middleware's wrapped MaxBytesError too.
func TestJSONBodyBoundBeforeEffects(t *testing.T) {
	for _, media := range []string{"application/json", "text/plain", "application/octet-stream"} {
		t.Run(media, func(t *testing.T) {
			var effects atomic.Int32
			spec := jsonContract(t)
			if media != "application/json" {
				spec.Paths.Value("/value").Put.RequestBody.Value.Content = openapi3.Content{
					media: &openapi3.MediaType{Schema: &openapi3.SchemaRef{Value: openapi3.NewStringSchema()}},
				}
			}
			handler, err := httpcontract.ValidateRequests(spec, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
				request.Header.Set("Content-Type", media)
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
				if response.StatusCode != http.StatusRequestEntityTooLarge {
					t.Fatalf("chunked=%v: status=%d, effects=%d", chunked, response.StatusCode, effects.Load())
				}
				if decodeErr != nil || rejection.Error.Code != "payload_too_large" {
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
					request.Header.Set("Content-Type", media)
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
						expected = http.StatusRequestEntityTooLarge
					}
					if response.StatusCode != expected {
						t.Fatalf("chunked=%v, bytes=%d: status %d, expected %d", chunked, len(document), response.StatusCode, expected)
					}
				}
			}
			if effects.Load() != 2 {
				t.Fatalf("only exact-limit bodies dispatch effects, got %d", effects.Load())
			}
		})
	}
}

// An unrouted request has no authored pattern; its diagnostic still names the
// method without trailing separator text.
func TestUnroutedBodyBoundDiagnostic(t *testing.T) {
	handler, err := httpcontract.ValidateRequests(jsonContract(t), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("unrouted oversized body dispatched an effect")
	}), 16)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPut, "/unknown", strings.NewReader(`{"value":"`+strings.Repeat("x", 32)+`"}`))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	var rejection protocol.Error
	if err := json.NewDecoder(recorder.Body).Decode(&rejection); err != nil {
		t.Fatal(err)
	}
	if recorder.Code != http.StatusRequestEntityTooLarge || rejection.Error.Message != "Request body exceeds its configured byte bound for PUT" {
		t.Fatalf("status %d, message %q", recorder.Code, rejection.Error.Message)
	}
}

func TestJSONBodyBoundMustBePositive(t *testing.T) {
	for _, limit := range []int64{0, -1} {
		if handler, err := httpcontract.ValidateRequests(jsonContract(t), http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}), limit); err == nil || handler != nil {
			t.Fatalf("limit %d configured an unbounded adapter", limit)
		}
	}
}

// The fixture declares application/json only. This public adapter check authors
// another JSON media type already decoded by the pinned validator, including its
// existing parameter acceptance, without adding a shipped route or media type.
func TestJSONDocumentChecksFollowDeclaredMedia(t *testing.T) {
	for _, media := range []string{"application/json", "application/problem+json"} {
		t.Run(media, func(t *testing.T) {
			spec := jsonContract(t)
			body := spec.Paths.Value("/value").Put.RequestBody.Value
			body.Content = openapi3.Content{media: body.Content["application/json"]}
			if err := spec.Validate(context.Background()); err != nil {
				t.Fatal(err)
			}
			var effects atomic.Int32
			adapter, err := httpcontract.ValidateRequests(spec, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				effects.Add(1)
				w.WriteHeader(http.StatusOK)
			}), 4096)
			if err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(adapter)
			defer server.Close()
			client := &http.Client{Timeout: 5 * time.Second}
			for _, parameters := range []string{"", "; =x", "; charset=first; charset=second"} {
				for _, scenario := range []struct {
					name   string
					body   string
					status int
				}{
					{"valid Unicode", `{"value":"雪\ud83c\udf0d"}`, 200},
					{"duplicate name", `{"value":"first","value":"second"}`, 400},
					{"unpaired surrogate", `{"value":"\ud800"}`, 400},
					{"invalid UTF-8", "{\"value\":\"\xff\"}", 400},
				} {
					t.Run(parameters+"/"+scenario.name, func(t *testing.T) {
						before := effects.Load()
						request, err := http.NewRequest(http.MethodPut, server.URL+"/value", strings.NewReader(scenario.body))
						if err != nil {
							t.Fatal(err)
						}
						request.Header.Set("Content-Type", media+parameters)
						response, err := client.Do(request)
						if err != nil {
							t.Fatal(err)
						}
						defer func() {
							if err := response.Body.Close(); err != nil {
								t.Fatal(err)
							}
						}()
						if response.StatusCode != scenario.status {
							t.Fatalf("status %d, expected %d; dispatched effects %d", response.StatusCode, scenario.status, effects.Load()-before)
						}
						if scenario.status == http.StatusOK {
							if effects.Load()-before != 1 {
								t.Fatal("valid payload must retain one handler effect")
							}
							return
						}
						var rejection protocol.Error
						if err := json.NewDecoder(response.Body).Decode(&rejection); err != nil {
							t.Fatal(err)
						}
						if rejection.Error.Code != "invalid_request" || !strings.Contains(rejection.Error.Message, "PUT /value") {
							t.Fatalf("expected typed rejection with safe route context: %+v", rejection)
						}
						if effects.Load() != before {
							t.Fatal("rejected original JSON dispatched effects")
						}
					})
				}
			}
		})
	}
}
