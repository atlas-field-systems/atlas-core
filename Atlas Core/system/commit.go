package system

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/atlas-field-systems/atlas-core/system/generated/storage"
)

// Change is one public resource image or deletion in a commit batch.
type change struct {
	kind, id string
	version  int64
	deleted  bool
	image    []byte
}

// Actor is the authenticated caller, or the identified local administrator,
// recorded with activity.
type Actor struct {
	Kind    string `json:"kind"`
	ID      string `json:"id"`
	Display string `json:"display"`
}

// Activity is one attributed action. Summaries carry safe facts only.
type Activity struct {
	ActionID   string
	Actor      Actor
	Action     string
	TargetKind string
	TargetID   string
	OccurredAt time.Time
	Outcome    string
	Summary    map[string]any
}

// Tx is one write commit. Modules use the SQL transaction through their own
// generated queries and hand public changes and activity to the commit.
type Tx struct {
	ctx      context.Context
	tx       *sql.Tx
	store    *Store
	now      time.Time
	seq      int64
	dataset  string
	changes  []change
	activity []Activity
}

// SQL is the commit's transaction for module-owned queries.
func (t *Tx) SQL() *sql.Tx { return t.tx }

// Now is the Core time of this commit.
func (t *Tx) Now() time.Time { return t.now }

// DatasetID is the Dataset this commit writes.
func (t *Tx) DatasetID() string { return t.dataset }

// Seq allocates this commit's sequence on first use. Resource versions use it,
// so every changed resource version increases with commit order.
func (t *Tx) Seq() (int64, error) {
	if t.seq != 0 {
		return t.seq, nil
	}
	last, err := storage.New(t.tx).LastCommit(t.ctx)
	if err != nil {
		return 0, fmt.Errorf("allocate commit sequence: %w", err)
	}
	t.seq = last + 1
	return t.seq, nil
}

// Publish appends a resource's final public image to the commit's changes.
func (t *Tx) Publish(kind, id string, version int64, image any) error {
	encoded, err := json.Marshal(image)
	if err != nil {
		return fmt.Errorf("encode %s change: %w", kind, err)
	}
	t.changes = append(t.changes, change{kind: kind, id: id, version: version, image: encoded})
	return nil
}

// PublishDeletion appends a resource deletion.
func (t *Tx) PublishDeletion(kind, id string, version int64) {
	t.changes = append(t.changes, change{kind: kind, id: id, version: version, deleted: true})
}

// Record appends attributed activity to the commit.
func (t *Tx) Record(activity Activity) {
	if activity.OccurredAt.IsZero() {
		activity.OccurredAt = t.now
	}
	t.activity = append(t.activity, activity)
}

// Cursor formats a commit sequence as the public committed cursor.
func Cursor(seq int64) string { return strconv.FormatInt(seq, 10) }

// Commit runs fn as one Dataset write commit. It rejects an obsolete Dataset
// before any module logic and appends changes and activity atomically with
// the module's mutation. When fn allocates no sequence and records nothing,
// the commit has no effect and its cursor is empty: a replay supplies the
// cursor of its original commit.
func (s *Store) Commit(ctx context.Context, datasetID, operation string, fn func(*Tx) error) (cursor string, err error) {
	current := s.DatasetID()
	if current == "" {
		return "", errors.New("no Dataset is open")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", fmt.Errorf("begin %s commit: %w", operation, err)
	}
	defer func() {
		if err != nil {
			err = errors.Join(err, rollback(tx))
		}
	}()
	// Recheck inside the write lock, after authentication and before any
	// retry claim or effect.
	if !sameIdentifier(datasetID, current) {
		return "", DatasetMismatch(current)
	}
	commit := &Tx{ctx: ctx, tx: tx, store: s, now: s.Now(), dataset: current}
	if err := fn(commit); err != nil {
		return "", err
	}
	if len(commit.changes) > 0 || len(commit.activity) > 0 {
		if _, err := commit.Seq(); err != nil {
			return "", err
		}
	}
	if commit.seq != 0 {
		if err := commit.append(ctx, operation); err != nil {
			return "", err
		}
		cursor = Cursor(commit.seq)
	}
	if err := s.faults.beforeCommit(operation); err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", fmt.Errorf("commit %s: %w", operation, err)
	}
	return cursor, nil
}

func (t *Tx) append(ctx context.Context, operation string) error {
	queries := storage.New(t.tx)
	if err := queries.InsertCommit(ctx, storage.InsertCommitParams{Seq: t.seq, CommittedAt: formatTime(t.now), Operation: operation}); err != nil {
		return fmt.Errorf("record commit: %w", err)
	}
	for ordinal, item := range t.changes {
		image := sql.NullString{String: string(item.image), Valid: !item.deleted}
		deleted := int64(0)
		if item.deleted {
			deleted = 1
		}
		if err := queries.InsertChange(ctx, storage.InsertChangeParams{
			CommitSeq: t.seq, Ordinal: int64(ordinal), ResourceKind: item.kind, ResourceID: item.id,
			Version: item.version, Deleted: deleted, Image: image,
		}); err != nil {
			return fmt.Errorf("record %s change: %w", item.kind, err)
		}
	}
	for _, activity := range t.activity {
		if err := insertActivity(ctx, queries, t.seq, activity); err != nil {
			return err
		}
	}
	return nil
}

func insertActivity(ctx context.Context, queries *storage.Queries, seq int64, activity Activity) error {
	summary := activity.Summary
	if summary == nil {
		summary = map[string]any{}
	}
	encoded, err := json.Marshal(summary)
	if err != nil {
		return fmt.Errorf("encode activity summary: %w", err)
	}
	if _, err := queries.InsertActivity(ctx, storage.InsertActivityParams{
		ActionID: activity.ActionID, CommitSeq: seq, ActorKind: activity.Actor.Kind, ActorID: activity.Actor.ID,
		ActorDisplay: activity.Actor.Display, Action: activity.Action, TargetKind: activity.TargetKind,
		TargetID: activity.TargetID, OccurredAt: formatTime(activity.OccurredAt), Outcome: activity.Outcome,
		Summary: string(encoded),
	}); err != nil {
		return fmt.Errorf("record activity: %w", err)
	}
	return nil
}

// Read runs fn in a read transaction bound to the requested Dataset, so a
// delayed read or page continuation cannot cross a Reset unnoticed.
func (s *Store) Read(ctx context.Context, datasetID string, fn func(*sql.Tx) error) (err error) {
	current := s.DatasetID()
	if current == "" {
		return errors.New("no Dataset is open")
	}
	if !sameIdentifier(datasetID, current) {
		return DatasetMismatch(current)
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return fmt.Errorf("begin read: %w", err)
	}
	defer func() { err = errors.Join(err, rollback(tx)) }()
	return fn(tx)
}

// InstallationRead reads installation-lifetime state outside any Dataset
// precondition, for authentication and discovery.
func (s *Store) InstallationRead(ctx context.Context, fn func(*sql.Tx) error) (err error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return fmt.Errorf("begin installation read: %w", err)
	}
	defer func() { err = errors.Join(err, rollback(tx)) }()
	return fn(tx)
}
