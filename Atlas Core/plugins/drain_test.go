package plugins_test

import (
	"context"
	"errors"
	"testing"

	"github.com/atlas-field-systems/atlas-core/plugins"
)

func TestDrainRedeliversLostExposureToSameRuntimeAndPreservesCancellation(t *testing.T) {
	f := newFixture(t, 2)
	child := f.start(t, "hold")
	child.event(t, "ready")
	exposed, err := f.core.Submit(context.Background(), request("exposure-response-lost", `{"value":7}`))
	if err != nil {
		t.Fatal(err)
	}
	unexposed, err := f.core.Submit(context.Background(), request("drain-never-exposed", `{"value":8}`))
	if err != nil {
		t.Fatal(err)
	}
	child.command(t, "drop-dispatch-response")
	child.event(t, "dispatch_response_dropped")
	waitUnavailable(t, f)
	if err := f.core.Drain(f.binding.Binding); err != nil {
		t.Fatal(err)
	}
	cancelled, err := f.core.Cancel(context.Background(), datasetID, pluginID, exposed.ID)
	if err != nil || cancelled.Status != plugins.CancellationRequested {
		t.Fatalf("exposure was not committed before its lost response: %+v %v", cancelled, err)
	}
	if _, err := f.core.Submit(context.Background(), request("after-drain", `{"value":9}`)); !errors.Is(err, plugins.ErrUnavailable) {
		t.Fatal("drain accepted new work", err)
	}
	if err := f.core.VerifyReconnect(f.binding.Binding, f.binding.VerifiedProcess); err != nil {
		t.Fatal(err)
	}
	child.command(t, "reconnect")
	child.event(t, "ready")
	child.command(t, "next")
	child.event(t, "cancel_received")
	child.command(t, "next")
	reply := nextEvidenceReply(t, child)
	if reply.Event == "started" {
		reply = nextEvidenceReply(t, child)
	}
	if reply.Event != "received" || reply.Duplicate {
		t.Fatalf("drain stranded exposure or the discarded response created a receipt: %+v", reply)
	}
	child.command(t, "report")
	child.event(t, "acknowledged")
	final := f.wait(t, exposed.ID, plugins.Cancelled)
	if final.Execution.Binding != exposed.Execution.Binding || final.CancellationID != cancelled.CancellationID {
		t.Fatal("redelivery changed execution identity or cancellation intent", final)
	}
	child.command(t, "next")
	child.event(t, "drain")
	child.command(t, "drained")
	if reply := child.event(t, "error"); reply.Error != "active_work" {
		t.Fatal("never-exposed accepted work was silently finished", reply)
	}
	cancelled, err = f.core.Cancel(context.Background(), datasetID, pluginID, unexposed.ID)
	if err != nil || cancelled.Status != plugins.Cancelled {
		t.Fatalf("drain exposed previously undispatched work: %+v %v", cancelled, err)
	}
	child.command(t, "drained")
	child.event(t, "drained")
	if drained, err := f.core.Drained(f.binding.Binding); err != nil || !drained {
		t.Fatal("finished cancellation did not confirm drain", drained, err)
	}
	assertEffects(t, f, 0)
}

func TestReplacementDrainNeverExposesPendingOrRedispatchesOldExecution(t *testing.T) {
	f := newFixture(t, 2)
	child := f.start(t, "normal")
	child.event(t, "ready")
	exposed, err := f.core.Submit(context.Background(), request("old-exposure", `{"value":7}`))
	if err != nil {
		t.Fatal(err)
	}
	unexposed, err := f.core.Submit(context.Background(), request("replacement-pending", `{"value":8}`))
	if err != nil {
		t.Fatal(err)
	}
	child.command(t, "drop-dispatch-response")
	child.event(t, "dispatch_response_dropped")
	child.kill(t)
	if err := f.core.ConfirmLoss(context.Background(), f.binding.Binding); err != nil {
		t.Fatal(err)
	}
	f.replace(t, "replacement-drain")
	replacement := f.start(t, "normal")
	replacement.event(t, "ready")
	if err := f.core.Drain(f.binding.Binding); err != nil {
		t.Fatal(err)
	}
	replacement.command(t, "accept "+mustJSON(t, exposed.Execution))
	if reply := replacement.event(t, "error"); reply.Error != "invalid_authority" {
		t.Fatal("replacement accepted the old exposed execution", reply)
	}
	replacement.command(t, "next")
	replacement.event(t, "drain")
	interrupted, err := f.core.Read(context.Background(), datasetID, pluginID, exposed.ID)
	if err != nil || interrupted.Status != plugins.Interrupted || mustJSON(t, interrupted.Execution) != mustJSON(t, exposed.Execution) {
		t.Fatalf("replacement rewrote or redispatched old exposure: %+v %v", interrupted, err)
	}
	cancelled, err := f.core.Cancel(context.Background(), datasetID, pluginID, unexposed.ID)
	if err != nil || cancelled.Status != plugins.Cancelled || cancelled.Execution.Binding != f.binding.Binding {
		t.Fatalf("replacement drain exposed new work or lost its reservation: %+v %v", cancelled, err)
	}
	replacement.command(t, "drained")
	replacement.event(t, "drained")
	assertEffects(t, f, 0)
}
