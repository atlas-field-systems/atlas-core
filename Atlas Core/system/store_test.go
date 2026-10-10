package system_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/atlas-field-systems/atlas-core/coreerr"
	"github.com/atlas-field-systems/atlas-core/system"
)

// These focused checks use real SQLite through the System store's public
// interface. They cover commit-boundary and opening decisions that requests
// cannot reach once the HTTP boundary has already refused them; the S1
// workflows exercise the same rules end to end.

func openStore(t *testing.T, path, release string) *system.Store {
	t.Helper()
	db, err := system.OpenDatabase(context.Background(), path)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	store := system.NewStore(db, release, time.Now, system.NewFaults())
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func setUp(t *testing.T, store *system.Store) {
	t.Helper()
	noModuleFacts := func(*sql.Tx, time.Time) error { return nil }
	if _, err := store.SetUpInstallation(context.Background(), "11111111-1111-4111-8111-111111111111", noModuleFacts); err != nil {
		t.Fatalf("set up installation: %v", err)
	}
}

func recordActivity(store *system.Store, datasetID, actionID string) (string, error) {
	return store.Commit(context.Background(), datasetID, "test.activity", func(tx *system.Tx) error {
		tx.Record(system.Activity{ActionID: actionID, Action: "test.action", TargetKind: "test", TargetID: actionID, Outcome: "recorded"})
		return nil
	})
}

func activityIDs(t *testing.T, store *system.Store) []string {
	t.Helper()
	records, err := store.ListActivity(context.Background())
	if err != nil {
		t.Fatalf("list activity: %v", err)
	}
	ids := make([]string, 0, len(records))
	for _, record := range records {
		ids = append(ids, record.ActionID)
	}
	return ids
}

func TestCommitRejectsObsoleteDatasetWithoutEffect(t *testing.T) {
	ctx := context.Background()
	store := openStore(t, filepath.Join(t.TempDir(), "core.sqlite"), "test-release")
	setUp(t, store)
	first, err := store.Open(ctx, "")
	if err != nil {
		t.Fatalf("open first Dataset: %v", err)
	}
	if cursor, err := recordActivity(store, first.DatasetID, "a1"); err != nil || cursor != "1" {
		t.Fatalf("first commit = %q, %v; want cursor 1", cursor, err)
	}
	second, err := store.Open(ctx, "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatalf("open Reset Dataset: %v", err)
	}
	if second.DatasetID == first.DatasetID {
		t.Fatal("Reset reused the old Dataset identity")
	}
	_, err = recordActivity(store, first.DatasetID, "late")
	rejection, ok := coreerr.As(err)
	if !ok || rejection.Code != "dataset_mismatch" {
		t.Fatalf("obsolete commit error = %v; want dataset_mismatch", err)
	}
	if ids := activityIDs(t, store); len(ids) != 0 {
		t.Fatalf("new Dataset activity = %v; want none from the old Dataset or the rejected commit", ids)
	}
	if cursor, err := recordActivity(store, second.DatasetID, "b1"); err != nil || cursor != "1" {
		t.Fatalf("first commit after Reset = %q, %v; want cursor 1 with nothing consumed by the rejection", cursor, err)
	}
	reopened, err := store.Open(ctx, "22222222-2222-4222-8222-222222222222")
	if err != nil || reopened.DatasetID != second.DatasetID {
		t.Fatalf("repeated opening with the established Reset = %v, %v; want the retained Dataset", reopened, err)
	}
	if ids := activityIDs(t, store); len(ids) != 1 || ids[0] != "b1" {
		t.Fatalf("activity after reopening = %v; want work after the Reset preserved", ids)
	}
}

func TestOpenRefusesAnotherWritingRelease(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "core.sqlite")
	writer := openStore(t, path, "release-a")
	setUp(t, writer)
	established, err := writer.Open(ctx, "")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := recordActivity(writer, established.DatasetID, "kept"); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	other := openStore(t, path, "release-b")
	if _, err := other.Open(ctx, ""); !errors.Is(err, system.ErrReleaseMismatch) {
		t.Fatalf("open with another release = %v; want ErrReleaseMismatch", err)
	}
	if err := other.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	again := openStore(t, path, "release-a")
	reopened, err := again.Open(ctx, "")
	if err != nil || reopened.DatasetID != established.DatasetID {
		t.Fatalf("reopen with the writing release = %v, %v; want the retained Dataset", reopened, err)
	}
	if ids := activityIDs(t, again); len(ids) != 1 || ids[0] != "kept" {
		t.Fatalf("activity after refusal = %v; want it unconverted and unwiped", ids)
	}
}

func TestFaultBeforeCommitLeavesNothing(t *testing.T) {
	ctx := context.Background()
	db, err := system.OpenDatabase(ctx, filepath.Join(t.TempDir(), "core.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	faults := system.NewFaults()
	store := system.NewStore(db, "test-release", time.Now, faults)
	t.Cleanup(func() { _ = store.Close() })
	setUp(t, store)
	opened, err := store.Open(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := faults.ArmBeforeCommit("test.activity", 1); err != nil {
		t.Fatal(err)
	}
	if _, err := recordActivity(store, opened.DatasetID, "lost"); !errors.Is(err, system.ErrInjected) {
		t.Fatalf("armed commit error = %v; want ErrInjected", err)
	}
	if ids := activityIDs(t, store); len(ids) != 0 {
		t.Fatalf("activity after injected failure = %v; want none", ids)
	}
	if cursor, err := recordActivity(store, opened.DatasetID, "kept"); err != nil || cursor != "1" {
		t.Fatalf("commit after failure = %q, %v; want cursor 1", cursor, err)
	}
}

func TestJournalImportAddsEachActionOnce(t *testing.T) {
	ctx := context.Background()
	store := openStore(t, filepath.Join(t.TempDir(), "core.sqlite"), "test-release")
	setUp(t, store)
	if _, err := store.Open(ctx, ""); err != nil {
		t.Fatal(err)
	}
	journal := t.TempDir()
	write := func() {
		entry, err := json.Marshal(system.JournalEntry{ActionID: "setup-1", Action: "installation.setup", TargetKind: "installation", Outcome: "completed", OccurredAt: time.Now()})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(journal, system.JournalFile), append(entry, '\n'), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write()
	if imported, err := store.ImportJournal(ctx, journal); err != nil || imported != 1 {
		t.Fatalf("first import = %d, %v", imported, err)
	}
	// A crash after the import committed but before the journal was removed
	// leaves the same entries to import again.
	write()
	if _, err := store.ImportJournal(ctx, journal); err != nil {
		t.Fatalf("repeated import: %v", err)
	}
	if ids := activityIDs(t, store); len(ids) != 1 || ids[0] != "setup-1" {
		t.Fatalf("activity after repeated import = %v; want one record", ids)
	}
	if _, err := os.Stat(filepath.Join(journal, system.JournalFile)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("journal after import: %v; want it removed", err)
	}
}
