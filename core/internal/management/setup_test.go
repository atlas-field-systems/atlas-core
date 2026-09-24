package management_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/atlas-field-systems/atlas-core/core/internal/management"
)

// Setup can stop after retaining the first credential but before storing its
// verifier. Rerunning Setup must finish with that credential, because the
// operator may already have copied it.
func TestSetupInterruptedAfterRetainingFirstKeyFinishesWithIt(t *testing.T) {
	ctx := context.Background()
	installation := management.Installation{Root: t.TempDir()}
	retained := "atlas_AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"
	if err := os.MkdirAll(installation.SetupDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(installation.SetupDir(), "first-key"), []byte(retained+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	key, err := installation.Setup(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if key != retained {
		t.Fatalf("Setup issued a new credential instead of finishing with the retained one")
	}
	if _, err := installation.Setup(ctx); err == nil {
		t.Fatal("a second Setup must not replace the first credential")
	}
}
