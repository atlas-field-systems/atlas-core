package httpcontract

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func gzipMessage(t *testing.T, body []byte) []byte {
	t.Helper()
	var encoded bytes.Buffer
	writer := gzip.NewWriter(&encoded)
	if _, err := writer.Write(body); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return encoded.Bytes()
}

func TestHTTPEncodingPreservesIndependentMessages(t *testing.T) {
	for _, body := range []string{`{"value":"short"}`, `{"value":"` + strings.Repeat("operational-report-", 200) + `"}`} {
		t.Run(body[:15], func(t *testing.T) {
			handler, err := HTTPEncoding(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				value, err := io.ReadAll(r.Body)
				if err != nil {
					t.Error(err)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				if _, err := w.Write(value); err != nil {
					t.Error(err)
				}
			}), 8192)
			if err != nil {
				t.Fatal(err)
			}
			server := httptest.NewTLSServer(handler)
			defer server.Close()
			request, err := http.NewRequest(http.MethodPost, server.URL, bytes.NewReader(gzipMessage(t, []byte(body))))
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Content-Encoding", "gzip")
			request.Header.Set("Accept-Encoding", "gzip")
			response, err := server.Client().Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			encoded, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			var reader io.Reader = bytes.NewReader(encoded)
			compressed := response.Header.Get("Content-Encoding") == "gzip"
			if compressed {
				decoder, err := gzip.NewReader(bytes.NewReader(encoded))
				if err != nil {
					t.Fatal(err)
				}
				defer decoder.Close()
				reader = decoder
			}
			actual, err := io.ReadAll(reader)
			if err != nil || string(actual) != body {
				t.Fatalf("message changed: %q, %v", actual, err)
			}
			if compressed != (len(body) > 1000) {
				t.Fatalf("unexpected encoding choice for %d bytes: %v", len(body), compressed)
			}
			if response.Header.Get("Accept-Encoding") != "gzip, identity" {
				t.Fatal("request receiver support missing")
			}
			if compressed {
				direct := response.Header.Clone()
				direct.Del("Content-Encoding")
				if responseWireBytes(t, response.Header, encoded) >= responseWireBytes(t, direct, []byte(body)) {
					t.Fatal("gzip did not reduce complete message size")
				}
			}
		})
	}
}

func responseWireBytes(t *testing.T, headers http.Header, body []byte) int {
	t.Helper()
	response := &http.Response{StatusCode: http.StatusOK, Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1,
		Header: headers.Clone(), ContentLength: int64(len(body)), Body: io.NopCloser(bytes.NewReader(body))}
	response.Header.Del("Content-Length")
	var wire bytes.Buffer
	if err := response.Write(&wire); err != nil {
		t.Fatal(err)
	}
	return wire.Len()
}

func TestHTTPEncodingRejectsInvalidBodiesBeforeHandler(t *testing.T) {
	valid := gzipMessage(t, []byte(`{"status":"ready"}`))
	cases := []struct {
		name, encoding string
		body           []byte
		status         int
	}{
		{"unsupported", "br", valid, 415},
		{"truncated", "gzip", valid[:len(valid)-2], 400},
		{"corrupt", "gzip", []byte("invalid compressed message"), 400},
		{"multiple members", "gzip", append(append([]byte{}, valid...), valid...), 400},
		{"trailing bytes", "gzip", append(append([]byte{}, valid...), 'x'), 400},
		{"expanded limit", "gzip", gzipMessage(t, bytes.Repeat([]byte("x"), 2048)), 413},
		{"encoded limit", "gzip", bytes.Repeat([]byte("x"), 2048), 413},
		{"direct limit", "identity", bytes.Repeat([]byte("x"), 2048), 413},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			called := false
			handler, err := HTTPEncoding(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }), 1024)
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(test.body))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Content-Encoding", test.encoding)
			result := httptest.NewRecorder()
			handler.ServeHTTP(result, request)
			if result.Code != test.status || called {
				t.Fatalf("status=%d, dispatched=%v", result.Code, called)
			}
		})
	}
}

func TestJSONDepthIsBoundedAtTheOriginalDocumentBoundary(t *testing.T) {
	if err := CheckJSONDocument([]byte(strings.Repeat("[", 64) + "0" + strings.Repeat("]", 64))); err != nil {
		t.Fatalf("bounded document rejected: %v", err)
	}
	if err := CheckJSONDocument([]byte(strings.Repeat("[", 65) + "0" + strings.Repeat("]", 65))); err == nil {
		t.Fatal("over-depth document accepted")
	}
}

func TestGzipNegotiationKeepsExplicitRefusalAndNonJSONResponsesDirect(t *testing.T) {
	for _, test := range []struct {
		accept, media, expected string
	}{
		{"gzip;q=0, *;q=1", "application/json", ""},
		{"*;q=1", "application/json", "gzip"},
		{"gzip;q=0.5", "application/json", "gzip"},
		{"identity", "application/json", ""},
		{"identity;q=1, *;q=0", "application/json", ""},
		{"identity;q=0.3, gzip;q=0", "application/json", ""},
		{"", "application/json", ""},
		{"gzip", "text/html", ""},
	} {
		t.Run(test.accept+test.media, func(t *testing.T) {
			handler, err := HTTPEncoding(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", test.media)
				if _, err := io.WriteString(w, strings.Repeat("independent-message ", 100)); err != nil {
					t.Error(err)
				}
			}), 4096)
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodGet, "/", nil)
			request.Header.Set("Accept-Encoding", test.accept)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if actual := response.Header().Get("Content-Encoding"); actual != test.expected {
				t.Fatalf("encoding=%q, want %q", actual, test.expected)
			}
		})
	}
}

func TestOversizedResponseLeavesTheCallerOutcomeUnknown(t *testing.T) {
	handler, err := HTTPEncoding(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(bytes.Repeat([]byte("x"), 2048))
	}), 1024)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewTLSServer(handler)
	defer server.Close()
	response, err := server.Client().Get(server.URL)
	if err == nil {
		response.Body.Close()
		t.Fatalf("oversized response produced status %d instead of transport failure", response.StatusCode)
	}
}

func TestResponseNegotiationRefusesForbiddenIdentityBeforeEffects(t *testing.T) {
	for _, accept := range []string{"gzip, identity;q=0", "gzip;q=0, identity;q=0", "*;q=0", "gzip, *;q=0", "br, identity;q=0", "GZIP;Q=1, IDENTITY;Q=0"} {
		t.Run(accept, func(t *testing.T) {
			called := false
			handler, err := HTTPEncoding(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				called = true
				w.Header().Set("Content-Type", "application/json")
				io.WriteString(w, `{}`)
			}), 4096)
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodPost, "/", nil)
			request.Header.Set("Accept-Encoding", accept)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusNotAcceptable || called || response.Body.Len() != 0 {
				t.Fatalf("status=%d dispatched=%v body=%q", response.Code, called, response.Body.String())
			}
		})
	}
}
