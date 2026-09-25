// Package changes owns the ordered log of committed resource changes that
// snapshots, replay and the feed read.
package changes

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"github.com/atlas-field-systems/atlas-core/core/internal/api"
	"github.com/atlas-field-systems/atlas-core/core/internal/changes/internal/db"
	"github.com/atlas-field-systems/atlas-core/core/internal/pagination"
	"github.com/atlas-field-systems/atlas-core/core/internal/problem"
	"github.com/atlas-field-systems/atlas-core/core/internal/signal"
)

// DefaultRetention is how many recent changes stay replayable. A change keeps
// a full resource state, so this bounds retained replay while giving
// clients hours of replay at typical report rates. Clients that fall further
// behind rebuild from a snapshot.
const DefaultRetention = 50_000

// cursorList names change cursors in the pagination codec.
const cursorList = "changes"

var (
	errExpired      = problem.Gone("cursor_expired", "The retained change log no longer covers this cursor; load a new snapshot.")
	errFutureCursor = problem.Invalid("invalid_cursor", "The cursor is ahead of the change log.")
)

// IsExpired reports whether err means the cursor fell behind retention.
func IsExpired(err error) bool { return errors.Is(err, errExpired) }

type position struct {
	Sequence int64 `json:"s"`
}

// Log is the Dataset's change log.
type Log struct {
	queries   *db.Queries
	cursors   pagination.Codec
	dataset   uuid.UUID
	retention int64
	commits   *signal.Broadcast
}

func New(operational *sql.DB, dataset uuid.UUID, retention int) *Log {
	return &Log{
		queries:   db.New(operational),
		cursors:   pagination.NewCodec(dataset),
		dataset:   dataset,
		retention: int64(retention),
		commits:   signal.NewBroadcast(),
	}
}

// Append records an Entity state in the caller's transaction and returns
// the change's sequence. Commit the transaction with Commit.
func (l *Log) Append(ctx context.Context, tx *sql.Tx, kind api.EntityChangeKind, entity api.Entity) (int64, error) {
	encoded, err := json.Marshal(entity)
	if err != nil {
		return 0, fmt.Errorf("encode change of Entity %s: %w", entity.Id, err)
	}
	queries := l.queries.WithTx(tx)
	sequence, err := queries.InsertChange(ctx, db.InsertChangeParams{ResourceID: entity.Id.String(), Kind: string(kind), Entity: string(encoded), ResourceType: "entity"})
	if err != nil {
		return 0, fmt.Errorf("append change of Entity %s: %w", entity.Id, err)
	}
	if err := queries.PruneChanges(ctx, sequence-l.retention); err != nil {
		return 0, fmt.Errorf("prune change log: %w", err)
	}
	return sequence, nil
}

// AppendTask records a Task's public state in the same transaction as its mutation.
func (l *Log) AppendTask(ctx context.Context, tx *sql.Tx, kind api.EntityChangeKind, task api.Task) (int64, error) {
	encoded, err := json.Marshal(task)
	if err != nil {
		return 0, fmt.Errorf("encode change of Task %s: %w", task.Id, err)
	}
	queries := l.queries.WithTx(tx)
	sequence, err := queries.InsertChange(ctx, db.InsertChangeParams{ResourceID: task.Id.String(), Kind: string(kind), Entity: "{}", ResourceType: "task", Task: sql.NullString{String: string(encoded), Valid: true}})
	if err != nil {
		return 0, fmt.Errorf("append change of Task %s: %w", task.Id, err)
	}
	if err := queries.PruneChanges(ctx, sequence-l.retention); err != nil {
		return 0, fmt.Errorf("prune change log: %w", err)
	}
	return sequence, nil
}

// Commit commits a transaction that appended changes and wakes followers.
func (l *Log) Commit(tx *sql.Tx) error {
	if err := tx.Commit(); err != nil {
		return err
	}
	l.commits.Notify()
	return nil
}

// Committed returns a channel closed at the next commit. Take it before
// reading, so a commit between the read and the wait is not missed.
func (l *Log) Committed() <-chan struct{} { return l.commits.Next() }

// Latest returns the newest sequence, or 0 for an empty log.
func (l *Log) Latest(ctx context.Context) (int64, error) {
	sequence, err := l.queries.LatestSequence(ctx)
	if err != nil {
		return 0, fmt.Errorf("read latest change: %w", err)
	}
	return sequence, nil
}

// Cursor returns the replay cursor positioned after sequence.
func (l *Log) Cursor(sequence int64) (string, error) {
	return l.cursors.Encode(cursorList, position{Sequence: sequence})
}

// Since returns up to limit changes after cursor, in sequence order.
func (l *Log) Since(ctx context.Context, cursor string, limit int) (api.ChangePage, error) {
	var after position
	if err := l.cursors.Decode(cursor, cursorList, &after); err != nil {
		return api.ChangePage{}, err
	}
	if err := l.checkRetained(ctx, after.Sequence); err != nil {
		return api.ChangePage{}, err
	}
	rows, err := l.queries.ListChangesAfter(ctx, db.ListChangesAfterParams{Sequence: after.Sequence, Limit: int64(limit)})
	if err != nil {
		return api.ChangePage{}, fmt.Errorf("list changes: %w", err)
	}
	page := api.ChangePage{DatasetId: l.dataset, Changes: make([]api.EntityChange, 0, len(rows)), Cursor: cursor}
	for _, row := range rows {
		change, err := l.decode(row)
		if err != nil {
			return api.ChangePage{}, err
		}
		page.Changes = append(page.Changes, change)
	}
	if len(rows) > 0 {
		page.Cursor, err = l.Cursor(rows[len(rows)-1].Sequence)
	}
	return page, err
}

func (l *Log) checkRetained(ctx context.Context, after int64) error {
	latest, err := l.Latest(ctx)
	if err != nil {
		return err
	}
	if after > latest {
		return errFutureCursor
	}
	oldest, err := l.queries.OldestSequence(ctx)
	if err != nil {
		return fmt.Errorf("read oldest change: %w", err)
	}
	if oldest > 0 && after < oldest-1 {
		return errExpired
	}
	return nil
}

func (l *Log) decode(row db.Change) (api.EntityChange, error) {
	change := api.EntityChange{
		DatasetId:    l.dataset,
		Sequence:     row.Sequence,
		ResourceType: api.EntityChangeResourceType(row.ResourceType),
		Kind:         api.EntityChangeKind(row.Kind),
	}
	switch change.ResourceType {
	case api.EntityChangeResourceTypeEntity:
		var entity api.Entity
		if err := json.Unmarshal([]byte(row.Entity), &entity); err != nil {
			return api.EntityChange{}, fmt.Errorf("decode Entity change %d: %w", row.Sequence, err)
		}
		entity.ChangeSequence = row.Sequence
		change.ResourceId, change.Entity = entity.Id, &entity
	case api.EntityChangeResourceTypeTask:
		var task api.Task
		if !row.Task.Valid {
			return api.EntityChange{}, fmt.Errorf("Task change %d has no Task", row.Sequence)
		}
		if err := json.Unmarshal([]byte(row.Task.String), &task); err != nil {
			return api.EntityChange{}, fmt.Errorf("decode Task change %d: %w", row.Sequence, err)
		}
		task.ChangeSequence = row.Sequence
		if task.CreatedSequence == 0 {
			task.CreatedSequence = row.Sequence
		}
		change.ResourceId, change.Task = task.Id, &task
	default:
		return api.EntityChange{}, fmt.Errorf("unknown change resource type %q", row.ResourceType)
	}
	return change, nil
}
