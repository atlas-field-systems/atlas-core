package hostmanagement_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/atlas-field-systems/atlas-core/hostmanagement"
	"github.com/google/uuid"
)

// This subprocess preserves the actual long-lived event stream and scanner
// overflow. Its delayed termination also exercises the watcher's cleanup owner.
func TestDockerEventProcess(t *testing.T) {
	for index, argument := range os.Args {
		if argument != "--atlas-event-process" {
			continue
		}
		marker := os.Args[index+1]
		stopping := make(chan os.Signal, 1)
		signal.Notify(stopping, syscall.SIGTERM)
		defer signal.Stop(stopping)
		if err := os.WriteFile(marker, []byte(strconv.Itoa(os.Getpid())), 0600); err != nil {
			t.Fatal(err)
		}
		fmt.Fprintln(os.Stdout, strings.Repeat("x", 9000))
		<-stopping
		if err := os.WriteFile(marker+".stopping", []byte("stopping"), 0600); err != nil {
			t.Fatal(err)
		}
		time.Sleep(time.Hour)
		return
	}
}

func TestManagerReturnsEventFailureAndReapsTheProcess(t *testing.T) {
	for _, cancelDuringCleanup := range []bool{false, true} {
		t.Run(fmt.Sprintf("cancel_during_cleanup=%v", cancelDuringCleanup), func(t *testing.T) {
			root, err := os.MkdirTemp("", "s1-watch-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := os.RemoveAll(root); err != nil {
					t.Error(err)
				}
			})
			marker := filepath.Join(root, "event-ready")
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			manager, err := hostmanagement.New(hostmanagement.Options{
				InstallationID: uuid.NewString(), Root: filepath.Join(root, "installation"),
				RecoveryRoot: filepath.Join(root, "recovery"), RuntimeRoot: filepath.Join(root, "runtime"),
				Image: "event-probe", BindAddress: "127.0.0.1", Port: 8443, OwnerUID: os.Getuid(),
				Docker: hostmanagement.Command{Program: executable, Prefix: []string{"-test.run=^TestDockerEventProcess$", "--", "--atlas-event-process", marker}},
			})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			finished := make(chan error, 1)
			go func() { finished <- manager.Serve(ctx) }()
			var joined bool
			defer func() {
				cancel()
				if !joined {
					select {
					case <-finished:
					case <-time.After(5 * time.Second):
						t.Error("event process cleanup did not finish")
					}
				}
				if err := manager.Close(); err != nil {
					t.Error(err)
				}
			}()
			pidText := waitEventMarker(t, marker)
			pid, err := strconv.Atoi(string(pidText))
			if err != nil {
				t.Fatal(err)
			}
			if cancelDuringCleanup {
				waitEventMarker(t, marker+".stopping")
				cancel()
			}
			select {
			case err := <-finished:
				joined = true
				var failure *hostmanagement.Failure
				if !errors.As(err, &failure) || failure.Code != "docker_event_stream_unavailable" {
					t.Fatalf("parser failure was not reported: %v", err)
				}
				if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
					t.Fatalf("event process remains after Serve returned: %v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("scanner overflow did not terminate event supervision")
			}
		})
	}
}

func waitEventMarker(t *testing.T, path string) []byte {
	t.Helper()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		data, err := os.ReadFile(path)
		if err == nil && len(data) != 0 {
			return data
		}
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Fatal(err)
		}
		select {
		case <-deadline.C:
			t.Fatalf("event process did not publish %s", filepath.Base(path))
		case <-ticker.C:
		}
	}
}
