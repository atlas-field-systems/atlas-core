package pluginruntime_test

import (
	"context"
	"encoding/json"
	"errors"
	goruntime "runtime"
	"sync"
	"testing"
	"time"

	"github.com/atlas-field-systems/atlas-core/plugindispatch"
	"github.com/atlas-field-systems/atlas-core/pluginruntime"
)

// Focused ownership/cleanup probes supplement the real-process workflows.
// Mutable Go values and an uncooperative callback are costly to arrange over
// the JSON process boundary, which naturally copies values.
func runtimeFixture(t *testing.T, execute pluginruntime.Execute) *pluginruntime.Runtime {
	t.Helper()
	contract, err := plugindispatch.Load("../../Atlas Protocol/plugin-dispatch.json")
	if err != nil {
		t.Fatal(err)
	}
	definition := plugindispatch.Capability{ID: "double", InputVersion: "1", InputSchema: json.RawMessage(`{"type":"object","required":["value"],"properties":{"value":{"type":"integer"}}}`), OutputSchema: json.RawMessage(`{"type":"object","required":["value"],"properties":{"value":{"type":"integer"}}}`)}
	runtime, err := pluginruntime.Open(pluginruntime.Config{Contract: contract, Binding: binding(), Token: "private-fixture-token", Release: release(), ConfigurationRevision: "1", WorkDirectory: t.TempDir(), ReceiptCapacity: 2, MaxEvidenceFiles: 2, MaxEvidenceBytes: 1024 * 1024, Capabilities: []pluginruntime.Capability{{Definition: definition, Execute: execute}}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := runtime.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	return runtime
}
func binding() plugindispatch.Binding {
	return plugindispatch.Binding{PluginID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", PrincipalID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", DatasetID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", CoreRunID: "run", RuntimeGeneration: "runtime"}
}
func release() plugindispatch.Release {
	return plugindispatch.Release{PackageID: "fixture", Version: "1.0.0", ImageDigest: "sha256:fixture"}
}
func dispatch() plugindispatch.Dispatch {
	input := json.RawMessage(`{"value":7}`)
	return plugindispatch.Dispatch{Binding: binding(), OperationID: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", Release: release(), CapabilityID: "double", InputVersion: "1", Input: input, InputDigest: plugindispatch.Digest(input)}
}

func TestReceiptAndEvidenceSnapshotsCannotRewriteRetainedFacts(t *testing.T) {
	started := make(chan struct{})
	runtime := runtimeFixture(t, func(ctx context.Context, invocation *pluginruntime.Invocation) (plugindispatch.Outcome, error) {
		close(started)
		<-ctx.Done()
		return plugindispatch.Outcome{}, ctx.Err()
	})
	original := dispatch()
	if duplicate, err := runtime.Accept(context.Background(), original); err != nil || duplicate {
		t.Fatal(duplicate, err)
	}
	<-started
	original.Input[9] = '9'
	ready := runtime.Ready(false)
	if string(ready.Receipts[0].Execution.Input) != `{"value":7}` {
		t.Fatal("caller mutated live receipt")
	}
	ready.Receipts[0].Execution.Input[9] = '8'
	if duplicate, err := runtime.Accept(context.Background(), dispatch()); err != nil || !duplicate {
		t.Fatal("snapshot mutated duplicate identity", duplicate, err)
	}
	outcome := &plugindispatch.Outcome{Status: "completed", Result: json.RawMessage(`{"value":14}`)}
	effects := []plugindispatch.Effect{{ID: "effect", Description: "saved effect"}}
	evidence, err := runtime.Record(dispatch().OperationID, pluginruntime.Update{Outcome: outcome, Effects: effects})
	if err != nil {
		t.Fatal(err)
	}
	outcome.Result[9] = '9'
	effects[0].ID = "changed"
	evidence.Outcome.Result[9] = '8'
	evidence.Execution.Input[9] = '6'
	evidence.Effects[0].ID = "mutated snapshot"
	retained := runtime.Retained()
	if string(retained[0].Outcome.Result) != `{"value":14}` || string(retained[0].Execution.Input) != `{"value":7}` || retained[0].Effects[0].ID != "effect" {
		t.Fatal(retained)
	}
	retained[0].Outcome.Result[9] = '0'
	if string(runtime.Retained()[0].Outcome.Result) != `{"value":14}` {
		t.Fatal("read snapshot mutated evidence")
	}
}

func TestIncompleteCloseRefusesNewWorkAndCanFinishAfterCallbackStops(t *testing.T) {
	releaseCallback := make(chan struct{})
	started := make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(releaseCallback) })
	runtime := runtimeFixture(t, func(context.Context, *pluginruntime.Invocation) (plugindispatch.Outcome, error) {
		close(started)
		<-releaseCallback
		return plugindispatch.Outcome{Status: "completed", Result: json.RawMessage(`{"value":14}`)}, nil
	})
	if _, err := runtime.Accept(context.Background(), dispatch()); err != nil {
		t.Fatal(err)
	}
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := runtime.Close(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("uncooperative worker incorrectly declared stopped", err)
	}
	before := goruntime.NumGoroutine()
	expired, expire := context.WithCancel(context.Background())
	expire()
	for range 64 {
		if err := runtime.Close(expired); !errors.Is(err, context.Canceled) {
			t.Fatal("incomplete repeated close lost its deadline", err)
		}
	}
	if growth := goruntime.NumGoroutine() - before; growth > 4 {
		t.Errorf("repeated incomplete close accumulated %d goroutines", growth)
	}
	fresh := dispatch()
	fresh.OperationID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
	if _, err := runtime.Accept(context.Background(), fresh); err == nil {
		t.Fatal("closed runtime accepted fresh work")
	}
	if err := runtime.Run(context.Background(), "unused"); err == nil {
		t.Fatal("closed runtime opened a session")
	}
	releaseOnce.Do(func() { close(releaseCallback) })
	ctx2, cancel2 := context.WithTimeout(context.Background(), time.Second)
	defer cancel2()
	if err := runtime.Close(ctx2); err != nil {
		t.Fatal(err)
	}
}

func TestTransientProgressKeepsNewerPendingRevisionAndNeverBecomesRetained(t *testing.T) {
	runtime := runtimeFixture(t, func(ctx context.Context, _ *pluginruntime.Invocation) (plugindispatch.Outcome, error) {
		<-ctx.Done()
		return plugindispatch.Outcome{}, ctx.Err()
	})
	if _, err := runtime.Accept(context.Background(), dispatch()); err != nil {
		t.Fatal(err)
	}
	original, err := runtime.Record(dispatch().OperationID, pluginruntime.Update{Progress: json.RawMessage(`{"percent":10}`)})
	if err != nil {
		t.Fatal(err)
	}
	newer, err := runtime.Record(dispatch().OperationID, pluginruntime.Update{Progress: json.RawMessage(`{"percent":20}`)})
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.Acknowledge(plugindispatch.Ack{OperationID: original.Execution.OperationID, Sequence: original.Sequence, Revision: original.Revision}); err != nil {
		t.Fatal(err)
	}
	pending := runtime.Pending()
	if len(pending) != 1 || pending[0].Sequence != newer.Sequence || string(pending[0].Progress) != `{"percent":20}` {
		t.Fatal(pending)
	}
	if len(runtime.Retained()) != 0 {
		t.Fatal("ordinary progress persisted as crash evidence")
	}
	if err := runtime.Acknowledge(plugindispatch.Ack{OperationID: newer.Execution.OperationID, Sequence: newer.Sequence, Revision: newer.Revision}); err != nil {
		t.Fatal(err)
	}
	if len(runtime.Pending()) != 0 {
		t.Fatal("exact progress ACK did not finish pending report")
	}
}
