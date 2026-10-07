package plugins_test

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	goruntime "runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/atlas-field-systems/atlas-core/plugindispatch"
	"github.com/atlas-field-systems/atlas-core/plugins"
	"github.com/google/uuid"
)

// These focused socket probes cover malformed combinations without inventing
// capability execution. They still exercise the production private adapter.
func TestPrivateBoundaryRejectsStaleAuthorityAndMalformedMessages(t *testing.T) {
	f := newFixture(t, 1)
	for _, field := range []string{"token", "dataset", "core_run", "runtime", "principal", "installation"} {
		t.Run(field, func(t *testing.T) {
			request := plugindispatch.Request{Kind: "next", Binding: f.binding.Binding, Token: f.binding.Token}
			switch field {
			case "token":
				request.Token = "old-private-fixture-token"
			case "dataset":
				request.Binding.DatasetID = uuid.NewString()
			case "core_run":
				request.Binding.CoreRunID = "old-run"
			case "runtime":
				request.Binding.RuntimeGeneration = "old-runtime"
			case "principal":
				request.Binding.PrincipalID = uuid.NewString()
			case "installation":
				request.Binding.PluginID = uuid.NewString()
			}
			response := privateRequest(t, f, request)
			if response.Kind != "error" || response.Error != "invalid_authority" {
				t.Fatal(response)
			}
		})
	}
	raw, _ := json.Marshal(plugindispatch.Request{Kind: "next", Binding: f.binding.Binding, Token: f.binding.Token})
	malformed := []string{
		strings.Replace(string(raw), `"kind":"next"`, `"kind":"next","kind":"ready"`, 1),
		strings.Replace(string(raw), `"kind":"next"`, `"k\u0069nd":"next","kind":"next"`, 1),
		strings.Replace(string(raw), `"kind":"next"`, `"kind":"\ud800"`, 1),
		strings.TrimSuffix(string(raw), "}") + `,"unknown":1}`,
		string(raw) + " {}",
	}
	for i, body := range malformed {
		t.Run(string(rune('a'+i)), func(t *testing.T) {
			connection := privateConnection(t, f)
			if err := binary.Write(connection, binary.BigEndian, uint32(len(body))); err != nil {
				t.Fatal(err)
			}
			if _, err := connection.Write([]byte(body)); err != nil {
				t.Fatal(err)
			}
			var response plugindispatch.Response
			if err := f.contract.Receive(connection, &response); err != nil {
				t.Fatal(err)
			}
			if response.Error != "invalid_message" {
				t.Fatal(response)
			}
		})
	}
	connection := privateConnection(t, f)
	if err := binary.Write(connection, binary.BigEndian, uint32(f.contract.Limits.MessageBytes+1)); err != nil {
		t.Fatal(err)
	}
	var response plugindispatch.Response
	if err := f.contract.Receive(connection, &response); err != nil {
		t.Fatal(err)
	}
	if response.Error != "invalid_message" {
		t.Fatal(response)
	}
	if f.core.Available(pluginID) {
		t.Fatal("invalid boundary opened admission")
	}
	if _, err := f.core.Submit(context.Background(), request("old", `{"value":1}`)); err == nil {
		t.Fatal("unready runtime accepted submission")
	}
}
func privateConnection(t *testing.T, f *fixture) net.Conn {
	t.Helper()
	connection, err := net.DialTimeout("unix", f.socket, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { connection.Close() })
	if err := connection.SetDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	return connection
}
func privateRequest(t *testing.T, f *fixture, request plugindispatch.Request) plugindispatch.Response {
	t.Helper()
	connection := privateConnection(t, f)
	if err := f.contract.Send(connection, request); err != nil {
		t.Fatal(err)
	}
	var response plugindispatch.Response
	if err := f.contract.Receive(connection, &response); err != nil {
		t.Fatal(err)
	}
	return response
}

func TestServerCloseCancelsOwnedReportsAndBoundsIncompleteJoin(t *testing.T) {
	for _, cooperative := range []bool{true, false} {
		t.Run(fmt.Sprint(cooperative), func(t *testing.T) {
			entered := make(chan struct{})
			release := make(chan struct{})
			var once sync.Once
			f := newFixtureConfigured(t, 1, func(config *plugins.Config) {
				config.ValidateOutput = func(ctx context.Context, _ plugindispatch.Output) error {
					close(entered)
					if cooperative {
						<-ctx.Done()
						return ctx.Err()
					}
					<-release
					return errors.New("controlled resolver refusal")
				}
			})
			defer once.Do(func() { close(release) })
			child := f.start(t, "normal")
			child.event(t, "ready")
			operation, err := f.core.Submit(context.Background(), request("closing", `{"value":1}`))
			if err != nil {
				t.Fatal(err)
			}
			child.command(t, "next")
			child.event(t, "received")
			child.command(t, "saved")
			evidence := *child.event(t, "saved").Evidence
			evidence.Outputs = []plugindispatch.Output{{Kind: "object", ID: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"}}
			evidence.Revision = plugindispatch.Revision(evidence)
			child.command(t, "report-evidence "+mustJSON(t, evidence))
			select {
			case <-entered:
			case <-time.After(3 * time.Second):
				t.Fatal("report never reached output validator")
			}
			shutdown, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
			err = f.server.Close(shutdown)
			cancel()
			if cooperative && err != nil {
				t.Fatal(err)
			}
			if !cooperative && !errors.Is(err, context.DeadlineExceeded) {
				t.Fatal("uncooperative owner incorrectly joined", err)
			}
			if !cooperative {
				before := goruntime.NumGoroutine()
				expired, expire := context.WithCancel(context.Background())
				expire()
				for range 64 {
					if err := f.server.Close(expired); !errors.Is(err, context.Canceled) {
						t.Fatal("incomplete repeated close lost its deadline", err)
					}
				}
				if growth := goruntime.NumGoroutine() - before; growth > 4 {
					t.Errorf("repeated incomplete close accumulated %d goroutines", growth)
				}
			}
			once.Do(func() { close(release) })
			finish, cancelFinish := context.WithTimeout(context.Background(), time.Second)
			defer cancelFinish()
			if err := f.server.Close(finish); err != nil {
				t.Fatal(err)
			}
			child.kill(t)
			pending := f.wait(t, operation.ID, plugins.Pending)
			if pending.Outcome != nil {
				t.Fatal("cancelled report committed", pending)
			}
			assertEffects(t, f, 1)
		})
	}
}
