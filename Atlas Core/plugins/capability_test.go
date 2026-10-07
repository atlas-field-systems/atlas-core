package plugins_test

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/atlas-field-systems/atlas-core/plugindispatch"
	"github.com/atlas-field-systems/atlas-core/pluginruntime"
	"github.com/atlas-field-systems/atlas-core/plugins"
)

// This narrow registry probe runs the production channel with real storage.
// Distinct input/output schemas make accidental capability aliasing observable.
func TestCapabilityIDAndInputVersionRemainSeparate(t *testing.T) {
	contract, err := plugindispatch.Load("../../Atlas Protocol/plugin-dispatch.json")
	if err != nil {
		t.Fatal(err)
	}
	definitions := []plugindispatch.Capability{
		{ID: "a/b", InputVersion: "c", InputSchema: json.RawMessage(`{"const":1}`), OutputSchema: json.RawMessage("{\n\"const\":11,\n\"description\":\"<\"\n}")},
		{ID: "a", InputVersion: "b/c", InputSchema: json.RawMessage(`{"const":2}`), OutputSchema: json.RawMessage(`{"const":22}`)},
	}
	root := t.TempDir()
	core, err := plugins.Open(context.Background(), plugins.Config{DatabasePath: filepath.Join(root, "core.sqlite"), DatasetID: datasetID, CoreRunID: "run", CoreRelease: "fixture", Contract: contract, Releases: []plugins.PluginRelease{{PluginID: pluginID, Release: plugindispatch.Release{PackageID: "fixture", Version: "1.0.0", ImageDigest: "sha256:fixture"}, Capabilities: definitions}}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := core.Close(); err != nil {
			t.Error(err)
		}
	})
	socket := filepath.Join(root, "private.sock")
	server, err := core.Listen(socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := server.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	host := plugins.RuntimeBinding{Binding: plugindispatch.Binding{PluginID: pluginID, PrincipalID: principalID, DatasetID: datasetID, CoreRunID: "run", RuntimeGeneration: "runtime"}, Token: "private-capability-token", VerifiedProcess: "verified-fixture-process", ReceiptCapacity: 2, Release: plugindispatch.Release{PackageID: "fixture", Version: "1.0.0", ImageDigest: "sha256:fixture"}, ConfigurationRevision: "1", Capabilities: []plugindispatch.CapabilityIdentity{{ID: "a/b", InputVersion: "c"}, {ID: "a", InputVersion: "b/c"}}}
	if err := core.BindRuntime(context.Background(), host); err != nil {
		t.Fatal(err)
	}
	runtime, err := pluginruntime.Open(pluginruntime.Config{Contract: contract, Binding: host.Binding, Token: host.Token, Release: host.Release, ConfigurationRevision: host.ConfigurationRevision, WorkDirectory: filepath.Join(root, "evidence"), ReceiptCapacity: 2, MaxEvidenceFiles: 2, MaxEvidenceBytes: 1024 * 1024, Capabilities: []pluginruntime.Capability{
		{Definition: definitions[0], Execute: func(context.Context, *pluginruntime.Invocation) (plugindispatch.Outcome, error) {
			return plugindispatch.Outcome{Status: "completed", Result: json.RawMessage(`11`)}, nil
		}},
		{Definition: definitions[1], Execute: func(context.Context, *pluginruntime.Invocation) (plugindispatch.Outcome, error) {
			return plugindispatch.Outcome{Status: "completed", Result: json.RawMessage(`22`)}, nil
		}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	sessionDone := make(chan struct{})
	var sessionError error
	go func() {
		sessionError = runtime.Run(context.Background(), socket)
		close(sessionDone)
	}()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := runtime.Close(ctx); err != nil {
			t.Error(err)
		}
		select {
		case <-sessionDone:
		case <-ctx.Done():
			t.Error("runtime session did not join")
		}
	})
	deadline := time.Now().Add(3 * time.Second)
	for !core.Available(pluginID) {
		select {
		case <-sessionDone:
			t.Fatal("runtime session ended before readiness", sessionError)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("runtime never became ready")
		}
		time.Sleep(time.Millisecond)
	}
	for _, test := range []struct {
		id, version, input, output string
	}{{"a/b", "c", "1", "11"}, {"a", "b/c", "2", "22"}} {
		operation, err := core.Submit(context.Background(), plugins.Submission{DatasetID: datasetID, PluginID: pluginID, RequestID: test.id, CallerID: "caller", CapabilityID: test.id, InputVersion: test.version, Input: json.RawMessage(test.input)})
		if err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(3 * time.Second)
		for {
			select {
			case <-sessionDone:
				t.Fatal("runtime session ended before completion", sessionError)
			default:
			}
			operation, err = core.Read(context.Background(), datasetID, pluginID, operation.ID)
			if err != nil {
				t.Fatal(err)
			}
			if operation.Status == plugins.Completed {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("operation did not finish", operation)
			}
			time.Sleep(time.Millisecond)
		}
		if operation.Execution.CapabilityID != test.id || operation.Execution.InputVersion != test.version || string(operation.Outcome.Result) != test.output {
			t.Fatal("capability pair resolved to another definition", operation)
		}
	}
}
