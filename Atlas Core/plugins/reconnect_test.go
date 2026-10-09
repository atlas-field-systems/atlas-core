package plugins_test

import (
	"context"
	"testing"
	"time"

	"github.com/atlas-field-systems/atlas-core/plugins"
)

func TestCancellationRetryBeforeReceiptPreservesDrainAtCapacity(t *testing.T) {
	f := newFixture(t, 1)
	child := f.start(t, "hold")
	child.event(t, "ready")
	operation, err := f.core.Submit(context.Background(), request("cancel-before-receipt", `{"value":7}`))
	if err != nil {
		t.Fatal(err)
	}
	child.command(t, "drop-dispatch-response")
	child.event(t, "dispatch_response_dropped")
	waitUnavailable(t, f)
	cancellation, err := f.core.Cancel(context.Background(), datasetID, pluginID, operation.ID)
	if err != nil || cancellation.Status != plugins.CancellationRequested {
		t.Fatal("lost exposure was treated as never dispatched", cancellation, err)
	}
	for range 2 {
		if err := f.core.VerifyReconnect(f.binding.Binding, f.binding.VerifiedProcess); err != nil {
			t.Fatal(err)
		}
		child.command(t, "reconnect")
		child.event(t, "ready")
		child.command(t, "next")
		child.event(t, "cancel_received")
		child.command(t, "disconnect")
		child.event(t, "disconnected")
		waitUnavailable(t, f)
	}
	if err := f.core.Drain(f.binding.Binding); err != nil {
		t.Fatal(err)
	}
	if err := f.core.VerifyReconnect(f.binding.Binding, f.binding.VerifiedProcess); err != nil {
		t.Fatal(err)
	}
	child.command(t, "reconnect")
	child.event(t, "ready")
	child.command(t, "next")
	child.event(t, "cancel_received")
	child.command(t, "next")
	child.event(t, "received")
	child.command(t, "report")
	child.event(t, "acknowledged")
	final := f.wait(t, operation.ID, plugins.Cancelled)
	if final.CancellationID != cancellation.CancellationID || mustJSON(t, final.Execution) != mustJSON(t, operation.Execution) {
		t.Fatal("retry changed cancellation or execution authority", final)
	}
	child.command(t, "next")
	child.event(t, "drain")
	child.command(t, "drained")
	child.event(t, "drained")
	if drained, err := f.core.Drained(f.binding.Binding); err != nil || !drained {
		t.Fatal("repeated cancellation stranded protected drain", drained, err)
	}
	assertEffects(t, f, 0)
}

func TestPartialReadinessPreservesOriginalProcessAuthority(t *testing.T) {
	f := newFixture(t, 1)
	original := f.start(t, "partial-ready")
	original.event(t, "readiness_started")
	if f.core.Available(pluginID) {
		t.Fatal("partial readiness opened admission")
	}
	// Joining the interrupted listener makes the disconnect deterministic,
	// including when readiness has never reached its final page.
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := f.server.Close(ctx); err != nil {
		t.Fatal(err)
	}
	original.command(t, "disconnect")
	original.event(t, "disconnected")
	server, err := f.core.Listen(f.socket)
	if err != nil {
		t.Fatal(err)
	}
	f.server = server
	impostor := f.start(t, "normal")
	if reply := nextEvidenceReply(t, impostor); reply.Event != "fault" || reply.Error != plugins.ErrAuthority.Error() {
		t.Fatal("partial readiness allowed unverified process replacement", reply)
	}
	impostor.expectFailure(t)
	if err := f.core.VerifyReconnect(f.binding.Binding, f.binding.VerifiedProcess); err != nil {
		t.Fatal(err)
	}
	impostor = f.start(t, "normal")
	if reply := nextEvidenceReply(t, impostor); reply.Event != "fault" || reply.Error != "live_receipts_lost" {
		t.Fatal("partial readiness forgot the original live witness", reply)
	}
	impostor.expectFailure(t)
	original.command(t, "reconnect")
	original.event(t, "ready")
	operation, err := f.core.Submit(context.Background(), request("original-after-partial-ready", `{"value":7}`))
	if err != nil {
		t.Fatal(err)
	}
	original.command(t, "next")
	original.event(t, "received")
	original.command(t, "report")
	original.event(t, "acknowledged")
	f.wait(t, operation.ID, plugins.Completed)
	assertEffects(t, f, 1)
}
