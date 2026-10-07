package plugins

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/atlas-field-systems/atlas-core/plugindispatch"
)

// A focused fault probe complements the separate-process recovery workflow.
// The private listener is accessed only to force a real Accept failure; all
// failure, shutdown and ownership assertions use the component interface.
func TestListenerPermanentFailureNotifiesOwnerBeforeClose(t *testing.T) {
	// Keep socket paths short even under the verifier's owned temporary root.
	root, err := os.MkdirTemp("", "atlas-listener-")
	if err != nil {
		t.Fatal(err)
	}
	var core *Module
	var server *Server
	t.Cleanup(func() {
		if server != nil {
			shutdown, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if err := server.Close(shutdown); err != nil {
				t.Errorf("listener cleanup failed; preserving %s: %v", root, err)
				return
			}
		}
		if core != nil {
			if err := core.Close(); err != nil {
				t.Error(err)
				return
			}
		}
		if err := os.RemoveAll(root); err != nil {
			t.Error(err)
		}
	})
	contract, err := plugindispatch.Load("../../Atlas Protocol/plugin-dispatch.json")
	if err != nil {
		t.Fatal(err)
	}
	core, err = Open(context.Background(), Config{Contract: contract, DatabasePath: filepath.Join(root, "core.sqlite"), DatasetID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", CoreRunID: "run", CoreRelease: "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "private.sock")
	server, err = core.Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := server.listener.SetDeadline(time.Now()); err != nil {
		t.Fatal(err)
	}
	var failure error
	select {
	case failure = <-server.Faults():
		if !errors.Is(failure, os.ErrDeadlineExceeded) {
			t.Fatal("listener notification lost its permanent failure", failure)
		}
	case <-time.After(time.Second):
		t.Fatal("listener failure was not reported before Close")
	}
	shutdown, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := server.Close(shutdown); !errors.Is(err, failure) {
		t.Fatal("observing a listener fault hid it from Close", err)
	}
	replacement, err := core.Listen(path)
	if err != nil {
		t.Fatal("joined faulted listener retained its socket ownership", err)
	}
	server = replacement
	if err := server.Close(shutdown); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-server.Faults():
		t.Fatal("intentional shutdown reported a listener fault", err)
	default:
	}
}
