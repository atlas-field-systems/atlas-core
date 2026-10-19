package atlas

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/oapi-codegen/nullable"
)

func TestDeclaredHTTPHeaders(t *testing.T) {
	for _, sample := range readFixture[[]exchange](t, "exchanges.json") {
		t.Run(sample.Name, func(t *testing.T) {
			_, _, op, err := operation(sample.Name)
			if err != nil {
				t.Fatal(err)
			}
			for _, p := range op.Parameters {
				if p.Value.In != "header" || !p.Value.Required {
					continue
				}
				req := exchangeRequest(t, sample)
				req.Header.Del(p.Value.Name)
				if _, err := ValidateRequest(sample.Name, req, fixtureDataset, DefaultLimits()); err == nil {
					t.Errorf("missing required request header %s accepted", p.Value.Name)
				}
			}
			response := op.Responses.Value(strconv.Itoa(sample.Status))
			if response == nil {
				t.Fatal("missing success response")
			}
			for name, h := range response.Value.Headers {
				if h.Value.Required {
					got := exchangeResponse(t, sample)
					got.Header.Del(name)
					if _, err := ValidateResponse(sample.Name, got, ResponseContext{DatasetID: fixtureDataset, WebSocketKey: handshakeKey}, DefaultLimits()); err == nil {
						t.Errorf("missing required response header %s accepted", name)
					}
				}
			}
		})
	}
	doc, err := loadContract()
	if err != nil {
		t.Fatal(err)
	}
	for name, response := range doc.Components.Responses {
		for _, handshake := range []string{"Upgrade", "Connection", "Sec-WebSocket-Accept"} {
			if _, ok := response.Value.Headers[handshake]; ok {
				t.Errorf("ordinary error %s declares handshake header %s", name, handshake)
			}
		}
	}
	for _, sample := range readFixture[[]fixture](t, "cases.json") {
		if !strings.HasPrefix(sample.Name, "HTTP error ") {
			continue
		}
		for _, operation := range []string{"GetAsset", "SubscribeChanges"} {
			status, err := strconv.Atoi(strings.TrimPrefix(sample.Name, "HTTP error "))
			if err != nil {
				t.Fatal(err)
			}
			for _, missing := range []string{"", "Atlas-Dataset-ID", "Atlas-Protocol-Version"} {
				h := headers()
				h.Del(missing)
				response := &http.Response{StatusCode: status, Header: h, Body: io.NopCloser(bytes.NewReader(sample.Value))}
				_, err := ValidateResponse(operation, response, ResponseContext{DatasetID: fixtureDataset}, DefaultLimits())
				if (err == nil) != (missing == "") {
					t.Errorf("%s status %d missing %q: %v", operation, status, missing, err)
				}
			}
		}
	}
}

func TestPluginRawFactsAndSyncGeometry(t *testing.T) {
	raw := []byte(`{"integer":9007199254740993,"decimal":1.234567890123456789,"exponent":1e-20}`)
	payload, err := Decode[PluginPayload]("PluginPayload", raw, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	out, err := Encode("PluginPayload", payload, DefaultLimits())
	if err != nil || !bytes.Equal(out, raw) {
		t.Fatalf("raw Plugin numbers changed: %s, %v", out, err)
	}
	for _, sample := range readFixture[[]fixture](t, "cases.json") {
		if !strings.HasPrefix(sample.Name, "commit Track geometry ") && !strings.HasPrefix(sample.Name, "commit refuses Track geometry ") {
			continue
		}
		err := ValidateFrame("server", sample.Value, FrameContext{fixtureDataset, fixtureRun, true, true}, DefaultLimits())
		if (err == nil) != sample.Valid || err != nil && !strings.Contains(err.Error(), sample.Error) {
			t.Errorf("%s: %v", sample.Name, err)
		}
	}
}

func TestGeneratedPluginPresence(t *testing.T) {
	request := CreateOperationRequest{
		RequestId: fixtureRun, OperationId: fixtureDataset, PluginId: fixtureDataset,
		Release: "independent-v1", Capability: "null-result", Input: nullable.NewNullNullable[PluginPayload](),
	}
	wire, err := Encode("CreateOperationRequest", request, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest("POST", "https://atlas.invalid/plugins/"+fixtureDataset+"/operations", bytes.NewReader(wire))
	if err != nil {
		t.Fatal(err)
	}
	req.Header = headers()
	if _, err := ValidateRequest("CreateOperation", req, fixtureDataset, DefaultLimits()); err != nil {
		t.Fatal(err)
	}
	for _, sample := range readFixture[[]fixture](t, "cases.json") {
		if !strings.HasPrefix(sample.Name, "Plugin Operation optional payloads ") {
			continue
		}
		operation, err := Decode[Operation]("Operation", sample.Value, DefaultLimits())
		if err != nil {
			t.Fatal(err)
		}
		if !operation.Input.IsNull() || operation.RecoveredOutcome == nil {
			t.Fatal("null input or recovered outcome lost")
		}
		for _, payload := range []nullable.Nullable[PluginPayload]{operation.Output, operation.KnownEffects, operation.RecoveredOutcome.Output, operation.RecoveredOutcome.KnownEffects} {
			if payload.IsSpecified() != !strings.HasSuffix(sample.Name, "omitted") || payload.IsNull() != strings.HasSuffix(sample.Name, "null") {
				t.Errorf("%s changed payload presence", sample.Name)
			}
		}
		roundTrip[Operation](t, "Operation", sample.Value)
	}
	request.Input.SetUnspecified()
	if _, err := Encode("CreateOperationRequest", request, DefaultLimits()); err == nil {
		t.Fatal("unset required Plugin input became null")
	}
}

func TestGeometryNullBoundary(t *testing.T) {
	for _, name := range []string{"Geometry", "PointGeometry", "LineGeometry", "PolygonGeometry"} {
		if err := ValidateJSON(name, []byte("null"), DefaultLimits()); err == nil || err.Error() != "invalid_geometry" {
			t.Fatalf("%s accepted null or returned the wrong refusal: %v", name, err)
		}
	}
	if err := ValidateJSON("GeometryObservation", []byte(`{"geometry":null,"observed_at":null}`), DefaultLimits()); err == nil || err.Error() != "invalid_geometry" {
		t.Fatalf("nested null geometry: %v", err)
	}
	if _, err := Decode[GeometryObservation]("GeometryObservation", []byte(`{"geometry":{"type":"Point","coordinates":[0,90]},"observed_at":null}`), DefaultLimits()); err != nil {
		t.Fatal("valid geometry with unknown observation time refused", err)
	}
}

func TestConcreteGeometryVertexLimit(t *testing.T) {
	for _, count := range []int{1024, 1025} {
		points := make([][2]float64, count)
		wire, err := json.Marshal(struct {
			Type        string       `json:"type"`
			Coordinates [][2]float64 `json:"coordinates"`
		}{"LineString", points})
		if err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{"LineGeometry", "Geometry"} {
			err := ValidateJSON(name, wire, DefaultLimits())
			if count == 1024 && err != nil || count == 1025 && (err == nil || err.Error() != "geometry_limit_exceeded") {
				t.Errorf("%s %d vertices: %v", name, count, err)
			}
		}
	}
}

func TestDownloadMediaCaseAndIntegrity(t *testing.T) {
	content := readFixture[struct {
		Descriptor UploadObjectDescriptor `json:"descriptor"`
		Object     json.RawMessage        `json:"object"`
		Hex        string                 `json:"hex"`
	}](t, "content.json")
	var facts map[string]json.RawMessage
	if err := json.Unmarshal(content.Object, &facts); err != nil {
		t.Fatal(err)
	}
	facts["content_type"] = json.RawMessage(`"Text/Plain"`)
	wire, err := json.Marshal(facts)
	if err != nil {
		t.Fatal(err)
	}
	object, err := Decode[Object]("Object", wire, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	for _, sample := range []struct {
		media, body, length, digest string
		valid                       bool
	}{
		{"Text/Plain", "abc", "3", "sha-256=:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=:", true},
		{"text/plain", "abc", "3", "sha-256=:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=:", true},
		{"TEXT/PLAIN; charset=UTF-8", "abc", "3", "sha-256=:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=:", true},
		{"image/png", "abc", "3", "sha-256=:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=:", false},
		{"Text/Plain", "abd", "3", "sha-256=:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=:", false},
		{"Text/Plain", "ab", "3", "sha-256=:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=:", false},
		{"Text/Plain", "abcd", "3", "sha-256=:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=:", false},
		{"Text/Plain", "abc", "4", "sha-256=:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=:", false},
		{"Text/Plain", "abc", "3", "sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:", false},
	} {
		h := headers()
		h.Set("Content-Type", sample.media)
		h.Set("Content-Length", sample.length)
		h.Set("Content-Digest", sample.digest)
		h.Set("Content-Disposition", "attachment")
		_, err := ValidateResponse("ReadObjectContent", &http.Response{StatusCode: 200, Header: h, Body: io.NopCloser(strings.NewReader(sample.body))}, ResponseContext{DatasetID: fixtureDataset, Object: &object, Disposition: "attachment"}, DefaultLimits())
		if (err == nil) != sample.valid {
			t.Errorf("%s %s %s: %v", sample.media, sample.body, sample.length, err)
		}
	}
	if object.ContentType != "Text/Plain" {
		t.Fatal("download rewrote descriptor media type")
	}
	roundTrip[Object](t, "Object", wire)
}
