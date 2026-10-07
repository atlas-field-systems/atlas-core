package plugins_test

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/atlas-field-systems/atlas-core/plugindispatch"
	"github.com/atlas-field-systems/atlas-core/plugins"
)

func TestLocalCapabilityBundleReferencesValidateThroughThePluginProcess(t *testing.T) {
	definition := plugindispatch.Capability{ID: "double", InputVersion: "1", InputSchemaPath: "schemas/input.json", OutputSchemaPath: "schemas/output.json", InputSchema: json.RawMessage(`{"$ref":"../common.json#/$defs/input"}`), OutputSchema: json.RawMessage(`{"$ref":"../common.json#/$defs/output"}`), SchemaResources: map[string]json.RawMessage{"common.json": json.RawMessage(`{"$defs":{"input":{"type":"object","required":["value"],"properties":{"value":{"type":"integer"}}},"output":{"type":"object","required":["value"],"properties":{"value":{"const":14}}}}}`)}}
	definition.SchemaResources[definition.InputSchemaPath] = bytes.Clone(definition.InputSchema)
	definition.SchemaResources[definition.OutputSchemaPath] = bytes.Clone(definition.OutputSchema)
	f := newFixtureConfigured(t, 1, func(cfg *plugins.Config) {
		cfg.Releases[0].Capabilities = []plugindispatch.Capability{definition}
		second := plugindispatch.CloneCapability(definition)
		second.SchemaResources["common.json"] = bytes.ReplaceAll(second.SchemaResources["common.json"], []byte("14"), []byte("16"))
		registration := cfg.Releases[0]
		registration.Release.Version = "2.0.0"
		registration.Release.ImageDigest = "sha256:fixture-2"
		registration.Capabilities = []plugindispatch.Capability{second}
		cfg.Releases = append(cfg.Releases, registration)
	})
	f.definition = &definition
	child := f.start(t, "normal")
	child.event(t, "ready")
	// Reusing the installer's buffers must not change Core or Runtime's
	// already compiled, original capability context.
	resource := definition.SchemaResources["common.json"]
	copy(resource[bytes.Index(resource, []byte("14")):], "99")
	if _, err := f.core.Submit(context.Background(), request("invalid-bundle-input", `{"value":"invalid"}`)); err == nil {
		t.Fatal("local input reference was not validated")
	}
	operation, err := f.core.Submit(context.Background(), request("local-bundle", `{"value":7}`))
	if err != nil {
		t.Fatal(err)
	}
	child.command(t, "next")
	child.event(t, "received")
	child.command(t, "report")
	child.event(t, "acknowledged")
	completed := f.wait(t, operation.ID, plugins.Completed)
	if string(completed.Outcome.Result) != `{"value":14}` {
		t.Fatal("local output reference lost its constraint", completed)
	}
	assertEffects(t, f, 1)
	child.kill(t)
	if err := f.core.ConfirmLoss(context.Background(), f.binding.Binding); err != nil {
		t.Fatal(err)
	}
	f.binding.Release = f.config.Releases[1].Release
	f.definition = &f.config.Releases[1].Capabilities[0]
	f.replace(t, "runtime-2")
	replacement := f.start(t, "normal")
	replacement.event(t, "ready")
	newOperation, err := f.core.Submit(context.Background(), request("second-bundle", `{"value":8}`))
	if err != nil {
		t.Fatal(err)
	}
	replacement.command(t, "next")
	replacement.event(t, "received")
	replacement.command(t, "report")
	replacement.event(t, "acknowledged")
	if second := f.wait(t, newOperation.ID, plugins.Completed); string(second.Outcome.Result) != `{"value":16}` {
		t.Fatal("identical root schemas shared the wrong bundle context", second)
	}
	assertEffects(t, f, 2)
	replacement.kill(t)
	shutdown, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := f.server.Close(shutdown); err != nil {
		t.Fatal(err)
	}
	if err := f.core.Close(); err != nil {
		t.Fatal(err)
	}
	f.config.Releases = nil
	f.config.CoreRunID = "run-2"
	f.core, err = plugins.Open(context.Background(), f.config)
	if err != nil {
		t.Fatal("original bundle context was not retained after release removal", err)
	}
	completed = f.wait(t, operation.ID, plugins.Completed)
	if string(completed.Outcome.Result) != `{"value":14}` {
		t.Fatal("release removal changed the original result", completed)
	}
	if second := f.wait(t, newOperation.ID, plugins.Completed); string(second.Outcome.Result) != `{"value":16}` {
		t.Fatal("release removal changed the second result", second)
	}
}

func TestCapabilityWithoutErrorSchemaCanFailAndDrain(t *testing.T) {
	f := newFixtureConfigured(t, 1, func(cfg *plugins.Config) {
		cfg.Releases[0].Capabilities[0].ErrorSchema = nil
	})
	definition := plugindispatch.CloneCapability(f.config.Releases[0].Capabilities[0])
	f.definition = &definition
	child := f.start(t, "hold-failed")
	child.event(t, "ready")
	operation, err := f.core.Submit(context.Background(), request("failure-without-schema", `{"value":7}`))
	if err != nil {
		t.Fatal(err)
	}
	child.command(t, "next")
	child.event(t, "received")
	child.event(t, "started")
	for _, invalid := range []struct{ errorJSON, resultJSON, expected string }{
		{"", "", "invalid_outcome"},
		{`{"code":"failure"}`, `{}`, "invalid_outcome"},
		{`{"code":"first","code":"second"}`, "", "invalid_json"},
		{`"` + strings.Repeat("x", f.contract.Limits.ResultBytes) + `"`, "", "resource_limit"},
	} {
		update := struct{ Outcome *plugindispatch.Outcome }{&plugindispatch.Outcome{Status: "failed", Error: json.RawMessage(invalid.errorJSON), Result: json.RawMessage(invalid.resultJSON)}}
		child.command(t, "record-update "+mustJSON(t, update))
		if event := child.event(t, "error"); event.Error != invalid.expected {
			t.Fatal("failure fallback bypassed payload validation", event)
		}
	}
	if err := f.core.Drain(f.binding.Binding); err != nil {
		t.Fatal(err)
	}
	child.command(t, "release")
	child.event(t, "released")
	child.command(t, "report")
	child.event(t, "acknowledged")
	failed := f.wait(t, operation.ID, plugins.Failed)
	if failed.Outcome == nil || string(failed.Outcome.Error) != `{"code":"fixture_failure"}` {
		t.Fatal("manifest-compliant capability did not report its failure", failed)
	}
	child.command(t, "drained")
	child.event(t, "drained")
	if drained, err := f.core.Drained(f.binding.Binding); err != nil || !drained {
		t.Fatal("definitive failure did not permit protected drain", err)
	}
	assertEffects(t, f, 0)
}

func TestOriginalResultSchemasSurviveCallerMutationAndRetainedOpen(t *testing.T) {
	for _, status := range []string{"completed", "failed"} {
		t.Run(status, func(t *testing.T) {
			f := newFixture(t, 1)
			// The caller reuses its buffer for the next release. Already opened
			// definitions and accepted Operations must retain their schema.
			schema := f.config.Releases[0].Capabilities[0].OutputSchema
			oldType, newType, mode := "integer", "boolean", "normal"
			if status == "failed" {
				schema = f.config.Releases[0].Capabilities[0].ErrorSchema
				oldType, newType, mode = "string", "number", "hold"
			}
			index := bytes.Index(schema, []byte(oldType))
			if index < 0 {
				t.Fatal("fixture schema has no original type")
			}
			copy(schema[index:], newType)
			child := f.start(t, mode)
			child.event(t, "ready")
			operation, err := f.core.Submit(context.Background(), request("original-schema", `{"value":7}`))
			if err != nil {
				t.Fatal(err)
			}
			child.command(t, "next")
			child.event(t, "received")
			var failure *plugindispatch.Evidence
			if status == "completed" {
				child.command(t, "saved")
				child.event(t, "saved")
			} else {
				// Deliver this old execution's typed failure through the new
				// reporting envelope after retained opening, using its real receipt.
				failure = &plugindispatch.Evidence{Execution: operation.Execution, Sequence: "1", Outcome: &plugindispatch.Outcome{Status: "failed", Error: json.RawMessage(`{"code":"original_failure"}`)}}
				failure.Revision = plugindispatch.Revision(*failure)
			}
			child.kill(t)
			shutdown, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if err := f.server.Close(shutdown); err != nil {
				t.Fatal(err)
			}
			if err := f.core.Close(); err != nil {
				t.Fatal(err)
			}
			f.config.CoreRunID = "run-2"
			f.config.Releases[0].Release.Version = "2.0.0"
			f.config.Releases[0].Release.ImageDigest = "sha256:fixture-2"
			core, err := plugins.Open(context.Background(), f.config)
			if err != nil {
				t.Fatal(err)
			}
			f.core = core
			server, err := f.core.Listen(f.socket)
			if err != nil {
				t.Fatal(err)
			}
			f.server = server
			f.binding.Binding.CoreRunID = "run-2"
			f.binding.Release.Version = "2.0.0"
			f.binding.Release.ImageDigest = "sha256:fixture-2"
			f.replace(t, "runtime-2")
			replacement := f.start(t, "normal")
			replacement.event(t, "ready")
			if failure != nil {
				replacement.command(t, "report-evidence "+mustJSON(t, failure))
				replacement.event(t, "reported_evidence")
			}
			recovered := f.wait(t, operation.ID, plugins.Interrupted)
			if recovered.RecoveredOutcome == nil || recovered.RecoveredOutcome.Status != status || recovered.Execution.Release.Version != "1.0.0" {
				t.Fatal("current release replaced original result authority", recovered)
			}
			if status == "completed" {
				if string(recovered.RecoveredOutcome.Result) != `{"value":14}` {
					t.Fatal(recovered)
				}
				assertEffects(t, f, 1)
			} else {
				if string(recovered.RecoveredOutcome.Error) != `{"code":"original_failure"}` {
					t.Fatal(recovered)
				}
				assertEffects(t, f, 0)
			}
		})
	}
}
