package plugins

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"path/filepath"
	"testing"

	"github.com/google/uuid"

	"github.com/atlas-field-systems/atlas-core/core/internal/api"
	"github.com/atlas-field-systems/atlas-core/core/internal/datasets"
	"github.com/atlas-field-systems/atlas-core/core/internal/storage"
)

// Core retains an attempt before it dispatches it. A cancellation that wins
// the short window before dispatch must cancel the attempt outright, and the
// dispatcher must then never send it. The window is too short to hit from
// outside, so the retained attempt is created without dispatching it.
func TestCancelBeforeDispatchCancelsAndIsNeverSent(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	installation, err := storage.Open(ctx, filepath.Join(dir, "installation.sqlite"), storage.Installation)
	if err != nil {
		t.Fatal(err)
	}
	operational, err := storage.Open(ctx, filepath.Join(dir, "operational.sqlite"), storage.Operational)
	if err != nil {
		t.Fatal(err)
	}
	dataset, err := datasets.Open(ctx, operational, "test")
	if err != nil {
		t.Fatal(err)
	}
	manifest := Manifest{ID: "sample", Release: "1", Image: "sample", Port: 1, Capabilities: []Capability{{Name: "sample.work", InputSchema: json.RawMessage(`{"type":"object"}`)}}}
	registry := NewRegistry(installation)
	// Nothing listens here; a dispatch attempt would fail rather than be sent.
	if err := registry.Install(ctx, manifest, "http://127.0.0.1:1", "secret"); err != nil {
		t.Fatal(err)
	}
	service := New(installation, operational, dataset, slog.New(slog.NewTextHandler(io.Discard, nil)))
	defer service.Close()
	plugin, err := registry.plugin(ctx, "sample")
	if err != nil {
		t.Fatal(err)
	}
	submission := api.OperationSubmission{DatasetId: dataset.Current().ID, SubmissionId: uuid.New(), Capability: "sample.work", Input: map[string]any{}}
	facts, input, err := submissionFacts("sample", submission)
	if err != nil {
		t.Fatal(err)
	}
	retained, err := service.create(ctx, plugin, submission, facts, input)
	if err != nil {
		t.Fatal(err)
	}

	canceled, err := service.Cancel(ctx, "sample", uuid.MustParse(retained.ID))
	if err != nil {
		t.Fatal(err)
	}
	if canceled.Status != api.OperationStatusCanceled {
		t.Fatalf("status after cancel = %s, want canceled", canceled.Status)
	}
	if err := service.deliver(ctx, plugin, retained); err != nil {
		t.Fatalf("dispatch after cancel tried to send: %v", err)
	}
	after, err := service.Operation(ctx, "sample", uuid.MustParse(retained.ID))
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != api.OperationStatusCanceled {
		t.Fatalf("status after dispatch = %s, want canceled", after.Status)
	}
}
