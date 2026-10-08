package plugins_test

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/atlas-field-systems/atlas-core/plugindispatch"
	"github.com/atlas-field-systems/atlas-core/plugins"
)

func TestCapabilitiesBelongToTheirInstalledPluginAndVersion(t *testing.T) {
	f := newFixtureConfigured(t, 4, func(cfg *plugins.Config) {
		first := cfg.Releases[0].Capabilities[0]
		first.ID = "lookup"
		second := first
		second.InputVersion = "2"
		cfg.Releases[0].Capabilities = append(cfg.Releases[0].Capabilities, first)
		other := cfg.Releases[0]
		other.PluginID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
		other.Capabilities = []plugindispatch.Capability{second}
		cfg.Releases = append(cfg.Releases, other)
		third := other
		third.PluginID = "ffffffff-ffff-4fff-8fff-ffffffffffff"
		first.OutputSchema = []byte(`{"const":{"value":99}}`)
		third.Capabilities = []plugindispatch.Capability{first}
		cfg.Releases = append(cfg.Releases, third)
	})
	if err := f.core.ConfirmLoss(context.Background(), f.binding.Binding); err != nil {
		t.Fatal(err)
	}
	f.binding.Capabilities = []plugindispatch.CapabilityIdentity{{ID: "lookup", InputVersion: "1"}}
	f.replace(t, "lookup-A")
	a := f.start(t, "run-lookup-v1")
	a.event(t, "session_started")
	first := f.binding
	work := f.work
	f.binding.Binding.PluginID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	f.binding.Binding.PrincipalID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
	f.work = filepath.Join(f.root, "work-B")
	f.binding.Capabilities = []plugindispatch.CapabilityIdentity{{ID: "lookup", InputVersion: "2"}}
	f.replace(t, "lookup-B")
	b := f.start(t, "run-lookup-v2")
	b.event(t, "session_started")
	second := f.binding
	f.binding.Binding.PluginID = "ffffffff-ffff-4fff-8fff-ffffffffffff"
	f.binding.Capabilities = []plugindispatch.CapabilityIdentity{{ID: "lookup", InputVersion: "1"}}
	f.work = filepath.Join(f.root, "work-C")
	f.replace(t, "lookup-C")
	c := f.start(t, "run-lookup-alternate")
	c.event(t, "session_started")
	third := f.binding
	f.binding, f.work = first, work
	waitChannels := func() {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			if f.core.Available(first.Binding.PluginID) && f.core.Available(second.Binding.PluginID) && f.core.Available(third.Binding.PluginID) {
				return
			}
			time.Sleep(time.Millisecond)
		}
		t.Fatal("both Plugin channels did not become available")
	}
	waitChannels()
	wrong := request("wrong-version", `{"value":7}`)
	wrong.CapabilityID, wrong.InputVersion = "lookup", "2"
	if _, err := f.core.Submit(context.Background(), wrong); !errors.Is(err, plugins.ErrUnsupported) {
		t.Fatalf("unsupported version accepted by Plugin A: %v", err)
	}
	operations, err := f.core.List(context.Background(), datasetID, pluginID, 10, 0)
	if err != nil || len(operations) != 0 {
		t.Fatalf("rejected version created an Operation: %+v %v", operations, err)
	}
	for index, host := range []plugins.RuntimeBinding{first, second, third} {
		input := request("supported", `{"value":7}`)
		input.PluginID, input.CapabilityID = host.Binding.PluginID, "lookup"
		input.InputVersion = []string{"1", "2", "1"}[index]
		accepted, err := f.core.Submit(context.Background(), input)
		if err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(5 * time.Second)
		for {
			value, err := f.core.Read(context.Background(), datasetID, input.PluginID, accepted.ID)
			if err != nil {
				t.Fatal(err)
			}
			if value.Status == plugins.Completed {
				if string(value.Outcome.Result) != []string{`{"value":14}`, `{"value":14}`, `{"value":99}`}[index] {
					t.Fatalf("Plugin %d result: %+v", index, value.Outcome)
				}
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("Plugin %d did not complete its supported version", index)
			}
			time.Sleep(time.Millisecond)
		}
	}
	waitChannels()
}
