package plugins_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/atlas-field-systems/atlas-core/plugindispatch"
	"github.com/atlas-field-systems/atlas-core/pluginruntime"
	"github.com/atlas-field-systems/atlas-core/plugins"
)

func TestUnseenStaleReportCannotRewriteOutcomeOrEffects(t *testing.T) {
	f := newFixture(t, 1)
	child := f.start(t, "hold")
	child.event(t, "ready")
	operation, err := f.core.Submit(context.Background(), request("ordered-evidence", `{"value":7}`))
	if err != nil {
		t.Fatal(err)
	}
	child.command(t, "next")
	child.event(t, "received")
	child.event(t, "started")
	child.command(t, "progress-new")
	child.event(t, "progress")
	child.command(t, "progress")
	committed := *child.event(t, "progress").Evidence
	child.command(t, "known-effect-save")
	latest := *child.event(t, "progress").Evidence
	stale := plugindispatch.CloneEvidence(latest)
	stale.Sequence = "1"
	stale.Outcome = &plugindispatch.Outcome{Status: "failed", Error: json.RawMessage(`{"code":"delayed_failure"}`)}
	stale.Revision = plugindispatch.Revision(stale)
	child.command(t, "report-evidence "+mustJSON(t, stale))
	if reply := nextEvidenceReply(t, child); reply.Event != "error" || reply.Error != "stale_report" {
		t.Fatal("unseen lower sequence was accepted", reply)
	}
	unchanged := f.wait(t, operation.ID, plugins.InProgress)
	if unchanged.Outcome != nil || len(unchanged.KnownEffects) != 0 || string(unchanged.Progress) != `{"percent":50}` {
		t.Fatal("stale report changed committed evidence", unchanged)
	}
	latest.Progress = json.RawMessage(`{"percent":80}`)
	latest.Revision = plugindispatch.Revision(latest)
	child.command(t, "report-evidence "+mustJSON(t, latest))
	child.event(t, "reported_evidence")
	child.command(t, "report-evidence "+mustJSON(t, committed))
	child.event(t, "reported_evidence")
	value := f.wait(t, operation.ID, plugins.InProgress)
	if string(value.Progress) != `{"percent":80}` || len(value.KnownEffects) != 1 || value.KnownEffects[0].ID != "fixture-known" {
		t.Fatal("exact older retry regressed progress or new evidence was lost", value)
	}
	committed.Progress = json.RawMessage(`{"percent":10}`)
	committed.Revision = plugindispatch.Revision(committed)
	child.command(t, "report-evidence "+mustJSON(t, committed))
	if reply := nextEvidenceReply(t, child); reply.Event != "error" || reply.Error != "report_conflict" {
		t.Fatal("changed committed sequence was accepted", reply)
	}
	child.command(t, "release")
	child.event(t, "released")
	child.command(t, "report")
	child.event(t, "acknowledged")
	completed := f.wait(t, operation.ID, plugins.Completed)
	if string(completed.Outcome.Result) != `{"value":14}` || len(completed.KnownEffects) != 1 {
		t.Fatal("a rejected stale report blocked the genuine later outcome", completed)
	}
	assertEffects(t, f, 2)
}

func TestDeletedRecordedOutputKeepsAttributionAndAllowsTerminalDrain(t *testing.T) {
	objects := t.TempDir()
	output := plugindispatch.Output{Kind: "object", ID: "dddddddd-dddd-4ddd-8ddd-dddddddddddd"}
	path := filepath.Join(objects, output.ID)
	if err := os.WriteFile(path, []byte("optional published content"), 0o600); err != nil {
		t.Fatal(err)
	}
	f := newFixtureConfigured(t, 1, func(cfg *plugins.Config) {
		cfg.ValidateOutput = func(ctx context.Context, output plugindispatch.Output) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			if output.Kind != "object" {
				return errors.New("unsupported fixture resource")
			}
			_, err := os.Stat(filepath.Join(objects, output.ID))
			return err
		}
	})
	child := f.start(t, "hold")
	child.event(t, "ready")
	operation, err := f.core.Submit(context.Background(), request("deletable-output", `{"value":7}`))
	if err != nil {
		t.Fatal(err)
	}
	child.command(t, "next")
	child.event(t, "received")
	child.event(t, "started")
	child.command(t, "record-update "+mustJSON(t, pluginruntime.Update{Outputs: []plugindispatch.Output{output}}))
	child.event(t, "reported_update")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	child.command(t, "record-update "+mustJSON(t, pluginruntime.Update{Progress: json.RawMessage(`{"percent":75}`)}))
	accepted := *child.event(t, "reported_update").Evidence
	value := f.wait(t, operation.ID, plugins.InProgress)
	if len(value.KnownOutputs) != 1 || value.KnownOutputs[0] != output || string(value.Progress) != `{"percent":75}` {
		t.Fatal("deleted output attribution or later progress was lost", value)
	}
	invalid := plugindispatch.CloneEvidence(accepted)
	invalid.Sequence = "3"
	invalid.Outcome = &plugindispatch.Outcome{Status: "failed", Error: json.RawMessage(`{"code":"invalid_new_output"}`)}
	invalid.Outputs = append(invalid.Outputs, plugindispatch.Output{Kind: "object", ID: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"})
	invalid.Revision = plugindispatch.Revision(invalid)
	child.command(t, "report-evidence "+mustJSON(t, invalid))
	if reply := nextEvidenceReply(t, child); reply.Event != "error" || reply.Error != "invalid_output" {
		t.Fatal("new unresolved output was accepted", reply)
	}
	value = f.wait(t, operation.ID, plugins.InProgress)
	if value.Outcome != nil || len(value.KnownOutputs) != 1 || value.KnownOutputs[0] != output {
		t.Fatal("invalid output partially committed its terminal report", value)
	}
	if err := f.core.Drain(f.binding.Binding); err != nil {
		t.Fatal(err)
	}
	child.command(t, "release")
	child.event(t, "released")
	child.command(t, "report")
	child.event(t, "acknowledged")
	completed := f.wait(t, operation.ID, plugins.Completed)
	if string(completed.Outcome.Result) != `{"value":14}` || len(completed.KnownOutputs) != 1 || completed.KnownOutputs[0] != output {
		t.Fatal("terminal report lost historical output attribution", completed)
	}
	child.command(t, "drained")
	child.event(t, "drained")
	if drained, err := f.core.Drained(f.binding.Binding); err != nil || !drained {
		t.Fatal("deleted optional output blocked drain", err)
	}
	assertEffects(t, f, 1)
}

func TestEvidenceProvesSameRuntimeAcceptanceBeforeReadinessCompletes(t *testing.T) {
	for _, proof := range []string{"progress-before-reconnect", "effects-during-readiness", "terminal-during-readiness"} {
		t.Run(proof, func(t *testing.T) {
			f := newFixture(t, 1)
			child := f.start(t, "lost-ack-hold")
			child.event(t, "ready")
			operation, err := f.core.Submit(context.Background(), request("evidence-without-dispatch-ack", `{"value":7}`))
			if err != nil {
				t.Fatal(err)
			}
			child.command(t, "next")
			child.event(t, "received")
			child.event(t, "started")
			var evidence plugindispatch.Evidence
			switch proof {
			case "progress-before-reconnect":
				child.command(t, "progress-new")
				evidence = *child.event(t, "progress").Evidence
				child.command(t, "report-evidence "+mustJSON(t, evidence))
				child.event(t, "reported_evidence")
			case "effects-during-readiness":
				child.command(t, "known-effect-save")
				evidence = *child.event(t, "progress").Evidence
			case "terminal-during-readiness":
				child.command(t, "release")
				child.event(t, "released")
				child.command(t, "saved")
				evidence = *child.event(t, "saved").Evidence
			}
			child.command(t, "disconnect")
			child.event(t, "disconnected")
			waitUnavailable(t, f)
			if err := f.core.VerifyReconnect(f.binding.Binding, f.binding.VerifiedProcess); err != nil {
				t.Fatal(err)
			}
			child.command(t, "begin-reconnect-without-receipts")
			child.event(t, "readiness_started")
			// New evidence and an exact committed retry both pass through the
			// incomplete session before its final receipt inventory arrives.
			child.command(t, "report-evidence "+mustJSON(t, evidence))
			child.event(t, "reported_evidence")
			child.command(t, "ready-without-receipts")
			if reply := nextEvidenceReply(t, child); reply.Event != "error" || reply.Error != "live_receipts_lost" {
				t.Fatal("evidence-backed acceptance allowed an omitted live receipt", reply)
			}
			if f.core.Available(pluginID) {
				t.Fatal("missing receipt opened fresh admission")
			}
			child.command(t, "next")
			if reply := nextEvidenceReply(t, child); reply.Event != "error" || reply.Error != "plugin_unavailable" {
				t.Fatal("incomplete readiness allowed redispatch", reply)
			}
			child.command(t, "report-evidence "+mustJSON(t, evidence))
			child.event(t, "reported_evidence")
			child.command(t, "ready-complete")
			child.event(t, "ready")
			if !f.core.Available(pluginID) {
				t.Fatal("the unchanged runtime's valid receipt did not reopen admission")
			}
			child.command(t, "next")
			child.event(t, "idle")
			if proof != "terminal-during-readiness" {
				child.command(t, "release")
				child.event(t, "released")
			}
			child.command(t, "report")
			child.event(t, "acknowledged")
			completed := f.wait(t, operation.ID, plugins.Completed)
			if string(completed.Outcome.Result) != `{"value":14}` {
				t.Fatal(completed)
			}
			if proof == "effects-during-readiness" {
				if len(completed.KnownEffects) != 1 || completed.KnownEffects[0].ID != "fixture-known" {
					t.Fatal("readiness lost known-effect evidence", completed)
				}
				assertEffects(t, f, 2)
			} else {
				assertEffects(t, f, 1)
			}
		})
	}
}

func nextEvidenceReply(t *testing.T, child *child) childEvent {
	t.Helper()
	select {
	case reply := <-child.events:
		return reply
	case <-child.done:
		t.Fatal("Plugin exited before evidence reply")
	case <-time.After(3 * time.Second):
		t.Fatal("evidence reply timed out")
	}
	return childEvent{}
}
