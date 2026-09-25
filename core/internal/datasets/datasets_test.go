package datasets_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/atlas-field-systems/atlas-core/core/internal/datasets"
	"github.com/atlas-field-systems/atlas-core/core/internal/storage"
)

// A Dataset written by one Core release must not be served by another; that
// needs the explicit update and Reset flow. Reaching this from outside would
// need two Core builds, so it is proven here against real storage.
func TestDatasetFromAnotherReleaseRefusesToOpen(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "operational.sqlite"), storage.Operational)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := datasets.Open(ctx, db, "0.1.0"); err != nil {
		t.Fatal(err)
	}
	if _, err := datasets.Open(ctx, db, "0.2.0"); err == nil {
		t.Fatal("a Dataset written by 0.1.0 opened under 0.2.0")
	}
}
