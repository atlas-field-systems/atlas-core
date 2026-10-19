package atlas

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestExactIntegerWorkflow(t *testing.T) {
	for _, token := range []string{"100", "100.0", "1e2", "1e+2", "1000e-1", "1.00e2"} {
		t.Run(token, func(t *testing.T) {
			wire := []byte(`{"page_size":` + token + `}`)
			if err := ValidateJSON("EntityListQuery", wire, DefaultLimits()); err != nil {
				t.Fatal(err)
			}
			value, err := Decode[EntityListQuery]("EntityListQuery", wire, DefaultLimits())
			if err != nil || value.PageSize == nil || *value.PageSize != 100 {
				t.Fatal("mathematical integer changed", value, err)
			}
			req, err := http.NewRequest("GET", "https://atlas.invalid/assets?page_size="+url.QueryEscape(token), nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header = headers()
			data, err := ValidateRequest("ListAssets", req, fixtureDataset, DefaultLimits())
			if err != nil {
				t.Fatal(err)
			}
			query, err := Decode[EntityListQuery]("EntityListQuery", data.Query, DefaultLimits())
			if err != nil || query.PageSize == nil || *query.PageSize != 100 {
				t.Fatal("checked query changed", query, err)
			}
		})
	}
	for _, token := range []string{"100.0000000000000000001", "1e-400", "0.1", "1001", "-0", "0e" + strings.Repeat("9", 1000), "1e1000000000"} {
		t.Run("refuse "+token, func(t *testing.T) {
			wire := []byte(`{"page_size":` + token + `}`)
			if err := ValidateJSON("EntityListQuery", wire, DefaultLimits()); err == nil {
				t.Fatal("invalid integer validated")
			}
			if _, err := Decode[EntityListQuery]("EntityListQuery", wire, DefaultLimits()); err == nil {
				t.Fatal("invalid integer decoded")
			}
			req, err := http.NewRequest("GET", "https://atlas.invalid/assets?page_size="+url.QueryEscape(token), nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header = headers()
			if _, err := ValidateRequest("ListAssets", req, fixtureDataset, DefaultLimits()); err == nil {
				t.Fatal("invalid integer query accepted")
			}
		})
	}
	for _, test := range []struct {
		token string
		want  int64
		valid bool
	}{
		{"0", 0, true}, {"-0", 0, true}, {"0e" + strings.Repeat("9", 10000), 0, true}, {"-0.00e-" + strings.Repeat("9", 10000), 0, true},
		{"9007199254740991", 9007199254740991, true}, {"9.007199254740991e15", 9007199254740991, true},
		{"9007199254740992", 0, false}, {"9007199254740993", 0, false}, {"1e20", 0, false}, {"1e1000000000", 0, false},
		{"1e-400", 0, false}, {"100.0000000000000000001", 0, false}, {"-1", 0, false},
	} {
		raw := []byte(`{"retry_after_seconds":` + test.token + `}`)
		validation := ValidateJSON("ErrorDetails", raw, DefaultLimits())
		value, err := Decode[ErrorDetails]("ErrorDetails", raw, DefaultLimits())
		if (validation == nil) != test.valid || (err == nil) != test.valid {
			t.Fatalf("retry %s: validation %v decode %v", test.token, validation, err)
		}
		if test.valid && (value.RetryAfterSeconds == nil || *value.RetryAfterSeconds != test.want) {
			t.Fatal("retry changed", value)
		}
	}
	challenge := `{"challenge_id":"` + fixtureDataset + `","request_id":"` + fixtureDataset + `","dataset_id":"` + fixtureDataset + `","asset_id":"` + fixtureDataset + `","process_generation":"` + fixtureDataset + `","core_run_id":"` + fixtureRun + `","issued_at":"2026-10-18T00:00:00Z","expires_at":"2026-10-18T00:00:10Z","expires_in_seconds":`
	for _, token := range []string{"10.0", "1e1"} {
		value, err := Decode[ContactChallenge]("ContactChallenge", []byte(challenge+token+`}`), DefaultLimits())
		if err != nil || value.ExpiresInSeconds != 10 {
			t.Fatal("integer enum notation", value, err)
		}
	}
	if err := ValidateJSON("ContactChallenge", []byte(challenge+`10.0000000000000000001}`), DefaultLimits()); err == nil {
		t.Fatal("hidden enum fraction accepted")
	}
	frame := []byte(`{"type":"error","dataset_id":"` + fixtureDataset + `","core_run_id":"` + fixtureRun + `","protocol_version":"0.1.0","response":{"error":{"code":"resource_limit","message":"busy","request_id":"` + fixtureRun + `","details":{"retry_after_seconds":1e2}}}}`)
	union, err := Decode[ServerFrame]("ServerFrame", frame, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	nested, err := union.AsSyncErrorFrame()
	if err != nil {
		t.Fatal("noncanonical integer survived outer union", err)
	}
	refusal, err := nested.Response.AsError429()
	if err != nil || refusal.Error.Details == nil || refusal.Error.Details.RetryAfterSeconds == nil || *refusal.Error.Details.RetryAfterSeconds != 100 {
		t.Fatal("nested union integer", refusal, err)
	}
}

func TestValidatedVariantWorkflow(t *testing.T) {
	evidence := SourceEvidence{EvidenceId: fixtureRun, Sequence: "1", CorrectionRevision: "0", EvidenceKind: "current"}
	evidence.GeneratedAt.SetNull()
	value := TelemetryValue{Classification: "dated_measurement", State: "value", Evidence: evidence}
	value.Value.ObservedAt.SetNull()
	value.Value.Altitude.SetNull()
	if _, err := Variant[TelemetrySection]("TelemetryValue", "TelemetrySection", value, DefaultLimits()); err == nil {
		t.Fatal("unset quantities became readings")
	}
	var unsafe TelemetrySection
	if err := unsafe.FromTelemetryValue(value); err != nil {
		t.Fatal(err)
	}
	report := AssetReport{Source: AssetSource{AssetId: fixtureDataset, Kind: "asset", ProcessGeneration: fixtureRun}, Sections: &AssetSections{Telemetry: &unsafe}}
	fabricated, err := Encode("AssetReport", report, DefaultLimits())
	if err != nil || !bytes.Contains(fabricated, []byte(`"position":{"latitude":0,"longitude":0}`)) || !bytes.Contains(fabricated, []byte(`"ground_speed":0`)) {
		t.Fatal("stock-constructor warning no longer reproduced", string(fabricated), err)
	}
	value.Value.Position.SetNull()
	value.Value.GroundSpeed.SetNull()
	for _, zero := range []bool{false, true} {
		if zero {
			value.Value.Position.Set(Position{Latitude: 0, Longitude: 0})
			value.Value.GroundSpeed.Set(0)
		}
		section, err := Variant[TelemetrySection]("TelemetryValue", "TelemetrySection", value, DefaultLimits())
		if err != nil {
			t.Fatal(err)
		}
		report.Sections.Telemetry = &section
		wire, err := Encode("AssetReport", report, DefaultLimits())
		if err != nil {
			t.Fatal(err)
		}
		decoded, err := Decode[AssetReport]("AssetReport", wire, DefaultLimits())
		if err != nil {
			t.Fatal(err)
		}
		reading, err := decoded.Sections.Telemetry.AsTelemetryValue()
		if err != nil {
			t.Fatal(err)
		}
		if reading.Value.Position.IsNull() == zero || reading.Value.GroundSpeed.IsNull() == zero || !reading.Value.Altitude.IsNull() {
			t.Fatal("null and zero were conflated")
		}
		if zero && (reading.Value.GroundSpeed.MustGet() != 0 || reading.Value.Position.MustGet() != (Position{Latitude: 0, Longitude: 0})) {
			t.Fatal("zero changed")
		}
	}
	if _, err := Variant[StatusSection]("TelemetryValue", "StatusSection", value, DefaultLimits()); err == nil {
		t.Fatal("wrong destination accepted")
	}
	if _, err := Variant[TelemetrySection]("StatusValue", "TelemetrySection", value, DefaultLimits()); err == nil {
		t.Fatal("wrong source type accepted")
	}
	if _, err := Variant[StatusSection]("TelemetryValue", "TelemetrySection", value, DefaultLimits()); err == nil {
		t.Fatal("wrong destination type accepted")
	}
}

func TestPluginNumericWorkflow(t *testing.T) {
	for _, token := range []string{"1", "42", "1.0", "-0", "1e-400", "9007199254740993", "12345678901234567890", "0.10000000000000001", "1.00000000000000001", "9.007199254740993e15", "1e308"} {
		t.Run(token, func(t *testing.T) {
			raw := []byte(token)
			root, err := Decode[PluginPayload]("PluginPayload", raw, DefaultLimits())
			if err != nil {
				t.Fatal(err)
			}
			out, err := Encode("PluginPayload", root, DefaultLimits())
			if err != nil || !bytes.Equal(out, raw) {
				t.Fatal("root token changed", string(out), err)
			}
			payload := `{ "10" : [` + token + `,42], "2": ` + token + `, "page_size": 100.0000000000000000001, "retry_after_seconds": 1e-400 }`
			create := []byte(`{"request_id":"` + fixtureRun + `","operation_id":"` + fixtureRun + `","plugin_id":"` + fixtureRun + `","release":"r1","capability":"probe","input":` + payload + `}`)
			request, err := Decode[CreateOperationRequest]("CreateOperationRequest", create, DefaultLimits())
			if err != nil {
				t.Fatal(err)
			}
			if string(request.Input.MustGet()) != payload {
				t.Fatal("Plugin source bytes changed during Decode")
			}
			encoded, err := Encode("CreateOperationRequest", request, DefaultLimits())
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Contains(encoded, []byte(`"10":[`+token+`,42]`)) || !bytes.Contains(encoded, []byte(`"2":`+token)) {
				t.Fatal("numeric keys moved tokens", string(encoded))
			}
			recovered := `{"state":"completed","observed_at":null,"object_ids":[],"output":` + payload + `,"known_effects":[` + token + `,null]}`
			recovery, err := Decode[RecoveredOutcome]("RecoveredOutcome", []byte(recovered), DefaultLimits())
			if err != nil {
				t.Fatal(err)
			}
			round, err := Encode("RecoveredOutcome", recovery, DefaultLimits())
			if err != nil || !bytes.Contains(round, []byte(`"known_effects":[`+token+`,null]`)) {
				t.Fatal("recovery token changed", string(round), err)
			}
			base := `{"id":"` + fixtureRun + `","version":"1","plugin_id":"` + fixtureRun + `","release":"r1","capability":"probe","input":` + payload + `,"state":"interrupted","object_ids":[],"recovered_outcome":` + recovered
			for _, tail := range []string{`}`, `,"known_effects":null}`, `,"output":` + payload + `,"known_effects":[` + token + `,null]}`} {
				operation, err := Decode[Operation]("Operation", []byte(base+tail), DefaultLimits())
				if err != nil {
					t.Fatal(err)
				}
				encoded, err := Encode("Operation", operation, DefaultLimits())
				if err != nil {
					t.Fatal(err)
				}
				again, err := Decode[Operation]("Operation", encoded, DefaultLimits())
				if err != nil {
					t.Fatal(err)
				}
				if operation.Output.IsSpecified() != again.Output.IsSpecified() || operation.KnownEffects.IsSpecified() != again.KnownEffects.IsSpecified() || operation.KnownEffects.IsNull() != again.KnownEffects.IsNull() {
					t.Fatal("omission and null changed")
				}
				if !bytes.Contains(encoded, []byte(`"2":`+token)) {
					t.Fatal("retained token changed", string(encoded))
				}
			}
		})
	}
}

func TestNumericBudgetsAndDoubleControls(t *testing.T) {
	for _, raw := range []string{`{"field":"📍","retry_after_seconds":1e15}`, `{"retry_after_seconds":1e15}`, `{"retry_after_seconds":1e15,"required_limits":{"max_changes":100.0,"max_batch_bytes":"1"}}`} {
		wantSize := len(raw) + 12
		if strings.Contains(raw, "100.0") {
			wantSize -= 2
		}
		for _, maxBytes := range []int{wantSize - 1, wantSize} {
			limits := DefaultLimits()
			limits.MaxJSONBytes = maxBytes
			err := ValidateJSON("ErrorDetails", []byte(raw), limits)
			_, decode := Decode[ErrorDetails]("ErrorDetails", []byte(raw), limits)
			if (err == nil) != (maxBytes == wantSize) || (decode == nil) != (maxBytes == wantSize) {
				t.Fatal("canonical size verdict", raw, maxBytes, err, decode)
			}
		}
	}
	for _, token := range []string{"0.1", "1e308"} {
		raw := []byte(`{"metres":` + token + `,"reference":"wgs84_ellipsoid"}`)
		value, err := Decode[Altitude]("Altitude", raw, DefaultLimits())
		if err != nil {
			t.Fatal("finite double refused", err)
		}
		if _, err := Encode("Altitude", value, DefaultLimits()); err != nil {
			t.Fatal(err)
		}
	}
	for _, raw := range [][]byte{[]byte(`1e309`), []byte(`{"x":1,"\u0078":2}`), []byte(`"\ud800"`), {0xff}, []byte(`1 2`)} {
		if err := ValidateJSON("PluginPayload", raw, DefaultLimits()); err == nil {
			t.Fatal("raw refusal lost", string(raw))
		}
	}
	for _, test := range []struct {
		raw           string
		depth, values int
		valid         bool
	}{
		{`[1,42]`, 1, 3, true}, {`[1,42]`, 1, 2, false}, {`[[1]]`, 1, 3, false}, {`[[1]]`, 2, 3, true},
		{`{"a":1,"b":42}`, 1, 5, true}, {`{"a":1,"b":42}`, 1, 4, false},
	} {
		limits := DefaultLimits()
		limits.MaxDepth = test.depth
		limits.MaxValues = test.values
		if err := ValidateJSON("PluginPayload", []byte(test.raw), limits); (err == nil) != test.valid {
			t.Fatal("numeric work limit", test, err)
		}
	}
	raw := []byte(`{"state":"completed","observed_at":null,"object_ids":[],"output":[1,42],"known_effects":[1,42]}`)
	value, err := Decode[RecoveredOutcome]("RecoveredOutcome", raw, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	limits := DefaultLimits()
	limits.MaxValues = 10
	if _, err := Encode("RecoveredOutcome", value, limits); err == nil {
		t.Fatal("aggregate Plugin work was reset")
	}
	literal := json.RawMessage(`{"rawJSON":"1"}`)
	valueRoot, err := Decode[PluginPayload]("PluginPayload", literal, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := Encode("PluginPayload", valueRoot, DefaultLimits())
	if err != nil || !bytes.Equal(encoded, literal) {
		t.Fatal("lookalike changed", string(encoded), err)
	}
}
