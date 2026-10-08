package plugins_test

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
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
func TestHostAndReadinessRequireExactInstalledCapabilityVersion(t *testing.T) {
	f := newFixture(t, 1)
	if err := f.core.ConfirmLoss(context.Background(), f.binding.Binding); err != nil {
		t.Fatal(err)
	}
	f.binding.Binding.RuntimeGeneration = "replacement"
	f.binding.Token = "replacement-private-token"
	f.binding.VerifiedProcess = "replacement-verified-process"
	wrong := f.binding
	wrong.Capabilities = []plugindispatch.CapabilityIdentity{{ID: "double", InputVersion: "2"}}
	if err := f.core.BindRuntime(context.Background(), wrong); !errors.Is(err, plugins.ErrUnsupported) {
		t.Fatal("host advertised a version absent from its release", err)
	}
	wrong = f.binding
	wrong.Release.Version = "unregistered-release"
	if err := f.core.BindRuntime(context.Background(), wrong); !errors.Is(err, plugins.ErrUnsupported) {
		t.Fatal("host borrowed another release's schemas", err)
	}
	wrong = f.binding
	wrong.Binding.PluginID = uuid.NewString()
	if err := f.core.BindRuntime(context.Background(), wrong); !errors.Is(err, plugins.ErrUnsupported) {
		t.Fatal("host borrowed another installation's schemas", err)
	}
	if err := f.core.BindRuntime(context.Background(), f.binding); err != nil {
		t.Fatal("rejected declarations consumed runtime authority", err)
	}
	ready := plugindispatch.Ready{Release: f.binding.Release, ConfigurationRevision: f.binding.ConfigurationRevision, ContractVersion: f.contract.Version, ReceiptCapacity: f.binding.ReceiptCapacity, Capabilities: []plugindispatch.CapabilityIdentity{{ID: "double", InputVersion: "2"}}, ReceiptsRetained: true, Receipts: []plugindispatch.Receipt{}, Complete: true, LiveWitness: uuid.NewString()}
	response := privateRequest(t, f, plugindispatch.Request{Kind: "ready", Binding: f.binding.Binding, Token: f.binding.Token, Ready: &ready})
	if response.Kind != "error" || response.Error != "readiness_mismatch" || f.core.Available(pluginID) {
		t.Fatal("readiness dropped the input-version binding", response)
	}
	child := f.start(t, "normal")
	child.event(t, "ready")
	for _, field := range []string{"capability", "version"} {
		input := request("empty-"+field, `{"value":7}`)
		if field == "capability" {
			input.CapabilityID = ""
		} else {
			input.InputVersion = ""
		}
		if _, err := f.core.Submit(context.Background(), input); !errors.Is(err, plugins.ErrUnsupported) {
			t.Fatalf("empty %s changed installed-capability rejection: %v", field, err)
		}
	}
	if operations, err := f.core.List(context.Background(), datasetID, pluginID, 10, 0); err != nil || len(operations) != 0 {
		t.Fatalf("unsupported empty capability/version created work: %+v %v", operations, err)
	}
	if _, err := f.core.Submit(context.Background(), request("valid", `{"value":7}`)); err != nil {
		t.Fatal("a rejected readiness poisoned a supported channel", err)
	}
}

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
				unexpected, err := f.core.Listen(f.socket)
				if err == nil {
					t.Error("incomplete close released socket ownership while its report writer remained")
					finish, cancel := context.WithTimeout(context.Background(), time.Second)
					if err := unexpected.Close(finish); err != nil {
						t.Error(err)
					}
					cancel()
				}
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

func TestSocketOwnershipProtectsLiveAndUnrelatedEntries(t *testing.T) {
	f := newFixture(t, 1)
	if unexpected, err := f.core.Listen(f.socket); err == nil {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		unexpected.Close(ctx)
		t.Fatal("competing listener replaced live Core")
	}
	foreignPath := filepath.Join(f.root, "foreign.sock")
	foreign, err := net.Listen("unix", foreignPath)
	if err != nil {
		t.Fatal(err)
	}
	defer foreign.Close()
	if unexpected, err := f.core.Listen(foreignPath); err == nil {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		unexpected.Close(ctx)
		t.Fatal("listener replaced live nonparticipating owner")
	}
	connection, err := net.DialTimeout("unix", foreignPath, time.Second)
	if err != nil {
		t.Fatal("foreign listener no longer reachable", err)
	}
	connection.Close()
	file := filepath.Join(f.root, "unrelated")
	if err := os.WriteFile(file, []byte("retain"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{file, file + ".symlink"} {
		if path != file {
			if err := os.Symlink(file, path); err != nil {
				t.Fatal(err)
			}
		}
		if unexpected, err := f.core.Listen(path); err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			unexpected.Close(ctx)
			cancel()
			t.Fatal("listener replaced unrelated entry", path)
		}
	}
	content, err := os.ReadFile(file)
	if err != nil || string(content) != "retain" {
		t.Fatal("listener changed unrelated file", string(content), err)
	}
}
