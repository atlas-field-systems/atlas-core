package plugins_test

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/atlas-field-systems/atlas-core/plugindispatch"
	"github.com/atlas-field-systems/atlas-core/plugins"
)

func TestOriginalResultSchemasSurviveCallerMutationAndRetainedOpen(t *testing.T) {
	for _, status := range []string{"completed", "failed"} {
		t.Run(status, func(t *testing.T) {
			f := newFixture(t, 1)
			// The caller reuses its buffer for the next release. Already opened
			// definitions and accepted Operations must retain their schema.
			schema := f.config.Capabilities[0].OutputSchema
			oldType, newType, mode := "integer", "boolean", "normal"
			if status == "failed" {
				schema = f.config.Capabilities[0].ErrorSchema
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
