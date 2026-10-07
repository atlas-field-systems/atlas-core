package plugins_test

import (
	"context"
	"encoding/json"
	"strconv"
	"testing"
	"time"

	"github.com/atlas-field-systems/atlas-core/plugindispatch"
	"github.com/atlas-field-systems/atlas-core/plugins"
)

func TestReportCapacityPreservesFinalOutcomeAndDrain(t *testing.T) {
	for _, status := range []plugins.Status{plugins.Completed, plugins.Failed, plugins.Cancelled} {
		t.Run(string(status), func(t *testing.T) {
			f := newFixture(t, 1)
			mode := "hold"
			if status == plugins.Failed {
				mode = "hold-failed"
			}
			child := f.start(t, mode)
			child.event(t, "ready")
			operation, err := f.core.Submit(context.Background(), request("bounded-reports", `{"value":7}`))
			if err != nil {
				t.Fatal(err)
			}
			child.command(t, "next")
			child.event(t, "received")
			child.event(t, "started")
			var last plugindispatch.Evidence
			for range f.contract.Limits.MaxReportRevisions - 1 {
				child.command(t, "progress")
				last = *child.event(t, "progress").Evidence
			}
			child.command(t, "progress")
			quotaReply := func() childEvent {
				t.Helper()
				select {
				case event := <-child.events:
					return event
				case <-time.After(3 * time.Second):
					t.Fatal("quota reply timed out")
					return childEvent{}
				}
			}
			if event := quotaReply(); event.Event != "error" || event.Error != "resource_limit" {
				t.Fatal("nonterminal reports consumed the final revision", event)
			}
			// The receiver independently reserves the final slot, even when
			// the sender bypasses its own quota check.
			last.Sequence = strconv.Itoa(f.contract.Limits.MaxReportRevisions)
			last.Progress = json.RawMessage(`{"percent":51}`)
			last.Revision = plugindispatch.Revision(last)
			child.command(t, "report-evidence "+mustJSON(t, last))
			if event := quotaReply(); event.Event != "error" || event.Error != "resource_limit" {
				t.Fatal("Core allowed progress to consume its final slot", event)
			}
			if err := f.core.Drain(f.binding.Binding); err != nil {
				t.Fatal(err)
			}
			if status == plugins.Cancelled {
				if _, err := f.core.Cancel(context.Background(), datasetID, pluginID, operation.ID); err != nil {
					t.Fatal(err)
				}
				child.command(t, "next")
				child.event(t, "cancel_received")
			} else {
				child.command(t, "release")
				child.event(t, "released")
			}
			child.command(t, "report")
			child.event(t, "acknowledged")
			final := f.wait(t, operation.ID, status)
			if final.Outcome == nil || final.Outcome.Status != string(status) {
				t.Fatal("final outcome did not commit", final)
			}
			if status == plugins.Completed && string(final.Outcome.Result) != `{"value":14}` {
				t.Fatal(final)
			}
			if status == plugins.Failed && string(final.Outcome.Error) != `{"code":"fixture_failure"}` {
				t.Fatal(final)
			}
			child.command(t, "drained")
			child.event(t, "drained")
			if drained, err := f.core.Drained(f.binding.Binding); err != nil || !drained {
				t.Fatal("terminal report did not permit confirmed drain", err)
			}
		})
	}
}
