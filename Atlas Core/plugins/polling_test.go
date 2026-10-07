package plugins_test

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/atlas-field-systems/atlas-core/plugins"
)

func TestRetainedHistoryDoesNotBlockCurrentRuntimePolling(t *testing.T) {
	f := newFixture(t, 1)
	child := f.start(t, "normal")
	child.event(t, "ready")
	const historySize = 1024
	input := `{"value":3,"padding":"` + strings.Repeat("x", 30000) + `"}`
	setup := time.Now()
	for index := range historySize {
		operation, err := f.core.Submit(context.Background(), request(fmt.Sprintf("history-%d", index), input))
		if err != nil {
			t.Fatal(err)
		}
		cancelled, err := f.core.Cancel(context.Background(), datasetID, pluginID, operation.ID)
		if err != nil || cancelled.Status != plugins.Cancelled {
			t.Fatalf("history cancellation: %+v %v", cancelled, err)
		}
		// Keep the manual channel alive without dispatching or repeatedly
		// scanning the growing history during setup. Core rejects this phase.
		if (index+1)%32 == 0 {
			child.command(t, "drained")
			if response := child.event(t, "error"); response.Error != "not_draining" {
				t.Fatalf("setup channel check: %+v", response)
			}
		}
	}
	t.Logf("retained %d cancelled Operations through Submit/Cancel in %s", historySize, time.Since(setup))
	operation, err := f.core.Submit(context.Background(), request("current-work", `{"value":7}`))
	if err != nil {
		t.Fatal(err)
	}
	poll := time.Now()
	defer func() { t.Logf("poll workflow elapsed: %s", time.Since(poll)) }()
	child.command(t, "next")
	child.event(t, "received")
	t.Logf("current runtime dispatch after %d retained Operations: %s", historySize, time.Since(poll))
	child.command(t, "report")
	child.event(t, "acknowledged")
	completed := f.wait(t, operation.ID, plugins.Completed)
	if string(completed.Outcome.Result) != `{"value":14}` {
		t.Fatalf("current result: %+v", completed)
	}
	if effects, err := os.ReadFile(f.effects); err != nil || string(effects) != "effect\n" {
		t.Fatalf("cancelled history was executed: %q %v", effects, err)
	}
	child.command(t, "next")
	child.event(t, "idle")
	if err := f.core.Drain(f.binding.Binding); err != nil {
		t.Fatal(err)
	}
	child.command(t, "drained")
	child.event(t, "drained")
	if drained, err := f.core.Drained(f.binding.Binding); err != nil || !drained {
		t.Fatalf("retained terminal history blocked drain: %t %v", drained, err)
	}
}
