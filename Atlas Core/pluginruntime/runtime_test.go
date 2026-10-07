package pluginruntime_test

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"sync"
	"testing"
	"time"

	"github.com/atlas-field-systems/atlas-core/plugindispatch"
	"github.com/atlas-field-systems/atlas-core/pluginruntime"
	"golang.org/x/sys/unix"
)

// Focused ownership/cleanup probes supplement the real-process workflows.
// Mutable Go values and an uncooperative callback are costly to arrange over
// the JSON process boundary, which naturally copies values.
func runtimeFixture(t *testing.T, execute pluginruntime.Execute) *pluginruntime.Runtime {
	t.Helper()
	return openRuntimeFixture(t, runtimeConfiguration(t, execute))
}

func runtimeConfiguration(t *testing.T, execute pluginruntime.Execute) pluginruntime.Config {
	t.Helper()
	contract, err := plugindispatch.Load("../../Atlas Protocol/plugin-dispatch.json")
	if err != nil {
		t.Fatal(err)
	}
	definition := plugindispatch.Capability{ID: "double", InputVersion: "1", InputSchema: json.RawMessage(`{"type":"object","required":["value"],"properties":{"value":{"type":"integer"}}}`), OutputSchema: json.RawMessage(`{"type":"object","required":["value"],"properties":{"value":{"type":"integer"}}}`)}
	return pluginruntime.Config{Contract: contract, Binding: binding(), Token: "private-fixture-token", Release: release(), ConfigurationRevision: "1", WorkDirectory: t.TempDir(), ReceiptCapacity: 2, MaxEvidenceFiles: 2, MaxEvidenceBytes: 1024 * 1024, Capabilities: []pluginruntime.Capability{{Definition: definition, Execute: execute}}}
}

func openRuntimeFixture(t *testing.T, cfg pluginruntime.Config) *pluginruntime.Runtime {
	t.Helper()
	runtime, err := pluginruntime.Open(cfg)
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

func TestConflictingEffectsInOneUpdateDoNotCommit(t *testing.T) {
	cfg := runtimeConfiguration(t, func(ctx context.Context, _ *pluginruntime.Invocation) (plugindispatch.Outcome, error) {
		<-ctx.Done()
		return plugindispatch.Outcome{}, ctx.Err()
	})
	runtime := openRuntimeFixture(t, cfg)
	if _, err := runtime.Accept(context.Background(), dispatch()); err != nil {
		t.Fatal(err)
	}
	_, err := runtime.Record(dispatch().OperationID, pluginruntime.Update{
		Effects: []plugindispatch.Effect{{ID: "effect", Description: "original description"}, {ID: "effect", Description: "changed description"}},
		Outcome: &plugindispatch.Outcome{Status: "completed", Result: json.RawMessage(`{"value":14}`)},
	})
	if err == nil || err.Error() != "effect_conflict" {
		t.Fatal("conflicting effects were accepted", err)
	}
	if len(runtime.Pending()) != 0 || len(runtime.Retained()) != 0 {
		t.Fatal("conflicting update changed pending or retained evidence")
	}
	progress, err := runtime.Record(dispatch().OperationID, pluginruntime.Update{Progress: json.RawMessage(`{"percent":50}`)})
	if err != nil || progress.Sequence != "1" || len(progress.Effects) != 0 || progress.Outcome != nil {
		t.Fatal("rejected update changed the live receipt", progress, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := runtime.Close(ctx); err != nil {
		t.Fatal(err)
	}
	replacement := openRuntimeFixture(t, cfg)
	if len(replacement.Retained()) != 0 {
		t.Fatal("rejected update persisted private evidence")
	}
}

func TestIdenticalEffectsInOneUpdatePersistOnce(t *testing.T) {
	cfg := runtimeConfiguration(t, func(ctx context.Context, _ *pluginruntime.Invocation) (plugindispatch.Outcome, error) {
		<-ctx.Done()
		return plugindispatch.Outcome{}, ctx.Err()
	})
	runtime := openRuntimeFixture(t, cfg)
	if _, err := runtime.Accept(context.Background(), dispatch()); err != nil {
		t.Fatal(err)
	}
	effect := plugindispatch.Effect{ID: "effect", Description: "saved effect"}
	saved, err := runtime.Record(dispatch().OperationID, pluginruntime.Update{Effects: []plugindispatch.Effect{effect, effect}})
	if err != nil || len(saved.Effects) != 1 || saved.Effects[0] != effect {
		t.Fatal("identical effect identities did not deduplicate", saved, err)
	}
	completed, err := runtime.Record(dispatch().OperationID, pluginruntime.Update{Outcome: &plugindispatch.Outcome{Status: "completed", Result: json.RawMessage(`{"value":14}`)}})
	if err != nil || len(completed.Effects) != 1 || completed.Effects[0] != effect || completed.Sequence != "2" {
		t.Fatal("live receipt did not retain one effect", completed, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := runtime.Close(ctx); err != nil {
		t.Fatal(err)
	}
	replacement := openRuntimeFixture(t, cfg)
	retained := replacement.Retained()
	if len(retained) != 1 || len(retained[0].Effects) != 1 || retained[0].Effects[0] != effect || retained[0].Outcome == nil || retained[0].Outcome.Status != "completed" {
		t.Fatal("identical effect identities did not retain one durable effect", retained)
	}
}

func TestRuntimeValidatesLocalCapabilitySchemas(t *testing.T) {
	cfg := runtimeConfiguration(t, func(ctx context.Context, _ *pluginruntime.Invocation) (plugindispatch.Outcome, error) {
		<-ctx.Done()
		return plugindispatch.Outcome{}, ctx.Err()
	})
	definition := &cfg.Capabilities[0].Definition
	definition.InputSchemaPath, definition.OutputSchemaPath, definition.ErrorSchemaPath = "schemas/input.json", "schemas/output.json", "schemas/failure.json"
	definition.InputSchema = json.RawMessage(`{"$ref":"../values.json#/$defs/input"}`)
	definition.OutputSchema = json.RawMessage(`{"$ref":"../values.json#/$defs/output"}`)
	definition.ErrorSchema = json.RawMessage(`{"$ref":"../values.json#/$defs/failure"}`)
	definition.SchemaResources = map[string]json.RawMessage{"values.json": json.RawMessage(`{"$defs":{"input":{"const":{"value":7}},"output":{"const":{"value":14}},"failure":{"const":{"reason":"fixture failure"}}}}`)}
	runtime := openRuntimeFixture(t, cfg)
	// Caller mutations cannot replace the original release's compiled schemas.
	definition.SchemaResources["values.json"] = json.RawMessage(`{"$defs":{"input":{"const":{"value":8}},"output":{"const":{"value":16}},"failure":{"const":{"reason":"changed failure"}}}}`)
	invalid := dispatch()
	invalid.Input = json.RawMessage(`{"value":8}`)
	invalid.InputDigest = plugindispatch.Digest(invalid.Input)
	if _, err := runtime.Accept(context.Background(), invalid); err == nil {
		t.Fatal("input bypassed the original local bundle schema")
	}
	if _, err := runtime.Accept(context.Background(), dispatch()); err != nil {
		t.Fatal("local bundle input was rejected", err)
	}
	if _, err := runtime.Record(dispatch().OperationID, pluginruntime.Update{Outcome: &plugindispatch.Outcome{Status: "completed", Result: json.RawMessage(`{"value":16}`)}}); err == nil {
		t.Fatal("result bypassed the original local bundle schema")
	}
	completed, err := runtime.Record(dispatch().OperationID, pluginruntime.Update{Outcome: &plugindispatch.Outcome{Status: "completed", Result: json.RawMessage(`{"value":14}`)}})
	if err != nil || completed.Sequence != "1" || completed.Outcome == nil || string(completed.Outcome.Result) != `{"value":14}` {
		t.Fatal("local bundle result was rejected", completed, err)
	}
	failed := dispatch()
	failed.OperationID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
	if _, err := runtime.Accept(context.Background(), failed); err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.Record(failed.OperationID, pluginruntime.Update{Outcome: &plugindispatch.Outcome{Status: "failed", Error: json.RawMessage(`{"reason":"changed failure"}`)}}); err == nil {
		t.Fatal("failure bypassed the original local bundle schema")
	}
	evidence, err := runtime.Record(failed.OperationID, pluginruntime.Update{Outcome: &plugindispatch.Outcome{Status: "failed", Error: json.RawMessage(`{"reason":"fixture failure"}`)}})
	if err != nil || evidence.Sequence != "1" || evidence.Outcome == nil || string(evidence.Outcome.Error) != `{"reason":"fixture failure"}` || len(runtime.Retained()) != 2 {
		t.Fatal("local bundle failure was rejected", evidence, err)
	}
}

// A malformed retained file needs the real filesystem boundary. Run Open in a
// subprocess so a FIFO read that blocks is killed and reaped before cleanup.
func TestRetainedEvidenceFIFORefusesReadiness(t *testing.T) {
	if args := flag.Args(); len(args) == 1 {
		cfg := runtimeConfiguration(t, func(context.Context, *pluginruntime.Invocation) (plugindispatch.Outcome, error) {
			return plugindispatch.Outcome{}, errors.New("unexpected execution")
		})
		cfg.WorkDirectory = args[0]
		runtime, err := pluginruntime.Open(cfg)
		if runtime != nil {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if err := runtime.Close(ctx); err != nil {
				t.Error(err)
			}
		}
		if err == nil || err.Error() != "incompatible_retained_evidence" {
			t.Fatal("non-regular evidence file did not fault readiness", err)
		}
		return
	}
	directory := t.TempDir()
	if err := unix.Mkfifo(filepath.Join(directory, dispatch().OperationID+".evidence.json"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	child := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestRetainedEvidenceFIFORefusesReadiness$", "--", directory)
	output, err := child.CombinedOutput()
	if ctx.Err() != nil {
		t.Fatal("retained FIFO blocked readiness instead of refusing it", ctx.Err())
	}
	if err != nil {
		t.Fatalf("retained FIFO probe failed: %v\n%s", err, output)
	}
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
	if ready.ReceiptCapacity != 2 {
		t.Fatal("readiness did not advertise the configured receipt capacity", ready.ReceiptCapacity)
	}
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

func TestCloseCancelsAndJoinsIngestionWithBoundedRetry(t *testing.T) {
	joined := make(chan struct{})
	cancelled := make(chan struct{})
	var joinOnce sync.Once
	defer joinOnce.Do(func() { close(joined) })
	cfg := runtimeConfiguration(t, func(context.Context, *pluginruntime.Invocation) (plugindispatch.Outcome, error) {
		return plugindispatch.Outcome{}, errors.New("unexpected execution")
	})
	cfg.StopIngestion = func(ctx context.Context) error {
		<-ctx.Done()
		close(cancelled)
		// Cancelling the source is not yet confirmation that its writer joined.
		<-joined
		return nil
	}
	runtime := openRuntimeFixture(t, cfg)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := runtime.Close(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("ingestion writer incorrectly declared joined", err)
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("Close did not cancel the ingestion owner")
	}
	if _, err := os.Stat(cfg.WorkDirectory); err != nil {
		t.Fatal("incomplete shutdown lost working storage", err)
	}
	joinOnce.Do(func() { close(joined) })
	shutdown, stop := context.WithTimeout(context.Background(), time.Second)
	defer stop()
	if err := runtime.Close(shutdown); err != nil {
		t.Fatal("confirmed ingestion join did not complete shutdown", err)
	}
}

func TestClosePreservesFailedIngestionStop(t *testing.T) {
	stopFailure := errors.New("ingestion writers not joined")
	cfg := runtimeConfiguration(t, func(context.Context, *pluginruntime.Invocation) (plugindispatch.Outcome, error) {
		return plugindispatch.Outcome{}, errors.New("unexpected execution")
	})
	cfg.StopIngestion = func(context.Context) error { return stopFailure }
	runtime, err := pluginruntime.Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	shutdown, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	for range 2 {
		if err := runtime.Close(shutdown); !errors.Is(err, stopFailure) {
			t.Fatal("callback exit claimed ingestion writers were stopped", err)
		}
	}
	select {
	case err := <-runtime.Faults():
		if !errors.Is(err, stopFailure) {
			t.Fatal("ingestion failure notification lost its cause", err)
		}
	default:
		t.Fatal("ingestion failure did not notify its owner")
	}
}

func TestClosePreservesWorkerAndIngestionFailures(t *testing.T) {
	workerFailure := errors.New("capability failed before shutdown")
	stopFailure := errors.New("ingestion writers not joined")
	cfg := runtimeConfiguration(t, func(context.Context, *pluginruntime.Invocation) (plugindispatch.Outcome, error) {
		return plugindispatch.Outcome{}, workerFailure
	})
	cfg.StopIngestion = func(context.Context) error { return stopFailure }
	runtime, err := pluginruntime.Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	shutdown, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	defer runtime.Close(shutdown)
	if _, err := runtime.Accept(context.Background(), dispatch()); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-runtime.Faults():
		if !errors.Is(err, workerFailure) {
			t.Fatal("first capability failure was lost", err)
		}
	case <-shutdown.Done():
		t.Fatal("capability did not report its failure")
	}
	for range 2 {
		if err := runtime.Close(shutdown); !errors.Is(err, workerFailure) || !errors.Is(err, stopFailure) {
			t.Fatal("shutdown lost a primary or ingestion cleanup failure", err)
		}
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

// The private channel and worker are real. Holding the dispatch acknowledgement
// makes the external Faults observer the only reader at the failure boundary.
// A process fixture cannot deterministically choose between two Go readers.
func TestFaultObserverCannotConsumeSessionFailure(t *testing.T) {
	workerFailure := errors.New("fixture worker failed")
	failWorker := make(chan struct{})
	runtime := runtimeFixture(t, func(ctx context.Context, _ *pluginruntime.Invocation) (plugindispatch.Outcome, error) {
		select {
		case <-failWorker:
			return plugindispatch.Outcome{}, workerFailure
		case <-ctx.Done():
			return plugindispatch.Outcome{}, ctx.Err()
		}
	})
	contract, err := plugindispatch.Load("../../Atlas Protocol/plugin-dispatch.json")
	if err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(t.TempDir(), "private.sock")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	acknowledged := make(chan struct{})
	peerDone := make(chan struct{})
	var peerError error
	go func() {
		defer close(peerDone)
		connection, err := listener.AcceptUnix()
		if err != nil {
			peerError = err
			return
		}
		defer connection.Close()
		deadline, _ := ctx.Deadline()
		if err := connection.SetDeadline(deadline); err != nil {
			peerError = err
			return
		}
		for {
			var request plugindispatch.Request
			if err := contract.Receive(connection, &request); err != nil {
				peerError = err
				return
			}
			if request.Kind != "ready" || request.Ready == nil {
				peerError = errors.New("runtime skipped readiness")
				return
			}
			if err := contract.Send(connection, plugindispatch.Response{Kind: "ready"}); err != nil {
				peerError = err
				return
			}
			if request.Ready.Complete {
				break
			}
		}
		var request plugindispatch.Request
		if err := contract.Receive(connection, &request); err != nil {
			peerError = err
			return
		}
		if request.Kind != "next" {
			peerError = errors.New("runtime did not request dispatch")
			return
		}
		execution := dispatch()
		if err := contract.Send(connection, plugindispatch.Response{Kind: "dispatch", Dispatch: &execution}); err != nil {
			peerError = err
			return
		}
		if err := contract.Receive(connection, &request); err != nil {
			peerError = err
			return
		}
		if request.Kind != "dispatch_ack" {
			peerError = errors.New("runtime did not acknowledge dispatch")
			return
		}
		close(acknowledged)
		// Hold the reply while checking that the runtime closes its owned socket.
		var next plugindispatch.Request
		if err := contract.Receive(connection, &next); !errors.Is(err, io.EOF) {
			peerError = fmt.Errorf("faulted runtime did not close its channel: %w", err)
		}
	}()
	runDone := make(chan struct{})
	var runError error
	go func() {
		runError = runtime.Run(ctx, socket)
		close(runDone)
	}()
	t.Cleanup(func() {
		cancel()
		if err := listener.Close(); err != nil {
			t.Error(err)
		}
		select {
		case <-runDone:
		case <-time.After(time.Second):
			t.Error("runtime session did not join")
		}
		select {
		case <-peerDone:
		case <-time.After(3 * time.Second):
			t.Error("private channel peer did not join")
		}
	})
	select {
	case <-acknowledged:
	case <-peerDone:
		t.Fatal("private channel peer failed before dispatch", peerError)
	case <-ctx.Done():
		t.Fatal("runtime did not acknowledge dispatch", ctx.Err())
	}
	close(failWorker)
	select {
	case observed := <-runtime.Faults():
		if !errors.Is(observed, workerFailure) {
			t.Fatal("observer lost worker failure cause", observed)
		}
	case <-ctx.Done():
		t.Fatal("worker fault was not observable", ctx.Err())
	}
	select {
	case <-runDone:
		if !errors.Is(runError, workerFailure) {
			t.Fatal("session lost observed worker failure", runError)
		}
	case <-time.After(time.Second):
		t.Fatal("observing the worker fault left the runtime session open")
	}
	select {
	case <-peerDone:
		if peerError != nil {
			t.Fatal(peerError)
		}
	case <-ctx.Done():
		t.Fatal("faulted runtime did not close its private channel", ctx.Err())
	}
	if len(runtime.Retained()) != 0 || len(runtime.Pending()) != 0 {
		t.Fatal("worker failure fabricated outcome evidence")
	}
	if err := runtime.Run(context.Background(), socket); !errors.Is(err, workerFailure) {
		t.Fatal("reconnection forgot the observed worker failure", err)
	}
}

func TestObservedWorkerFailurePreservesOtherAcceptedWorkUntilClose(t *testing.T) {
	workerFailure := errors.New("fixture worker failed")
	failWorker := make(chan struct{})
	saveEffect := make(chan struct{})
	workerStopped := make(chan struct{})
	saved := make(chan error, 1)
	original := dispatch()
	surviving := dispatch()
	surviving.OperationID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
	runtime := runtimeFixture(t, func(ctx context.Context, invocation *pluginruntime.Invocation) (plugindispatch.Outcome, error) {
		if invocation.Dispatch.OperationID == original.OperationID {
			select {
			case <-failWorker:
				return plugindispatch.Outcome{}, workerFailure
			case <-ctx.Done():
				return plugindispatch.Outcome{}, ctx.Err()
			}
		}
		defer close(workerStopped)
		select {
		case <-saveEffect:
			_, err := invocation.Record(pluginruntime.Update{Effects: []plugindispatch.Effect{{ID: "effect", Description: "accepted worker saved evidence"}}})
			saved <- err
		case <-ctx.Done():
			return plugindispatch.Outcome{}, ctx.Err()
		}
		<-ctx.Done()
		return plugindispatch.Outcome{}, ctx.Err()
	})
	for _, execution := range []plugindispatch.Dispatch{original, surviving} {
		if _, err := runtime.Accept(context.Background(), execution); err != nil {
			t.Fatal(err)
		}
	}
	close(failWorker)
	select {
	case observed := <-runtime.Faults():
		if !errors.Is(observed, workerFailure) {
			t.Fatal("observer lost worker failure cause", observed)
		}
	case <-time.After(time.Second):
		t.Fatal("worker fault was not observable")
	}
	if err := runtime.Run(context.Background(), "unused"); !errors.Is(err, workerFailure) {
		t.Fatal("session forgot the observed worker failure", err)
	}
	fresh := dispatch()
	fresh.OperationID = "ffffffff-ffff-4fff-8fff-ffffffffffff"
	if _, err := runtime.Accept(context.Background(), fresh); !errors.Is(err, workerFailure) {
		t.Fatal("faulted runtime accepted new work", err)
	}
	close(saveEffect)
	select {
	case err := <-saved:
		if err != nil {
			t.Fatal("accepted worker could not save its evidence", err)
		}
	case <-workerStopped:
		t.Fatal("worker failure stopped other accepted work")
	case <-time.After(time.Second):
		t.Fatal("accepted worker did not save its evidence")
	}
	retained := runtime.Retained()
	if len(retained) != 1 || retained[0].Execution.OperationID != surviving.OperationID || len(retained[0].Effects) != 1 || retained[0].Effects[0].ID != "effect" || retained[0].Outcome != nil {
		t.Fatal("worker failure rewrote surviving execution evidence", retained)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := runtime.Close(ctx); err != nil {
		t.Fatal("explicit Close did not join surviving worker", err)
	}
	select {
	case <-workerStopped:
	default:
		t.Fatal("Close returned before accepted worker stopped")
	}
}
