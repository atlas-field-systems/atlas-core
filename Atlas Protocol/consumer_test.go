package atlas

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
)

type fixture struct {
	Name   string          `json:"name"`
	Schema string          `json:"schema"`
	Valid  bool            `json:"valid"`
	Value  json.RawMessage `json:"value"`
	Raw    *string         `json:"raw"`
	Hex    string          `json:"hex"`
	Error  string          `json:"error"`
}
type exchange struct {
	Name           string          `json:"name"`
	RequestSchema  *string         `json:"request_schema"`
	Request        json.RawMessage `json:"request"`
	ResponseSchema *string         `json:"response_schema"`
	Response       json.RawMessage `json:"response"`
	Status         int             `json:"status"`
	Query          string          `json:"query"`
}
type manifest struct {
	CaseNames     []string `json:"case_names"`
	ExchangeNames []string `json:"exchange_names"`
	Valid         int      `json:"valid"`
	Invalid       int      `json:"invalid"`
}

func readFixture[T interface{}](t *testing.T, name string) T {
	t.Helper()
	fixtureRoot := os.Getenv("ATLAS_FIXTURES")
	if fixtureRoot == "" {
		fixtureRoot = "fixtures"
	}
	raw, err := os.ReadFile(fixtureRoot + "/" + name)
	if err != nil {
		t.Fatal(err)
	}
	var result T
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result); err != nil {
		t.Fatal(err)
	}
	return result
}
func roundTrip[T interface{}](t *testing.T, name string, wire []byte) []byte {
	t.Helper()
	value, err := Decode[T](name, wire, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	out, err := Encode(name, value, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Decode[T](name, out, DefaultLimits()); err != nil {
		t.Fatal(err)
	}
	var want, got interface{}
	if err := json.Unmarshal(wire, &want); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(want, got) {
		t.Fatalf("round trip changed facts\n%s\n%s", wire, out)
	}
	return out
}
func TestSharedFixtures(t *testing.T) {
	cases := readFixture[[]fixture](t, "cases.json")
	expected := readFixture[manifest](t, "manifest.json")
	var names []string
	valid, invalid := 0, 0
	for _, sample := range cases {
		names = append(names, sample.Name)
		t.Run(sample.Name, func(t *testing.T) {
			wire := []byte(sample.Value)
			if sample.Raw != nil {
				wire = []byte(*sample.Raw)
			}
			if sample.Hex != "" {
				var err error
				wire, err = hex.DecodeString(sample.Hex)
				if err != nil {
					t.Fatal(err)
				}
			}
			err := ValidateJSON(sample.Schema, wire, DefaultLimits())
			if sample.Valid {
				valid++
				if err != nil {
					t.Fatal(err)
				}
				generatedRoundTrip(t, sample.Schema, wire)
			} else {
				invalid++
				if err == nil {
					t.Fatal("negative fixture unexpectedly passed")
				}
				if sample.Error != "" && !strings.Contains(err.Error(), sample.Error) {
					t.Fatalf("wrong refusal %v, wanted %s", err, sample.Error)
				}
			}
		})
	}
	if valid != 278 || invalid != 289 || valid != expected.Valid || invalid != expected.Invalid || !slices.Equal(names, expected.CaseNames) {
		t.Fatal("missing, skipped, duplicated, or changed fixture inventory", valid, invalid)
	}
	seen := map[string]bool{}
	for _, n := range names {
		if seen[n] {
			t.Fatalf("duplicate fixture %s", n)
		}
		seen[n] = true
	}
}

const fixtureDataset = "A0B1C2D3-E4F5-4A67-8B90-C1D2E3F4A5B6"
const fixtureRun = "00000000-0000-0000-0000-000000000002"
const handshakeKey = "dGhlIHNhbXBsZSBub25jZQ=="

func headers() http.Header {
	h := http.Header{}
	h.Set("Authorization", "Bearer "+strings.Repeat("A", 43))
	h.Set("Atlas-Dataset-ID", fixtureDataset)
	h.Set("Atlas-Protocol-Version", Version())
	h.Set("Content-Type", "application/json")
	return h
}
func exchangeRequest(t *testing.T, sample exchange) *http.Request {
	t.Helper()
	pattern, method, _, err := operation(sample.Name)
	if err != nil {
		t.Fatal(err)
	}
	path := regexp.MustCompile(`\{([^}]+)\}`).ReplaceAllStringFunc(pattern, func(field string) string {
		if field == "{alias}" {
			return "Camera-A"
		}
		return fixtureDataset
	})
	if sample.Query != "" {
		path += "?" + sample.Query
	}
	var body []byte
	if sample.RequestSchema != nil {
		body = sample.Request
	}
	req, err := http.NewRequest(method, "https://atlas.invalid"+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header = headers()
	if sample.Name == "UploadObject" {
		req.Header.Set("Content-Type", "application/octet-stream")
		req.Header.Set("Atlas-Object-Descriptor", base64.RawURLEncoding.EncodeToString(sample.Request))
		req.Body = io.NopCloser(strings.NewReader("abc"))
	}
	if sample.Name == "SubscribeChanges" {
		req.Header.Set("Upgrade", "websocket")
		req.Header.Set("Connection", "Upgrade")
		req.Header.Set("Sec-WebSocket-Version", "13")
		req.Header.Set("Sec-WebSocket-Key", handshakeKey)
		req.Header.Del("Authorization")
		req.Header.Del("Atlas-Dataset-ID")
		req.Header.Del("Atlas-Protocol-Version")
	}
	if sample.Name == "GetHealth" {
		req.Header.Del("Atlas-Dataset-ID")
		req.Header.Del("Atlas-Protocol-Version")
	}
	return req
}
func exchangeResponse(t *testing.T, sample exchange) *http.Response {
	t.Helper()
	h := headers()
	var body []byte
	if sample.ResponseSchema != nil {
		body = sample.Response
	}
	if sample.Name == "ReadObjectContent" {
		body = []byte("abc")
		h.Set("Content-Type", "text/plain")
		h.Set("Content-Length", "3")
		h.Set("Content-Disposition", "attachment")
		h.Set("Content-Digest", "sha-256=:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=:")
	}
	if sample.Name == "GetReferenceDocument" {
		body = document
		h.Set("Content-Type", "application/vnd.oai.openapi+json")
	}
	if sample.Name == "SubscribeChanges" {
		h.Set("Upgrade", "websocket")
		h.Set("Connection", "Upgrade")
		h.Set("Sec-WebSocket-Accept", "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
	}
	return &http.Response{StatusCode: sample.Status, Header: h, Body: io.NopCloser(bytes.NewReader(body))}
}
func TestEveryHTTPExchange(t *testing.T) {
	samples := readFixture[[]exchange](t, "exchanges.json")
	expected := readFixture[manifest](t, "manifest.json")
	var names []string
	for _, sample := range samples {
		names = append(names, sample.Name)
		t.Run(sample.Name, func(t *testing.T) {
			req := exchangeRequest(t, sample)
			if _, err := ValidateRequest(sample.Name, req, fixtureDataset, DefaultLimits()); err != nil {
				t.Fatal("request", err)
			}
			ctx := ResponseContext{DatasetID: fixtureDataset, WebSocketKey: handshakeKey, Disposition: "attachment"}
			if _, err := ValidateResponse(sample.Name, exchangeResponse(t, sample), ctx, DefaultLimits()); err != nil {
				t.Fatal("response", err)
			}
			if sample.Name != "SubscribeChanges" {
				mixed := exchangeRequest(t, sample)
				mixed.Header.Set("Authorization", "bEaReR "+strings.Repeat("A", 43))
				if _, err := ValidateRequest(sample.Name, mixed, fixtureDataset, DefaultLimits()); err != nil {
					t.Fatal("authentication scheme case", err)
				}
			}
			req = exchangeRequest(t, sample)
			req.URL.RawQuery = "unsupported_filter=true"
			if _, err := ValidateRequest(sample.Name, req, fixtureDataset, DefaultLimits()); err == nil {
				t.Fatal("unknown filter accepted")
			}
			req = exchangeRequest(t, sample)
			if sample.Name == "SubscribeChanges" {
				req.Header.Set("Sec-WebSocket-Key", "invalid")
			} else {
				req.Header.Del("Authorization")
			}
			if _, err := ValidateRequest(sample.Name, req, fixtureDataset, DefaultLimits()); err == nil {
				t.Fatal("missing authorization or malformed upgrade accepted")
			}
			response := exchangeResponse(t, sample)
			response.Header.Del("Atlas-Dataset-ID")
			if _, err := ValidateResponse(sample.Name, response, ctx, DefaultLimits()); err == nil {
				t.Fatal("contextless response accepted")
			}
			response = exchangeResponse(t, sample)
			response.StatusCode = 299
			if _, err := ValidateResponse(sample.Name, response, ctx, DefaultLimits()); err == nil {
				t.Fatal("undeclared status accepted")
			}
		})
	}
	if len(names) != 67 || !slices.Equal(names, expected.ExchangeNames) {
		t.Fatal("missing exchange fixture")
	}
	inventory, err := os.ReadFile("fixtures/inventory.tsv")
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, name := range names {
		if seen[name] {
			t.Fatal("duplicate exchange")
		}
		seen[name] = true
	}
	for line := range strings.SplitSeq(strings.TrimSpace(string(inventory)), "\n") {
		fields := strings.Split(line, "\t")
		if len(fields) != 3 {
			t.Fatal("bad inventory")
		}
		path, method, _, err := operation(fields[0])
		if err != nil || path != fields[2] || method != fields[1] || !seen[fields[0]] {
			t.Fatal("inventory mismatch", line, err)
		}
	}
}
func TestRefusalsAndBoundaryFacts(t *testing.T) {
	cases := readFixture[[]fixture](t, "cases.json")
	for _, sample := range cases {
		if !strings.HasPrefix(sample.Name, "HTTP error ") {
			continue
		}
		status, err := strconv.Atoi(strings.TrimPrefix(sample.Name, "HTTP error "))
		if err != nil {
			t.Fatal(err)
		}
		response := &http.Response{StatusCode: status, Header: headers(), Body: io.NopCloser(bytes.NewReader(sample.Value))}
		if _, err := ValidateResponse("GetAsset", response, ResponseContext{DatasetID: fixtureDataset}, DefaultLimits()); err != nil {
			t.Fatal(status, err)
		}
	}
	for _, sample := range readFixture[[]exchange](t, "exchanges.json") {
		if sample.Name == "GetAsset" {
			response, err := Decode[GetAssetResponse]("GetAssetResponse", sample.Response, DefaultLimits())
			if err != nil {
				t.Fatal(err)
			}
			asset := response.Data
			if asset.Id != fixtureDataset || asset.Version != "18446744073709551615" {
				t.Fatal("identity precision changed")
			}
			if asset.Telemetry == nil {
				t.Fatal("missing telemetry")
			}
			retained, err := asset.Telemetry.AsRetainedTelemetryReport()
			if err != nil {
				t.Fatal(err)
			}
			value, err := retained.Result.AsTelemetryValue()
			if err != nil {
				t.Fatal(err)
			}
			if !value.Value.Position.IsSpecified() || value.Value.Position.IsNull() || !value.Value.AltitudeObservedAt.IsNull() || value.Value.Airspeed.IsSpecified() || value.Value.ObservedAt.MustGet() != "2026-10-18T01:02:03.123400000+05:30" {
				t.Fatal("nullable or timestamp facts changed")
			}
			position, err := value.Value.Position.Get()
			if err != nil || position.Latitude != 51.5074123456789 {
				t.Fatal("float64 precision changed")
			}
			value.Value.Position.SetUnspecified()
			if _, err := Encode("TelemetryValue", value, DefaultLimits()); err == nil {
				t.Fatal("unset required nullable was converted to unknown")
			}
		}
	}
	if _, err := Encode("Telemetry", Telemetry{}, DefaultLimits()); err == nil {
		t.Fatal("unset telemetry accepted")
	}
	if _, err := Decode[Asset]("Telemetry", []byte(`{}`), DefaultLimits()); err == nil {
		t.Fatal("schema/type mismatch accepted")
	}
	if _, err := Encode("Name", string([]byte{0xff}), DefaultLimits()); err == nil {
		t.Fatal("invalid outbound UTF-8 repaired")
	}
	if _, err := Encode("PluginPayload", json.RawMessage(`"\ud800"`), DefaultLimits()); err == nil {
		t.Fatal("invalid outbound Plugin JSON accepted")
	}
	refusal := &http.Response{StatusCode: 409, Header: headers(), Body: io.NopCloser(strings.NewReader(`{"dataset_id":"` + fixtureDataset + `","error":{"code":"protocol_mismatch","message":"Exact version required","request_id":"` + fixtureRun + `","details":{"expected_protocol_version":"0.2.0","actual_protocol_version":"0.1.0"}}}`))}
	refusal.Header.Set("Atlas-Protocol-Version", "0.2.0")
	if _, err := ValidateResponse("GetAsset", refusal, ResponseContext{DatasetID: fixtureDataset}, DefaultLimits()); err != nil {
		t.Fatal("version mismatch refusal lost actual Core version", err)
	}
	commandSamples := map[string]json.RawMessage{}
	for _, c := range cases {
		if c.Name == "queued move" {
			commandSamples["move_to"] = c.Value
		}
		if c.Name == "pause" || c.Name == "resume" {
			commandSamples[c.Name] = c.Value
		}
	}
	for _, entry := range Catalog() {
		for command, raw := range commandSamples {
			err := ValidateJSON(entry.Schema, raw, DefaultLimits())
			if (err == nil) != (command == string(entry.Command)) {
				t.Fatal("Catalog schema does not select its command", entry.Command, command, err)
			}
		}
	}
	if Version() != "0.1.0" {
		t.Fatal("version drift")
	}
	catalog := Catalog()
	if len(catalog) != 3 || catalog[0].Command != "move_to" || catalog[1].Command != "pause" || catalog[2].Command != "resume" {
		t.Fatal("catalog drift")
	}
	catalog[0].Scheduling[0] = "invalid"
	if Catalog()[0].Scheduling[0] != "queued" {
		t.Fatal("mutable shared catalog")
	}
}
func TestLimitsAndStreaming(t *testing.T) {
	content := readFixture[struct {
		Descriptor UploadObjectDescriptor `json:"descriptor"`
		Object     Object                 `json:"object"`
		Hex        string                 `json:"hex"`
	}](t, "content.json")
	if err := CheckContent(content.Descriptor, strings.NewReader("abc"), DefaultLimits()); err != nil {
		t.Fatal(err)
	}
	for _, data := range []string{"ab", "abcd", "abd"} {
		if err := CheckContent(content.Descriptor, strings.NewReader(data), DefaultLimits()); err == nil {
			t.Fatal("invalid stream accepted", data)
		}
	}
	descriptor := content.Descriptor
	descriptor.ByteLength = "2000000001"
	if err := CheckContent(descriptor, strings.NewReader(""), DefaultLimits()); err == nil || !strings.Contains(err.Error(), "payload_too_large") {
		t.Fatal("2 GB admission not applied", err)
	}
	descriptor.ByteLength = "100000000"
	if err := CheckContent(descriptor, strings.NewReader(""), DefaultLimits()); err == nil || !strings.Contains(err.Error(), "integrity_fault") {
		t.Fatal("invented small file cap", err)
	}
	limits := DefaultLimits()
	limits.MaxJSONBytes = 8
	if err := ValidateJSON("PluginPayload", []byte(`"12345678"`), limits); err == nil {
		t.Fatal("raw byte cap bypassed")
	}
	limits = DefaultLimits()
	limits.MaxDepth = 2
	if err := ValidateJSON("PluginPayload", []byte(`[[[0]]]`), limits); err == nil {
		t.Fatal("depth cap bypassed")
	}
	limits = DefaultLimits()
	limits.MaxValues = 3
	if err := ValidateJSON("PluginPayload", []byte(`[0,0,0]`), limits); err == nil {
		t.Fatal("work cap bypassed")
	}
	response := &http.Response{StatusCode: 101, Header: headers(), Body: io.NopCloser(strings.NewReader(""))}
	response.Header.Set("Upgrade", "websocket")
	response.Header.Set("Connection", "Upgrade")
	response.Header.Set("Sec-WebSocket-Accept", "AAAAAAAAAAAAAAAAAAAAAAAAAAA=")
	if _, err := ValidateResponse("SubscribeChanges", response, ResponseContext{DatasetID: fixtureDataset, WebSocketKey: handshakeKey}, DefaultLimits()); err == nil {
		t.Fatal("incorrect WebSocket accept passed")
	}
}
func TestWebSocketFrames(t *testing.T) {
	frames := readFixture[[]struct {
		Schema string          `json:"schema"`
		Value  json.RawMessage `json:"value"`
	}](t, "frames.json")
	if len(frames) != 11 {
		t.Fatal("missing frame fixture")
	}
	for _, sample := range frames {
		var frame struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(sample.Value, &frame); err != nil {
			t.Fatal(err)
		}
		direction := "server"
		if sample.Schema == "AuthenticateFrame" || sample.Schema == "SubscribeChangesFrame" || sample.Schema == "ReleaseSnapshotFrame" {
			direction = "client"
		}
		ctx := FrameContext{fixtureDataset, fixtureRun, frame.Type != "authenticate", true}
		if err := ValidateFrame(direction, sample.Value, ctx, DefaultLimits()); err != nil {
			t.Fatal(sample.Schema, err)
		}
		if frame.Type == "release_snapshot" {
			ctx.Subscribed = false
			if err := ValidateFrame(direction, sample.Value, ctx, DefaultLimits()); err != nil {
				t.Fatal("release before subscription", err)
			}
		}
		if frame.Type != "error" {
			ctx.DatasetID = fixtureRun
			if err := ValidateFrame(direction, sample.Value, ctx, DefaultLimits()); err == nil {
				t.Fatal("wrong frame Dataset accepted")
			}
		}
		if frame.Type == "changes" {
			ctx.DatasetID = fixtureDataset
			ctx.Authenticated = false
			if err := ValidateFrame(direction, sample.Value, ctx, DefaultLimits()); err == nil {
				t.Fatal("data before authentication")
			}
		}
	}
}
func ExampleDecode() {
	point, err := Decode[Position]("Position", []byte(`{"latitude":0,"longitude":90}`), DefaultLimits())
	fmt.Println(point.Latitude, point.Longitude, err)
	// Output: 0 90 <nil>
}
