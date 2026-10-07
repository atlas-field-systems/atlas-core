package plugins_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/atlas-field-systems/atlas-core/plugindispatch"
	"github.com/atlas-field-systems/atlas-core/plugins"
)

// The agreed seam is Core's Plugins interface with a separately built Plugin
// using a real Unix socket, SQLite and Plugin-owned files. The effect file is
// an external fixture result, never a Core table inspection.
const (
	datasetID   = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	pluginID    = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	principalID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
)

func TestAcceptedWorkOutlivesCallerAndRetriesOnce(t *testing.T) {
	f := newFixture(t, 4)
	child := f.start(t, "normal")
	child.event(t, "ready")
	caller, lost := context.WithCancel(context.Background())
	operation, err := f.core.Submit(caller, request("one", `{"value":7}`))
	if err != nil {
		t.Fatal(err)
	}
	lost()
	retry, err := f.core.Submit(context.Background(), request("one", `{"value":7}`))
	if err != nil || retry.ID != operation.ID {
		t.Fatalf("retry: %+v %v", retry, err)
	}
	child.command(t, "next")
	child.event(t, "received")
	child.command(t, "report")
	child.event(t, "acknowledged")
	completed := f.wait(t, operation.ID, plugins.Completed)
	if string(completed.Outcome.Result) != `{"value":14}` {
		t.Fatalf("result: %s", completed.Outcome.Result)
	}
	effect, err := os.ReadFile(f.effects)
	if err != nil || string(effect) != "effect\n" {
		t.Fatalf("effects: %q %v", effect, err)
	}
}

func request(id, input string) plugins.Submission {
	return plugins.Submission{DatasetID: datasetID, PluginID: pluginID, RequestID: id, CallerID: "caller", CapabilityID: "double", InputVersion: "1", Input: json.RawMessage(input)}
}

type fixture struct {
	children                            []*child
	maxFiles                            int
	maxBytes                            int64
	server                              *plugins.Server
	config                              plugins.Config
	core                                *plugins.Module
	contract                            *plugindispatch.Contract
	root, socket, work, effects, binary string
	binding                             plugins.RuntimeBinding
}

func newFixture(t *testing.T, capacity int) *fixture { return newFixtureConfigured(t, capacity, nil) }
func newFixtureConfigured(t *testing.T, capacity int, configure func(*plugins.Config)) *fixture {
	t.Helper()
	root, rootErr := os.MkdirTemp("", "atlas-plugin-")
	if rootErr != nil {
		t.Fatal(rootErr)
	}
	cleanupRoot := true
	t.Cleanup(func() {
		if cleanupRoot {
			if err := os.RemoveAll(root); err != nil {
				t.Error(err)
			}
		}
	})
	contract, err := plugindispatch.Load("../../Atlas Protocol/plugin-dispatch.json")
	if err != nil {
		t.Fatal(err)
	}
	capability := plugindispatch.Capability{ID: "double", InputVersion: "1", InputSchema: json.RawMessage(`{"type":"object","additionalProperties":false,"required":["value"],"properties":{"value":{"type":"integer"},"padding":{"type":"string","maxLength":32700}}}`), OutputSchema: json.RawMessage(`{"type":"object","additionalProperties":false,"required":["value"],"properties":{"value":{"type":"integer"}}}`), ErrorSchema: json.RawMessage(`{"type":"object","additionalProperties":false,"required":["code"],"properties":{"code":{"type":"string"}}}`)}
	configuration := plugins.Config{DatabasePath: filepath.Join(root, "core.sqlite"), DatasetID: datasetID, CoreRunID: "run", CoreRelease: "fixture", Contract: contract, Capabilities: []plugindispatch.Capability{capability}}
	if configure != nil {
		configure(&configuration)
	}
	core, err := plugins.Open(context.Background(), configuration)
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{maxFiles: 64, maxBytes: 1024 * 1024, core: core, config: configuration, contract: contract, root: root, socket: filepath.Join(root, "private.sock"), work: filepath.Join(root, "work"), effects: filepath.Join(root, "effects"), binary: filepath.Join(root, "plugin")}
	f.binding = plugins.RuntimeBinding{Binding: plugindispatch.Binding{PluginID: pluginID, PrincipalID: principalID, DatasetID: datasetID, CoreRunID: "run", RuntimeGeneration: "runtime-1"}, Token: "private-fixture-token", VerifiedProcess: "host-observed-process-1", ReceiptCapacity: capacity, Release: plugindispatch.Release{PackageID: "fixture", Version: "1.0.0", ImageDigest: "sha256:fixture"}, ConfigurationRevision: "1", CapabilityIDs: []string{"double"}}
	if err := core.BindRuntime(context.Background(), f.binding); err != nil {
		t.Fatal(err)
	}
	server, err := core.Listen(f.socket)
	if err != nil {
		t.Fatal(err)
	}
	f.server = server
	t.Cleanup(func() {
		for _, child := range f.children {
			select {
			case <-child.done:
			default:
				cleanupRoot = false
				t.Errorf("Plugin process not reaped; preserving %s", root)
			}
		}
		shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := f.server.Close(shutdown); err != nil {
			cleanupRoot = false
			t.Error(err)
			return
		}
		if err := f.core.Close(); err != nil {
			t.Error(err)
		}
	})
	arguments := []string{"build"}
	if pluginRace {
		arguments = append(arguments, "-race")
	}
	arguments = append(arguments, "-o", f.binary, "../tests/pluginfixture")
	build := exec.Command("go", arguments...)
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build plugin: %s %v", output, err)
	}
	return f
}
func (f *fixture) wait(t *testing.T, id string, state plugins.Status) plugins.Operation {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		value, err := f.core.Read(context.Background(), datasetID, pluginID, id)
		if err != nil {
			t.Fatal(err)
		}
		if value.Status == state {
			return value
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("Operation %s did not become %s", id, state)
	return plugins.Operation{}
}

func TestLiveReceiptSurvivesLostAcknowledgementsAndCapacity(t *testing.T) {
	f := newFixture(t, 1)
	child := f.start(t, "lost-dispatch-ack")
	child.event(t, "ready")
	operation, err := f.core.Submit(context.Background(), request("lost", `{"value":7}`))
	if err != nil {
		t.Fatal(err)
	}
	child.command(t, "next")
	child.event(t, "received")
	child.command(t, "saved")
	child.event(t, "saved")
	child.command(t, "next")
	if !child.event(t, "received").Duplicate {
		t.Fatal("lost dispatch ACK executed twice")
	}
	child.command(t, "changed-dispatch")
	if e := child.event(t, "error"); e.Error != "dispatch_conflict" {
		t.Fatalf("changed dispatch: %+v", e)
	}
	child.command(t, "report-retain")
	child.event(t, "committed")
	child.command(t, "report-retain")
	child.event(t, "committed")
	child.command(t, "report")
	child.event(t, "acknowledged")
	child.command(t, "duplicate")
	if !child.event(t, "duplicate").Duplicate {
		t.Fatal("ACK deleted live receipt")
	}
	completed := f.wait(t, operation.ID, plugins.Completed)
	if string(completed.Outcome.Result) != `{"value":14}` {
		t.Fatal(completed)
	}
	child.command(t, "conflicting-outcome")
	if e := child.event(t, "error"); e.Error != "terminal_conflict" {
		t.Fatalf("terminal conflict: %+v", e)
	}
	child.command(t, "changed-report")
	if e := child.event(t, "error"); e.Error != "report_conflict" {
		t.Fatal(e)
	}
	child.command(t, "invalid-result")
	if e := child.event(t, "error"); e.Error != "invalid_schema" {
		t.Fatal(e)
	}
	if _, err := f.core.Submit(context.Background(), request("fresh", `{"value":8}`)); !errors.Is(err, plugins.ErrLimit) {
		t.Fatalf("completed receipt freed capacity: %v", err)
	}
	if _, err := f.core.Submit(context.Background(), request("lost", `{"value":8}`)); !errors.Is(err, plugins.ErrConflict) {
		t.Fatalf("changed retry: %v", err)
	}
	retry, err := f.core.Submit(context.Background(), request("lost", `{"value":7}`))
	if err != nil || retry.ID != operation.ID {
		t.Fatal(retry, err)
	}
	listed, err := f.core.List(context.Background(), datasetID, pluginID, 100, 0)
	if err != nil || len(listed) != 1 {
		t.Fatal(listed, err)
	}
	assertEffects(t, f, 1)
}

func TestConcurrentReservationsAndNeverExposedCancellation(t *testing.T) {
	f := newFixture(t, 2)
	child := f.start(t, "normal")
	child.event(t, "ready")
	var group sync.WaitGroup
	results := make(chan error, 12)
	for i := range 12 {
		group.Add(1)
		go func() {
			defer group.Done()
			_, err := f.core.Submit(context.Background(), request(fmt.Sprintf("request-%d", i), `{"value":2}`))
			results <- err
		}()
	}
	group.Wait()
	close(results)
	accepted, refused := 0, 0
	for err := range results {
		if err == nil {
			accepted++
		} else if errors.Is(err, plugins.ErrLimit) {
			refused++
		} else {
			t.Fatal(err)
		}
	}
	if accepted != 2 || refused != 10 {
		t.Fatalf("admission: %d accepted %d refused", accepted, refused)
	}
	listed, err := f.core.List(context.Background(), datasetID, pluginID, 100, 0)
	if err != nil || len(listed) != 2 {
		t.Fatal(listed, err)
	}
	cancelled, err := f.core.Cancel(context.Background(), datasetID, pluginID, listed[0].ID)
	if err != nil || cancelled.Status != plugins.Cancelled {
		t.Fatal(cancelled, err)
	}
	if _, err := f.core.Submit(context.Background(), request("invalid", `{"value":"bad"}`)); err == nil {
		t.Fatal("invalid input accepted")
	}
	fresh, err := f.core.Submit(context.Background(), request("fresh", `{"value":3}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.core.Cancel(context.Background(), datasetID, pluginID, listed[1].ID); err != nil {
		t.Fatal(err)
	}
	child.command(t, "next")
	child.event(t, "received")
	child.command(t, "report")
	child.event(t, "acknowledged")
	f.wait(t, fresh.ID, plugins.Completed)
	child.command(t, "next")
	child.event(t, "idle")
	assertEffects(t, f, 1)
}

func TestExposedCancellationSurvivesReceiptAndProgress(t *testing.T) {
	f := newFixture(t, 2)
	child := f.start(t, "ignore-cancel")
	child.event(t, "ready")
	operation, err := f.core.Submit(context.Background(), request("cancel", `{"value":6}`))
	if err != nil {
		t.Fatal(err)
	}
	child.command(t, "next")
	child.event(t, "received")
	child.event(t, "started")
	cancellation, err := f.core.Cancel(context.Background(), datasetID, pluginID, operation.ID)
	if err != nil || cancellation.Status != plugins.CancellationRequested {
		t.Fatal(cancellation, err)
	}
	child.command(t, "next")
	child.event(t, "cancel_received")
	child.command(t, "progress")
	child.event(t, "progress")
	value := f.wait(t, operation.ID, plugins.CancellationRequested)
	if value.CancellationID != cancellation.CancellationID || len(value.KnownEffects) != 0 || string(value.Progress) != `{"percent":50}` {
		t.Fatal(value)
	}
	child.command(t, "release")
	child.event(t, "released")
	child.command(t, "report")
	child.event(t, "acknowledged")
	completed := f.wait(t, operation.ID, plugins.Completed)
	if completed.CancellationID == "" || len(completed.KnownEffects) != 0 {
		t.Fatal(completed)
	}
	assertEffects(t, f, 1)
}

func assertEffects(t *testing.T, f *fixture, count int) {
	t.Helper()
	body, err := os.ReadFile(f.effects)
	if count == 0 && errors.Is(err, os.ErrNotExist) {
		return
	}
	if err != nil || string(body) != strings.Repeat("effect\n", count) {
		t.Fatalf("external effects: %q %v", body, err)
	}
}

func TestDisconnectedRuntimeRequiresVerifiedReconnectAndRetainedReceipts(t *testing.T) {
	f := newFixture(t, 2)
	child := f.start(t, "ignore-cancel")
	child.event(t, "ready")
	operation, err := f.core.Submit(context.Background(), request("disconnected", `{"value":9}`))
	if err != nil {
		t.Fatal(err)
	}
	child.command(t, "next")
	child.event(t, "received")
	cancellation, err := f.core.Cancel(context.Background(), datasetID, pluginID, operation.ID)
	if err != nil {
		t.Fatal(err)
	}
	child.command(t, "disconnect")
	child.event(t, "disconnected")
	waitUnavailable(t, f)
	if _, err := f.core.Submit(context.Background(), request("fresh", `{"value":10}`)); !errors.Is(err, plugins.ErrUnavailable) {
		t.Fatal(err)
	}
	retry, err := f.core.Submit(context.Background(), request("disconnected", `{"value":9}`))
	if err != nil || retry.ID != operation.ID || retry.Status != plugins.CancellationRequested {
		t.Fatal(retry, err)
	}
	if err := f.core.VerifyReconnect(f.binding.Binding, "claimed-container-name"); !errors.Is(err, plugins.ErrAuthority) {
		t.Fatal(err)
	}
	child.command(t, "reconnect")
	if e := child.event(t, "error"); e.Error != "invalid_authority" {
		t.Fatal(e)
	}
	// The failed socket is closed before the unchanged process retries.
	child.command(t, "disconnect")
	child.event(t, "disconnected")
	if err := f.core.VerifyReconnect(f.binding.Binding, f.binding.VerifiedProcess); err != nil {
		t.Fatal(err)
	}
	child.command(t, "reconnect")
	child.event(t, "ready")
	child.command(t, "next")
	child.event(t, "cancel_received")
	value := f.wait(t, operation.ID, plugins.CancellationRequested)
	if value.CancellationID != cancellation.CancellationID {
		t.Fatal(value)
	}
	child.command(t, "release")
	child.event(t, "released")
	child.command(t, "report")
	child.event(t, "acknowledged")
	f.wait(t, operation.ID, plugins.Completed)
	assertEffects(t, f, 1)
}

func TestConfirmedDeathRecoversSavedOutcomeWithoutReopening(t *testing.T) {
	f := newFixture(t, 2)
	child := f.start(t, "normal")
	child.event(t, "ready")
	operation, err := f.core.Submit(context.Background(), request("saved", `{"value":11}`))
	if err != nil {
		t.Fatal(err)
	}
	child.command(t, "next")
	child.event(t, "received")
	child.command(t, "saved")
	saved := child.event(t, "saved").Evidence
	child.kill(t)
	if err := f.core.ConfirmLoss(context.Background(), f.binding.Binding); err != nil {
		t.Fatal(err)
	}
	interrupted := f.wait(t, operation.ID, plugins.Interrupted)
	if interrupted.RecoveredOutcome != nil || interrupted.Outcome != nil {
		t.Fatal(interrupted)
	}
	old := f.binding.Binding
	f.replace(t, "runtime-2")
	replacement := f.start(t, "normal")
	replacement.event(t, "ready")
	recovered := f.wait(t, operation.ID, plugins.Interrupted)
	if recovered.RecoveredOutcome == nil || string(recovered.RecoveredOutcome.Result) != `{"value":22}` {
		t.Fatal(recovered)
	}
	listed, err := f.core.List(context.Background(), datasetID, pluginID, 100, 0)
	if err != nil || len(listed) != 1 || listed[0].Status != plugins.Interrupted || listed[0].RecoveredOutcome == nil {
		t.Fatal(listed, err)
	}
	retained := replacement.event(t, "retained").Evidence
	if retained.Sequence != saved.Sequence || retained.Revision != saved.Revision {
		t.Fatal("original report identity lost")
	}
	entries, err := os.ReadDir(f.work)
	if err != nil || len(entries) != 0 {
		t.Fatalf("exact recovered ACK cleanup: %v %v", entries, err)
	}
	replacement.command(t, "next")
	replacement.event(t, "idle")
	assertEffects(t, f, 1)
	if err := f.core.ConfirmLoss(context.Background(), old); !errors.Is(err, plugins.ErrAuthority) {
		t.Fatal("stale loss accepted", err)
	}
}

func TestRealEffectBeforePersistenceRemainsUnknownAndNeverReruns(t *testing.T) {
	f := newFixture(t, 2)
	child := f.start(t, "effect-gap")
	child.event(t, "ready")
	operation, err := f.core.Submit(context.Background(), request("gap", `{"value":12}`))
	if err != nil {
		t.Fatal(err)
	}
	child.command(t, "next")
	child.event(t, "received")
	child.event(t, "effect")
	child.kill(t)
	if err := f.core.ConfirmLoss(context.Background(), f.binding.Binding); err != nil {
		t.Fatal(err)
	}
	interrupted := f.wait(t, operation.ID, plugins.Interrupted)
	if len(interrupted.KnownEffects) != 0 || interrupted.RecoveredOutcome != nil {
		t.Fatal("invented evidence", interrupted)
	}
	f.replace(t, "runtime-2")
	replacement := f.start(t, "normal")
	replacement.event(t, "ready")
	replacement.command(t, "next")
	replacement.event(t, "idle")
	assertEffects(t, f, 1)
}

func TestManualReplacementRebuildsNeverExposedReservations(t *testing.T) {
	f := newFixture(t, 1)
	child := f.start(t, "normal")
	child.event(t, "ready")
	original, err := f.core.Submit(context.Background(), request("never-exposed", `{"value":4}`))
	if err != nil {
		t.Fatal(err)
	}
	old := f.binding.Binding
	// Confirmed loss is a trusted host fact. Keep the stale socket open to
	// exercise its deferred disconnect after the replacement starts session 1.
	if err := f.core.ConfirmLoss(context.Background(), old); err != nil {
		t.Fatal(err)
	}
	f.replace(t, "runtime-2")
	replacement := f.start(t, "normal")
	replacement.event(t, "ready")
	child.command(t, "next")
	if e := child.event(t, "error"); e.Error != "invalid_authority" {
		t.Fatal(e)
	}
	if _, err := f.core.Submit(context.Background(), request("new", `{"value":5}`)); !errors.Is(err, plugins.ErrLimit) {
		t.Fatalf("reservation lost or old disconnect closed replacement: %v", err)
	}
	replacement.command(t, "next")
	replacement.event(t, "received")
	replacement.command(t, "report")
	replacement.event(t, "acknowledged")
	completed := f.wait(t, original.ID, plugins.Completed)
	if completed.Execution.Binding != f.binding.Binding {
		t.Fatal(completed)
	}
	assertEffects(t, f, 1)
}

func TestDrainRequiresAcceptedWorkToFinishOrExplicitCancellation(t *testing.T) {
	f := newFixture(t, 2)
	child := f.start(t, "normal")
	child.event(t, "ready")
	operation, err := f.core.Submit(context.Background(), request("draining", `{"value":5}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := f.core.Drain(f.binding.Binding); err != nil {
		t.Fatal(err)
	}
	child.command(t, "next")
	child.event(t, "drain")
	child.command(t, "drained")
	if e := child.event(t, "error"); e.Error != "active_work" {
		t.Fatal(e)
	}
	if _, err := f.core.Submit(context.Background(), request("new", `{"value":5}`)); !errors.Is(err, plugins.ErrUnavailable) {
		t.Fatal(err)
	}
	cancelled, err := f.core.Cancel(context.Background(), datasetID, pluginID, operation.ID)
	if err != nil || cancelled.Status != plugins.Cancelled {
		t.Fatal(cancelled, err)
	}
	child.command(t, "drained")
	child.event(t, "drained")
	assertEffects(t, f, 0)
}
func waitUnavailable(t *testing.T, f *fixture) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if !f.core.Available(pluginID) {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("disconnected runtime still admits work")
}
func (f *fixture) replace(t *testing.T, generation string) {
	t.Helper()
	f.binding.Binding.RuntimeGeneration = generation
	f.binding.Token = "new-private-fixture-token-" + generation
	f.binding.VerifiedProcess = "host-verified-process-" + generation
	if err := f.core.BindRuntime(context.Background(), f.binding); err != nil {
		t.Fatal(err)
	}
}

func TestCoreProcessCrashRetainsConfirmedAndRecoversOriginalRunEvidence(t *testing.T) {
	f := newFixture(t, 3)
	shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := f.server.Close(shutdown); err != nil {
		t.Fatal(err)
	}
	if err := f.core.Close(); err != nil {
		t.Fatal(err)
	}
	coreProcess := f.startProcess(t, "normal", true)
	coreProcess.event(t, "ready")
	child := f.start(t, "normal")
	child.event(t, "ready")
	submit := func(identity string) plugins.Operation {
		body, err := json.Marshal(request(identity, `{"value":13}`))
		if err != nil {
			t.Fatal(err)
		}
		coreProcess.command(t, "submit "+string(body))
		event := coreProcess.event(t, "accepted")
		if event.Operation == nil {
			t.Fatal(event)
		}
		return *event.Operation
	}
	confirmed := submit("confirmed")
	child.command(t, "next")
	child.event(t, "received")
	child.command(t, "report")
	child.event(t, "acknowledged")
	uncertain := submit("uncertain")
	child.command(t, "next")
	child.event(t, "received")
	child.command(t, "saved")
	evidence := child.event(t, "saved").Evidence
	pending := submit("pending")
	coreProcess.kill(t)
	child.kill(t)
	// The process kill preserves SQLite's WAL. Ordinary retained opening is
	// exercised in a new Core run before any Plugin can authenticate.
	f.config.CoreRunID = "run-2"
	core, err := plugins.Open(context.Background(), f.config)
	if err != nil {
		t.Fatal(err)
	}
	f.core = core
	f.wait(t, confirmed.ID, plugins.Completed)
	f.wait(t, uncertain.ID, plugins.Interrupted)
	f.wait(t, pending.ID, plugins.Interrupted)
	if err := f.core.BindRuntime(context.Background(), f.binding); !errors.Is(err, plugins.ErrAuthority) {
		t.Fatalf("old Core-run binding: %v", err)
	}
	if err := os.Remove(f.socket); err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	f.server, err = f.core.Listen(f.socket)
	if err != nil {
		t.Fatal(err)
	}
	f.binding.Binding.CoreRunID = "run-2"
	f.replace(t, "runtime-2")
	replacement := f.start(t, "normal")
	replacement.event(t, "ready")
	recovered := f.wait(t, uncertain.ID, plugins.Interrupted)
	if recovered.RecoveredOutcome == nil || string(recovered.RecoveredOutcome.Result) != `{"value":26}` || recovered.Execution.Binding.CoreRunID != "run" {
		t.Fatal(recovered)
	}
	retained := replacement.event(t, "retained").Evidence
	if retained.Sequence != evidence.Sequence || retained.Revision != evidence.Revision {
		t.Fatal("lost original old-run evidence revision")
	}
	replacement.command(t, "accept "+mustJSON(t, evidence.Execution))
	if e := replacement.event(t, "error"); e.Error != "invalid_authority" {
		t.Fatal(e)
	}
	replacement.command(t, "next")
	replacement.event(t, "idle")
	assertEffects(t, f, 2)
	retry, err := f.core.Submit(context.Background(), request("uncertain", `{"value":13}`))
	if err != nil || retry.ID != uncertain.ID || retry.Status != plugins.Interrupted {
		t.Fatal(retry, err)
	}
}
func mustJSON(t *testing.T, value any) string {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func TestActualRuntimeChannelPreservesWorkAcrossSessionCancellationAndDrains(t *testing.T) {
	f := newFixture(t, 2)
	child := f.start(t, "run-hold")
	child.event(t, "session_started")
	waitAvailable(t, f)
	operation, err := f.core.Submit(context.Background(), request("actual-run", `{"value":15}`))
	if err != nil {
		t.Fatal(err)
	}
	child.event(t, "started")
	child.command(t, "progress")
	child.event(t, "progress")
	f.wait(t, operation.ID, plugins.InProgress)
	child.command(t, "disconnect")
	child.event(t, "disconnected")
	waitUnavailable(t, f)
	current, err := f.core.Read(context.Background(), datasetID, pluginID, operation.ID)
	if err != nil || current.Status == plugins.Cancelled || current.Status == plugins.Interrupted {
		t.Fatal(current, err)
	}
	if err := f.core.VerifyReconnect(f.binding.Binding, f.binding.VerifiedProcess); err != nil {
		t.Fatal(err)
	}
	child.command(t, "reconnect")
	child.event(t, "session_started")
	waitAvailable(t, f)
	child.command(t, "release")
	child.event(t, "released")
	completed := f.wait(t, operation.ID, plugins.Completed)
	if string(completed.Outcome.Result) != `{"value":30}` {
		t.Fatal(completed)
	}
	if err := f.core.Drain(f.binding.Binding); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		drained, err := f.core.Drained(f.binding.Binding)
		if err != nil {
			t.Fatal(err)
		}
		if drained {
			assertEffects(t, f, 1)
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("actual runtime channel never confirmed drain")
}

func TestDelayedEvidenceAcknowledgementKeepsNewerRevisionAfterDeath(t *testing.T) {
	f := newFixture(t, 2)
	child := f.start(t, "ignore-cancel")
	child.event(t, "ready")
	operation, err := f.core.Submit(context.Background(), request("revision", `{"value":16}`))
	if err != nil {
		t.Fatal(err)
	}
	child.command(t, "next")
	child.event(t, "received")
	child.command(t, "progress-retain")
	old := child.event(t, "progress").Evidence
	child.command(t, "progress-new")
	newer := child.event(t, "progress").Evidence
	if old.Revision == newer.Revision || old.Sequence == newer.Sequence {
		t.Fatal("fixture did not produce distinct revisions")
	}
	child.command(t, "ack-old")
	child.event(t, "old_ack")
	child.kill(t)
	if err := f.core.ConfirmLoss(context.Background(), f.binding.Binding); err != nil {
		t.Fatal(err)
	}
	f.replace(t, "runtime-2")
	replacement := f.start(t, "normal")
	replacement.event(t, "ready")
	recovered := f.wait(t, operation.ID, plugins.Interrupted)
	retained := replacement.event(t, "retained").Evidence
	if retained.Sequence != newer.Sequence || retained.Revision != newer.Revision {
		t.Fatal("delayed old ACK deleted newer revision", recovered)
	}
	assertEffects(t, f, 1)
}

func TestEvidenceQuotaRetainsPreviouslySavedOutcome(t *testing.T) {
	f := newFixture(t, 2)
	f.maxFiles = 1
	child := f.start(t, "normal")
	child.event(t, "ready")
	first, err := f.core.Submit(context.Background(), request("first", `{"value":17}`))
	if err != nil {
		t.Fatal(err)
	}
	child.command(t, "next")
	child.event(t, "received")
	child.command(t, "saved")
	child.event(t, "saved")
	second, err := f.core.Submit(context.Background(), request("second", `{"value":18}`))
	if err != nil {
		t.Fatal(err)
	}
	child.command(t, "next")
	child.event(t, "received")
	child.command(t, "runtime-fault")
	if e := child.event(t, "runtime_fault"); !strings.Contains(e.Error, "resource_limit") {
		t.Fatal(e)
	}
	child.kill(t)
	if err := f.core.ConfirmLoss(context.Background(), f.binding.Binding); err != nil {
		t.Fatal(err)
	}
	f.replace(t, "runtime-2")
	replacement := f.start(t, "normal")
	replacement.event(t, "ready")
	recovered := f.wait(t, first.ID, plugins.Interrupted)
	if recovered.RecoveredOutcome == nil || string(recovered.RecoveredOutcome.Result) != `{"value":34}` {
		t.Fatal(recovered)
	}
	uncertain := f.wait(t, second.ID, plugins.Interrupted)
	if uncertain.RecoveredOutcome != nil || len(uncertain.KnownEffects) != 0 {
		t.Fatal(uncertain)
	}
	assertEffects(t, f, 2)
}

func TestCorruptRetainedEvidenceFaultsReadiness(t *testing.T) {
	f := newFixture(t, 2)
	if err := os.Mkdir(f.work, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.work, "damaged.evidence.json"), []byte(`{"format_version":1,"evidence":`), 0o600); err != nil {
		t.Fatal(err)
	}
	child := f.start(t, "normal")
	if e := child.event(t, "fault"); e.Error != "corrupt_retained_evidence" {
		t.Fatal(e)
	}
	child.expectFailure(t)
	if f.core.Available(pluginID) {
		t.Fatal("corrupt history masqueraded as readiness")
	}
	if _, err := f.core.Submit(context.Background(), request("new", `{"value":1}`)); !errors.Is(err, plugins.ErrUnavailable) {
		t.Fatal(err)
	}
}
func waitAvailable(t *testing.T, f *fixture) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if f.core.Available(pluginID) {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("runtime did not become ready")
}

func TestAmbiguousFilePublicationFencesOldAckAndRecoversNewEvidence(t *testing.T) {
	f := newFixture(t, 2)
	child := f.start(t, "sync-failure")
	child.event(t, "ready")
	operation, err := f.core.Submit(context.Background(), request("ambiguous-sync", `{"value":19}`))
	if err != nil {
		t.Fatal(err)
	}
	child.command(t, "next")
	child.event(t, "received")
	child.command(t, "progress-retain")
	child.event(t, "progress")
	child.command(t, "fail-sync")
	child.event(t, "sync_fault_enabled")
	child.command(t, "progress-new")
	if e := child.event(t, "error"); !strings.Contains(e.Error, "evidence_storage_fault") {
		t.Fatal(e)
	}
	child.command(t, "ack-old")
	if e := child.event(t, "error"); !strings.Contains(e.Error, "evidence_storage_fault") {
		t.Fatal(e)
	}
	child.kill(t)
	if err := f.core.ConfirmLoss(context.Background(), f.binding.Binding); err != nil {
		t.Fatal(err)
	}
	f.replace(t, "runtime-2")
	replacement := f.start(t, "normal")
	replacement.event(t, "ready")
	recovered := f.wait(t, operation.ID, plugins.Interrupted)
	if len(recovered.KnownEffects) != 1 || recovered.KnownEffects[0].ID != "fixture-known" {
		t.Fatal("new candidate erased by stale ACK", recovered)
	}
	retained := replacement.event(t, "retained").Evidence
	if retained.Sequence != "2" {
		t.Fatal("newer published candidate missing", retained)
	}
	assertEffects(t, f, 1)
}

func TestConcurrentIdenticalSubmissionRetriesCreateOneExecution(t *testing.T) {
	f := newFixture(t, 1)
	child := f.start(t, "normal")
	child.event(t, "ready")
	var group sync.WaitGroup
	operations := make(chan plugins.Operation, 20)
	failures := make(chan error, 20)
	for range 20 {
		group.Add(1)
		go func() {
			defer group.Done()
			operation, err := f.core.Submit(context.Background(), request("same", `{"value":20}`))
			operations <- operation
			failures <- err
		}()
	}
	group.Wait()
	close(operations)
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	identity := ""
	for operation := range operations {
		if identity == "" {
			identity = operation.ID
		}
		if operation.ID != identity {
			t.Fatal("duplicate acceptance")
		}
	}
	child.command(t, "next")
	child.event(t, "received")
	child.command(t, "report")
	child.event(t, "acknowledged")
	f.wait(t, identity, plugins.Completed)
	assertEffects(t, f, 1)
	listed, err := f.core.List(context.Background(), datasetID, pluginID, 100, 0)
	if err != nil || len(listed) != 1 {
		t.Fatal(listed, err)
	}
	changed := request("same", `{"value":20}`)
	changed.CallerID = "another-caller"
	if _, err := f.core.Submit(context.Background(), changed); !errors.Is(err, plugins.ErrConflict) {
		t.Fatal(err)
	}
}

func TestDurableKnownEffectArrivesThroughReplacementReadiness(t *testing.T) {
	f := newFixture(t, 2)
	child := f.start(t, "ignore-cancel")
	child.event(t, "ready")
	operation, err := f.core.Submit(context.Background(), request("known", `{"value":21}`))
	if err != nil {
		t.Fatal(err)
	}
	child.command(t, "next")
	child.event(t, "received")
	child.command(t, "known-effect-save")
	child.event(t, "progress")
	child.kill(t)
	if err := f.core.ConfirmLoss(context.Background(), f.binding.Binding); err != nil {
		t.Fatal(err)
	}
	before := f.wait(t, operation.ID, plugins.Interrupted)
	if len(before.KnownEffects) != 0 {
		t.Fatal(before)
	}
	f.replace(t, "runtime-2")
	replacement := f.start(t, "normal")
	replacement.event(t, "ready")
	after := f.wait(t, operation.ID, plugins.Interrupted)
	if len(after.KnownEffects) != 1 || after.KnownEffects[0].ID != "fixture-known" || after.RecoveredOutcome != nil {
		t.Fatal(after)
	}
	assertEffects(t, f, 1)
}

func TestVerifiedProcessCannotReconnectAfterLosingLiveWitness(t *testing.T) {
	f := newFixture(t, 2)
	original := f.start(t, "normal")
	original.event(t, "ready")
	operation, err := f.core.Submit(context.Background(), request("witness", `{"value":22}`))
	if err != nil {
		t.Fatal(err)
	}
	original.command(t, "next")
	original.event(t, "received")
	original.command(t, "report")
	original.event(t, "acknowledged")
	f.wait(t, operation.ID, plugins.Completed)
	original.command(t, "disconnect")
	original.event(t, "disconnected")
	waitUnavailable(t, f)
	if err := f.core.VerifyReconnect(f.binding.Binding, f.binding.VerifiedProcess); err != nil {
		t.Fatal(err)
	}
	impostor := f.start(t, "normal")
	if e := impostor.event(t, "fault"); e.Error != "live_receipts_lost" {
		t.Fatal(e)
	}
	impostor.expectFailure(t)
	if f.core.Available(pluginID) {
		t.Fatal("new process reused old authority")
	}
	assertEffects(t, f, 1)
}

func TestLargeAcknowledgedReceiptInventoryReconnectsInBoundedPages(t *testing.T) {
	f := newFixture(t, 4)
	// Four maximum-sized valid inputs exceed one readiness frame.
	child := f.start(t, "normal")
	child.event(t, "ready")
	for i := range 4 {
		operation, err := f.core.Submit(context.Background(), request(fmt.Sprintf("large-%d", i), `{"value":23,"padding":"`+strings.Repeat("x", 32700)+`"}`))
		if err != nil {
			t.Fatal(err)
		}
		child.command(t, "next")
		child.event(t, "received")
		child.command(t, "report")
		child.event(t, "acknowledged")
		f.wait(t, operation.ID, plugins.Completed)
	}
	child.command(t, "disconnect")
	child.event(t, "disconnected")
	waitUnavailable(t, f)
	if err := f.core.VerifyReconnect(f.binding.Binding, f.binding.VerifiedProcess); err != nil {
		t.Fatal(err)
	}
	child.command(t, "reconnect")
	child.event(t, "ready")
	assertEffects(t, f, 4)
}

func TestInputByteBoundPrecedesCanonicalizationAndPreservesReservations(t *testing.T) {
	f := newFixture(t, 1)
	child := f.start(t, "normal")
	child.event(t, "ready")
	oversized := strings.Repeat(" ", f.contract.Limits.InputBytes) + `{"value":1}`
	if _, err := f.core.Submit(context.Background(), request("whitespace", oversized)); !errors.Is(err, plugins.ErrLimit) {
		t.Fatal(err)
	}
	if _, err := f.core.Submit(context.Background(), request("valid", `{"value":1}`)); err != nil {
		t.Fatal(err)
	}
	listed, err := f.core.List(context.Background(), datasetID, pluginID, 100, 0)
	if err != nil || len(listed) != 1 {
		t.Fatal(listed, err)
	}
}

func TestCancellationAfterExposureAndLostReceiptIsNeverUndispatched(t *testing.T) {
	f := newFixture(t, 2)
	child := f.start(t, "lost-ack-hold")
	child.event(t, "ready")
	operation, err := f.core.Submit(context.Background(), request("lost-receipt-cancel", `{"value":24}`))
	if err != nil {
		t.Fatal(err)
	}
	child.command(t, "next")
	child.event(t, "received")
	cancellation, err := f.core.Cancel(context.Background(), datasetID, pluginID, operation.ID)
	if err != nil || cancellation.Status != plugins.CancellationRequested {
		t.Fatal(cancellation, err)
	}
	child.command(t, "receipt")
	child.event(t, "accepted_receipt")
	child.command(t, "progress")
	child.event(t, "progress")
	pending := f.wait(t, operation.ID, plugins.CancellationRequested)
	if pending.CancellationID != cancellation.CancellationID {
		t.Fatal(pending)
	}
	child.command(t, "release")
	child.event(t, "released")
	child.command(t, "report")
	child.event(t, "acknowledged")
	f.wait(t, operation.ID, plugins.Completed)
	assertEffects(t, f, 1)
}

func TestByteQuotaRefusesReplacementWithoutErasingUnacknowledgedEvidence(t *testing.T) {
	f := newFixture(t, 2)
	f.maxBytes = 1024
	child := f.start(t, "ignore-cancel")
	child.event(t, "ready")
	operation, err := f.core.Submit(context.Background(), request("byte-quota", `{"value":25}`))
	if err != nil {
		t.Fatal(err)
	}
	child.command(t, "next")
	child.event(t, "received")
	child.command(t, "progress-retain")
	original := child.event(t, "progress").Evidence
	child.command(t, "progress-new")
	if e := child.event(t, "error"); e.Error != "resource_limit" {
		t.Fatal(e)
	}
	child.kill(t)
	if err := f.core.ConfirmLoss(context.Background(), f.binding.Binding); err != nil {
		t.Fatal(err)
	}
	f.replace(t, "runtime-2")
	replacement := f.start(t, "normal")
	replacement.event(t, "ready")
	recovered := f.wait(t, operation.ID, plugins.Interrupted)
	retained := replacement.event(t, "retained").Evidence
	if retained.Sequence != original.Sequence || retained.Revision != original.Revision {
		t.Fatal("byte refusal erased earlier evidence", recovered)
	}
	assertEffects(t, f, 1)
}

func TestUnreportedOrdinaryProgressLeavesReplacementReadinessEmpty(t *testing.T) {
	f := newFixture(t, 2)
	child := f.start(t, "ignore-cancel")
	child.event(t, "ready")
	operation, err := f.core.Submit(context.Background(), request("transient", `{"value":26}`))
	if err != nil {
		t.Fatal(err)
	}
	child.command(t, "next")
	child.event(t, "received")
	child.command(t, "progress-new")
	progress := child.event(t, "progress").Evidence
	if progress.Outcome != nil || len(progress.Effects) != 0 || len(progress.Outputs) != 0 {
		t.Fatal("fixture did not create ordinary progress")
	}
	files, err := os.ReadDir(f.work)
	if err != nil || len(files) != 0 {
		t.Fatalf("ordinary progress wrote durable evidence: %v %v", files, err)
	}
	child.kill(t)
	if err := f.core.ConfirmLoss(context.Background(), f.binding.Binding); err != nil {
		t.Fatal(err)
	}
	f.replace(t, "runtime-2")
	replacement := f.start(t, "normal")
	replacement.event(t, "ready")
	interrupted := f.wait(t, operation.ID, plugins.Interrupted)
	if interrupted.RecoveredOutcome != nil || len(interrupted.KnownEffects) != 0 || len(interrupted.Progress) != 0 {
		t.Fatal("replacement treated transient progress as retained execution evidence", interrupted)
	}
	replacement.command(t, "next")
	replacement.event(t, "idle")
	assertEffects(t, f, 0)
}
