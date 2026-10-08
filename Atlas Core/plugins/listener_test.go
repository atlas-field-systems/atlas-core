package plugins_test

import (
	"context"
	"errors"
	"net"
	"os"
	"testing"
	"time"

	"github.com/atlas-field-systems/atlas-core/plugindispatch"
	"github.com/atlas-field-systems/atlas-core/plugins"
)

func TestListenerRecoversAfterFileDescriptorExhaustion(t *testing.T) {
	f, owner := isolatedListener(t)
	owner.command(t, "exhaust-descriptors")
	owner.event(t, "descriptors_exhausted")
	probeExhaustedListener(t, f)
	owner.command(t, "restore-descriptors")
	owner.event(t, "descriptors_restored")
	child := f.start(t, "normal")
	child.event(t, "ready")
	submission := request("after-descriptor-recovery", `{"value":7}`)
	owner.command(t, "submit "+mustJSON(t, submission))
	accepted := owner.event(t, "accepted").Operation
	if accepted == nil {
		t.Fatal("recovered listener did not accept an Operation")
	}
	child.command(t, "next")
	child.event(t, "received")
	child.command(t, "report")
	child.event(t, "acknowledged")
	owner.command(t, "submit "+mustJSON(t, submission))
	completed := owner.event(t, "accepted").Operation
	if completed == nil || completed.ID != accepted.ID || completed.Status != plugins.Completed || completed.Outcome == nil || string(completed.Outcome.Result) != `{"value":14}` {
		t.Fatal("recovered listener did not preserve the completed result", completed)
	}
	assertEffects(t, f, 1)
}

func TestListenerCloseInterruptsDescriptorExhaustionRetry(t *testing.T) {
	f, owner := isolatedListener(t)
	owner.command(t, "exhaust-descriptors")
	owner.event(t, "descriptors_exhausted")
	probeExhaustedListener(t, f)
	owner.command(t, "close-listener")
	owner.event(t, "listener_closed")
	if _, err := os.Lstat(f.socket); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("closed listener did not release its socket", err)
	}
	owner.command(t, "restore-descriptors")
	owner.event(t, "descriptors_restored")
}

func isolatedListener(t *testing.T) (*fixture, *child) {
	t.Helper()
	f := newFixture(t, 2)
	shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := f.server.Close(shutdown); err != nil {
		t.Fatal(err)
	}
	if err := f.core.Close(); err != nil {
		t.Fatal(err)
	}
	owner := f.startProcess(t, "normal", true)
	owner.event(t, "ready")
	return f, owner
}

// A connected request that cannot receive any response establishes that the
// kernel woke Accept while the isolated owner had no descriptor capacity.
func probeExhaustedListener(t *testing.T, f *fixture) {
	t.Helper()
	connection, err := net.DialTimeout("unix", f.socket, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if err := connection.SetDeadline(time.Now().Add(250 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if err := f.contract.Send(connection, plugindispatch.Request{Kind: "next", Binding: f.binding.Binding, Token: f.binding.Token}); err != nil {
		t.Fatal(err)
	}
	var response plugindispatch.Response
	var timeout net.Error
	if err := f.contract.Receive(connection, &response); !errors.As(err, &timeout) || !timeout.Timeout() {
		t.Fatal("listener did not encounter the descriptor limit", response, err)
	}
}
