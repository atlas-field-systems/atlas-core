package plugins_test

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/atlas-field-systems/atlas-core/plugins"
)

func TestDrainStopsIngestionOnceAcrossReconnectBeforeConfirming(t *testing.T) {
	f := newFixture(t, 2)
	child := f.start(t, "run-ingestion")
	child.event(t, "session_started")
	waitAvailable(t, f)
	child.command(t, "ingest")
	child.event(t, "ingested")
	operation, err := f.core.Submit(context.Background(), request("ingestion-drain", `{"value":7}`))
	if err != nil {
		t.Fatal(err)
	}
	child.event(t, "started")
	if err := f.core.Drain(f.binding.Binding); err != nil {
		t.Fatal(err)
	}
	child.event(t, "ingestion_stop_requested")
	if drained, err := f.core.Drained(f.binding.Binding); err != nil || drained {
		t.Fatal("drain confirmed before finite work and ingestion stopped", drained, err)
	}
	// The source can still write while its stop barrier is held. Requesting a
	// stop must not be confused with the owner's confirmation that it joined.
	child.command(t, "ingest")
	child.event(t, "ingested")
	child.command(t, "disconnect")
	child.event(t, "disconnected")
	// Drain already makes Available false, so join the listener to prove the
	// old channel closed before supplying the unchanged-process proof.
	shutdown, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := f.server.Close(shutdown); err != nil {
		t.Fatal(err)
	}
	server, err := f.core.Listen(f.socket)
	if err != nil {
		t.Fatal(err)
	}
	f.server = server
	retained, err := f.core.Read(context.Background(), datasetID, pluginID, operation.ID)
	if err != nil || retained.Status != plugins.Pending {
		t.Fatal("drain or session loss fabricated an outcome", retained, err)
	}
	if err := f.core.VerifyReconnect(f.binding.Binding, f.binding.VerifiedProcess); err != nil {
		t.Fatal(err)
	}
	child.command(t, "reconnect")
	child.event(t, "session_started")
	child.command(t, "release")
	child.event(t, "released")
	completed := f.wait(t, operation.ID, plugins.Completed)
	if string(completed.Outcome.Result) != `{"value":14}` {
		t.Fatal(completed)
	}
	if err := f.core.Drain(f.binding.Binding); err != nil {
		t.Fatal(err)
	}
	if drained, err := f.core.Drained(f.binding.Binding); err != nil || drained {
		t.Fatal("finite completion bypassed ingestion stop confirmation", drained, err)
	}
	child.command(t, "release-ingestion")
	child.event(t, "ingestion_stopped")
	waitDrainConfirmed(t, f)
	child.command(t, "ingest")
	child.event(t, "ingestion_rejected")
	for path, expected := range map[string]string{
		f.effects:                     "effect\n",
		f.effects + ".ingestion":      "effect\neffect\n",
		f.effects + ".ingestion-stop": "effect\n",
	} {
		body, err := os.ReadFile(path)
		if err != nil || string(body) != expected {
			t.Fatalf("external effects in %s: %q %v", path, body, err)
		}
	}
}

func TestFailedIngestionStopCannotConfirmDrainOrReconnect(t *testing.T) {
	f := newFixture(t, 2)
	child := f.start(t, "run-ingestion-failed")
	child.event(t, "session_started")
	waitAvailable(t, f)
	child.command(t, "ingest")
	child.event(t, "ingested")
	if err := f.core.Drain(f.binding.Binding); err != nil {
		t.Fatal(err)
	}
	child.event(t, "ingestion_stop_requested")
	fault := child.event(t, "fault")
	if !strings.Contains(fault.Error, "injected_ingestion_stop_failure") {
		t.Fatal("ingestion stop failure was hidden", fault)
	}
	reconnect := child.event(t, "reconnect_rejected")
	if !strings.Contains(reconnect.Error, "injected_ingestion_stop_failure") {
		t.Fatal("failed stop was forgotten on reconnection", reconnect)
	}
	child.expectFailure(t)
	if drained, err := f.core.Drained(f.binding.Binding); err != nil || drained {
		t.Fatal("failed ingestion stop confirmed drain", drained, err)
	}
	body, err := os.ReadFile(f.effects + ".ingestion-stop")
	if err != nil || string(body) != "effect\n" {
		t.Fatal("reconnection retried the failed ingestion stop", string(body), err)
	}
}
