package writecommit_test

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/atlas-field-systems/atlas-core/writecommit"
)

func TestCompleteBatchBoundRejectsBeforeDurability(t *testing.T) {
	ctx := context.Background()
	boundary, err := writecommit.Open(ctx, writecommit.Config{Path: filepath.Join(t.TempDir(), "core.sqlite"), WritingRelease: "test-release", DatasetFingerprint: "test-dataset", InstallationFingerprint: "test-installation"})
	if err != nil {
		t.Fatal(err)
	}
	defer boundary.Close()
	boundary.SetMaximumJSONBytes(256)
	_, err = boundary.Apply(ctx, "", func(c *writecommit.Commit) error { return boundary.Setup(ctx, c, "installation", "dataset", "{}") })
	if err != nil {
		t.Fatal(err)
	}
	before, err := boundary.Inspect(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, err = boundary.Apply(ctx, "dataset", func(c *writecommit.Commit) error {
		c.Record("caller", "change", "resource")
		return c.Changed("entity", "resource", strings.Repeat("x", 250))
	})
	if !errors.Is(err, writecommit.ErrLimit) {
		t.Fatalf("oversized batch: %v", err)
	}
	after, err := boundary.Inspect(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatal("bounded rejection committed position")
	}
	err = boundary.Read(ctx, "dataset", func(c *writecommit.Commit) error {
		counts, err := boundary.Journal(ctx, c)
		if err == nil && (counts.Changes != 0 || counts.Activities != 0) {
			t.Fatal("bounded rejection committed public effects")
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = boundary.Apply(ctx, "dataset", func(c *writecommit.Commit) error { return c.Changed("entity", "resource", "small") })
	if err != nil {
		t.Fatal(err)
	}
}

func TestRetainedOpenRefusesReleaseAndSchemaChangesWithoutChangingDataset(t *testing.T) {
	ctx := context.Background()
	cfg := writecommit.Config{Path: filepath.Join(t.TempDir(), "core.sqlite"), WritingRelease: "release1", DatasetFingerprint: "dataset1", InstallationFingerprint: "installation1"}
	boundary, err := writecommit.Open(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	_, err = boundary.Apply(ctx, "", func(c *writecommit.Commit) error {
		return boundary.Setup(ctx, c, "installation", "retained-dataset", "{}")
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = boundary.Close(); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name     string
		mutate   func(*writecommit.Config)
		expected error
	}{
		{"release", func(c *writecommit.Config) { c.WritingRelease = "release2" }, writecommit.ErrWritingRelease},
		{"Dataset schema", func(c *writecommit.Config) { c.DatasetFingerprint = "dataset2" }, writecommit.ErrSchemaDrift},
		{"Installation schema", func(c *writecommit.Config) { c.InstallationFingerprint = "installation2" }, writecommit.ErrSchemaDrift},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			candidate := cfg
			test.mutate(&candidate)
			opened, err := writecommit.Open(ctx, candidate)
			if opened != nil {
				opened.Close()
			}
			if !errors.Is(err, test.expected) {
				t.Fatalf("incompatible opening %v", err)
			}
		})
	}
	boundary, err = writecommit.Open(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer boundary.Close()
	retained, err := boundary.Inspect(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if retained.DatasetID != "retained-dataset" || retained.WritingRelease != "release1" || retained.DatasetFingerprint != "dataset1" {
		t.Fatal("refused opening changed retained state")
	}
}
