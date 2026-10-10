package system

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/atlas-field-systems/atlas-core/system/generated/storage"
)

// JournalEntry is one local management action recorded while Core was
// stopped. The host manager appends entries; Core imports them once.
type JournalEntry struct {
	ActionID   string         `json:"action_id"`
	Actor      Actor          `json:"actor"`
	Action     string         `json:"action"`
	TargetKind string         `json:"target_kind"`
	TargetID   string         `json:"target_id"`
	OccurredAt time.Time      `json:"occurred_at"`
	Outcome    string         `json:"outcome"`
	Summary    map[string]any `json:"summary"`
}

// JournalFile is the local activity journal's name within its directory.
const JournalFile = "activity-journal.jsonl"

// ImportJournal imports the local activity journal inside one write commit,
// then removes it. A repeated import adds no duplicate records because
// activity is keyed by action identity.
func (s *Store) ImportJournal(ctx context.Context, directory string) (imported int, err error) {
	path := filepath.Join(directory, JournalFile)
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("open local activity journal: %w", err)
	}
	var entries []JournalEntry
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64<<10), 1<<20)
	for scanner.Scan() {
		if len(scanner.Bytes()) == 0 {
			continue
		}
		var entry JournalEntry
		if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
			return 0, errors.Join(fmt.Errorf("decode local activity journal entry: %w", err), file.Close())
		}
		entries = append(entries, entry)
	}
	if err := errors.Join(scanner.Err(), file.Close()); err != nil {
		return 0, fmt.Errorf("read local activity journal: %w", err)
	}
	if len(entries) > 0 {
		if _, err := s.Commit(ctx, s.DatasetID(), "activity.import_journal", func(tx *Tx) error {
			for _, entry := range entries {
				tx.Record(Activity(entry))
			}
			return nil
		}); err != nil {
			return 0, err
		}
	}
	// Remove only after the import committed.
	if err := os.Remove(path); err != nil {
		return 0, fmt.Errorf("remove imported local activity journal: %w", err)
	}
	return len(entries), nil
}

// RecordLocal records a local management action while Core runs.
func (s *Store) RecordLocal(ctx context.Context, activity Activity) error {
	_, err := s.Commit(ctx, s.DatasetID(), "activity.local", func(tx *Tx) error {
		tx.Record(activity)
		return nil
	})
	return err
}

// ActivityRecord is a stored activity entry for local inspection.
type ActivityRecord struct {
	ActionID   string         `json:"action_id"`
	CommitSeq  int64          `json:"commit_seq"`
	Actor      Actor          `json:"actor"`
	Action     string         `json:"action"`
	TargetKind string         `json:"target_kind"`
	TargetID   string         `json:"target_id"`
	OccurredAt time.Time      `json:"occurred_at"`
	Outcome    string         `json:"outcome"`
	Summary    map[string]any `json:"summary"`
}

// ListActivity returns the current Dataset's activity in commit order. The
// complete public activity read belongs to S5; this serves local inspection.
func (s *Store) ListActivity(ctx context.Context) ([]ActivityRecord, error) {
	var records []ActivityRecord
	err := s.Read(ctx, s.DatasetID(), func(tx *sql.Tx) error {
		rows, err := storage.New(tx).ListActivity(ctx)
		if err != nil {
			return fmt.Errorf("list activity: %w", err)
		}
		for _, row := range rows {
			record := ActivityRecord{
				ActionID: row.ActionID, CommitSeq: row.CommitSeq,
				Actor:  Actor{Kind: row.ActorKind, ID: row.ActorID, Display: row.ActorDisplay},
				Action: row.Action, TargetKind: row.TargetKind, TargetID: row.TargetID,
				OccurredAt: parseTime(row.OccurredAt), Outcome: row.Outcome,
			}
			if err := json.Unmarshal([]byte(row.Summary), &record.Summary); err != nil {
				return fmt.Errorf("decode activity summary: %w", err)
			}
			records = append(records, record)
		}
		return nil
	})
	return records, err
}
