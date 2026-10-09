package plugins_test

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/atlas-field-systems/atlas-core/plugindispatch"
	"github.com/atlas-field-systems/atlas-core/plugins"
	"github.com/google/uuid"
)

func TestBearerTokenCannotCrossInstallationsOrPriorRuntimeBindings(t *testing.T) {
	const otherPluginID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	f := newFixtureConfigured(t, 1, func(cfg *plugins.Config) {
		other := cfg.Releases[0]
		other.PluginID = otherPluginID
		cfg.Releases = append(cfg.Releases, other)
	})
	first, work := f.binding, f.work
	other := first
	other.Binding.PluginID, other.Binding.PrincipalID = otherPluginID, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
	other.Binding.RuntimeGeneration, other.VerifiedProcess = "runtime-other", "host-verified-other"
	if err := f.core.BindRuntime(context.Background(), other); !errors.Is(err, plugins.ErrAuthority) {
		t.Fatal("one bearer token authorized two installations", err)
	}
	other.Token = "distinct-other-private-token"
	if err := f.core.BindRuntime(context.Background(), other); err != nil {
		t.Fatal("rejected token reuse consumed the new binding", err)
	}
	a := f.start(t, "normal")
	a.event(t, "ready")
	f.binding, f.work = other, filepath.Join(f.root, "other-work")
	b := f.start(t, "normal")
	b.event(t, "ready")
	for _, participant := range []struct {
		binding plugins.RuntimeBinding
		child   *child
	}{{first, a}, {other, b}} {
		input := request("accepted", `{"value":7}`)
		input.PluginID = participant.binding.Binding.PluginID
		operation, err := f.core.Submit(context.Background(), input)
		if err != nil {
			t.Fatal(err)
		}
		participant.child.command(t, "next")
		participant.child.event(t, "received")
		participant.child.command(t, "report")
		participant.child.event(t, "acknowledged")
		confirmed, err := f.core.Read(context.Background(), datasetID, input.PluginID, operation.ID)
		if err != nil || confirmed.Status != plugins.Completed || string(confirmed.Outcome.Result) != `{"value":14}` {
			t.Fatalf("distinct authority did not execute its own work: %+v %v", confirmed, err)
		}
	}
	a.kill(t)
	if err := f.core.ConfirmLoss(context.Background(), first.Binding); err != nil {
		t.Fatal(err)
	}
	f.binding, f.work = first, work
	f.binding.Binding.RuntimeGeneration, f.binding.VerifiedProcess = "runtime-replacement", "host-verified-replacement"
	for _, token := range []string{first.Token, other.Token} {
		f.binding.Token = token
		if err := f.core.BindRuntime(context.Background(), f.binding); !errors.Is(err, plugins.ErrAuthority) {
			t.Fatal("replacement reused a prior binding's bearer token", err)
		}
	}
	f.binding.Token = "fresh-replacement-private-token"
	if err := f.core.BindRuntime(context.Background(), f.binding); err != nil {
		t.Fatal(err)
	}
	replacement := f.start(t, "normal")
	replacement.event(t, "ready")
	if !f.core.Available(pluginID) || !f.core.Available(otherPluginID) {
		t.Fatal("rejected authority poisoned an independently valid channel")
	}
	assertEffects(t, f, 2)
}

func TestReadinessCapacityMustMatchTrustedBoundBeforeAdmission(t *testing.T) {
	f := newFixture(t, 2)
	wrong := f.binding
	wrong.ReceiptCapacity = f.contract.Limits.MaxReceipts + 1
	if err := f.core.BindRuntime(context.Background(), wrong); !errors.Is(err, plugins.ErrLimit) {
		t.Fatal("host receipt capacity exceeded the canonical bound", err)
	}
	for _, capacity := range []int{1, 3, f.contract.Limits.MaxReceipts + 1} {
		ready := plugindispatch.Ready{Release: f.binding.Release, ConfigurationRevision: f.binding.ConfigurationRevision,
			ContractVersion: f.contract.Version, ReceiptCapacity: capacity, Capabilities: f.binding.Capabilities,
			ReceiptsRetained: true, Receipts: []plugindispatch.Receipt{}, Complete: true, LiveWitness: uuid.NewString()}
		response := privateRequest(t, f, plugindispatch.Request{Kind: "ready", Binding: f.binding.Binding, Token: f.binding.Token, Ready: &ready})
		if response.Kind != "error" || response.Error != "readiness_mismatch" || f.core.Available(pluginID) {
			t.Fatalf("capacity %d opened admission under a different trusted bound: %+v", capacity, response)
		}
		if _, err := f.core.Submit(context.Background(), request("before-matching-capacity", `{"value":7}`)); !errors.Is(err, plugins.ErrUnavailable) {
			t.Fatal("mismatched capacity accepted work", err)
		}
	}
	child := f.start(t, "normal")
	child.event(t, "ready")
	for _, id := range []string{"one", "two"} {
		if _, err := f.core.Submit(context.Background(), request(id, `{"value":7}`)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.core.Submit(context.Background(), request("beyond-bound", `{"value":7}`)); !errors.Is(err, plugins.ErrLimit) {
		t.Fatal("Core accepted work beyond the matching live-receipt bound", err)
	}
	for range 2 {
		child.command(t, "next")
		child.event(t, "received")
		child.command(t, "report")
		child.event(t, "acknowledged")
	}
	if _, err := f.core.Submit(context.Background(), request("beyond-bound", `{"value":7}`)); !errors.Is(err, plugins.ErrLimit) {
		t.Fatal("terminal ACK released a live duplicate receipt slot", err)
	}
	operations, err := f.core.List(context.Background(), datasetID, pluginID, 10, 0)
	if err != nil || len(operations) != 2 || operations[0].Status != plugins.Completed || operations[1].Status != plugins.Completed {
		t.Fatalf("rejected capacity created new queued work: %+v %v", operations, err)
	}
	assertEffects(t, f, 2)
}
