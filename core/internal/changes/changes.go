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
	"github.com/atlas-field-systems/atlas-core/core/internal/identity"
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
	storage   *sql.DB
	queries   *db.Queries
	cursors   pagination.Codec
	dataset   uuid.UUID
	retention int64
	commits   *signal.Broadcast
}

func New(operational *sql.DB, dataset uuid.UUID, retention int) *Log {
	return &Log{
		storage:   operational,
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
	scope := sql.NullString{}
	if entity.Kind == api.EntityKindAsset {
		scope = sql.NullString{String: entity.Id.String(), Valid: true}
	}
	sequence, err := queries.InsertChange(ctx, db.InsertChangeParams{ResourceID: entity.Id.String(), Kind: string(kind), Entity: string(encoded), ResourceType: string(api.EntityResourceChangeResourceTypeEntity), ScopeAssetID: scope})
	if err != nil {
		return 0, fmt.Errorf("append change of Entity %s: %w", entity.Id, err)
	}
	if err := queries.RecordPrunedAssetChanges(ctx, sequence-l.retention); err != nil {
		return 0, fmt.Errorf("record pruned Asset changes: %w", err)
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
	sequence, err := queries.InsertChange(ctx, db.InsertChangeParams{ResourceID: task.Id.String(), Kind: string(kind), Entity: "{}", ResourceType: string(api.TaskResourceChangeResourceTypeTask), Task: sql.NullString{String: string(encoded), Valid: true}, ScopeAssetID: sql.NullString{String: task.AssetId.String(), Valid: true}})
	if err != nil {
		return 0, fmt.Errorf("append change of Task %s: %w", task.Id, err)
	}
	if err := queries.RecordPrunedAssetChanges(ctx, sequence-l.retention); err != nil {
		return 0, fmt.Errorf("record pruned Asset changes: %w", err)
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

// AssetCursor cannot be replayed as a full-picture or another Asset's cursor.
func (l *Log) AssetCursor(assetID string, sequence int64) (string, error) {
	return l.cursors.Encode(cursorList+":asset:"+assetID, position{Sequence: sequence})
}

// Query selects the declared replay scope and enforces Asset ownership.
func (l *Log) Query(ctx context.Context, caller identity.Caller, scope *api.QueryChangedSinceParamsScope, cursor string, limit int) (api.ChangePage, error) {
	if scope == nil {
		return l.Since(ctx, cursor, limit)
	}
	if *scope != api.QueryChangedSinceParamsScopeAsset || caller.Kind != identity.Asset {
		return api.ChangePage{}, problem.Forbidden("forbidden", "This credential may not call this operation.")
	}
	return l.SinceAsset(ctx, caller.ID, cursor, limit)
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
	page := api.ChangePage{DatasetId: l.dataset, Changes: make([]api.EntityChange, 0, len(rows)), Cursor: cursor, ThroughSequence: after.Sequence, Coverage: api.PictureCoverage{Scope: api.PictureCoverageScopeFull}}
	for _, row := range rows {
		change, err := l.decode(row)
		if err != nil {
			return api.ChangePage{}, err
		}
		page.Changes = append(page.Changes, change)
	}
	if len(rows) > 0 {
		page.Cursor, err = l.Cursor(rows[len(rows)-1].Sequence)
		page.ThroughSequence = rows[len(rows)-1].Sequence
	}
	return page, err
}

// SinceAsset returns only committed changes owned by one Asset. The cursor's
// through sequence proves which excluded global changes Core examined.
func (l *Log) SinceAsset(ctx context.Context, assetID, cursor string, limit int) (api.ChangePage, error) {
	var after position
	if err := l.cursors.Decode(cursor, cursorList+":asset:"+assetID, &after); err != nil {
		return api.ChangePage{}, err
	}
	tx, err := l.storage.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return api.ChangePage{}, fmt.Errorf("read Asset changes: %w", err)
	}
	defer tx.Rollback()
	queries := l.queries.WithTx(tx)
	latest, err := queries.LatestSequence(ctx)
	if err != nil {
		return api.ChangePage{}, fmt.Errorf("read latest change for Asset %s: %w", assetID, err)
	}
	if after.Sequence > latest {
		return api.ChangePage{}, errFutureCursor
	}
	pruned, err := queries.AssetPrunedThrough(ctx, assetID)
	if err != nil {
		return api.ChangePage{}, fmt.Errorf("read Asset change retention: %w", err)
	}
	if after.Sequence < pruned {
		return api.ChangePage{}, errExpired
	}
	rows, err := queries.ListAssetChangesAfter(ctx, db.ListAssetChangesAfterParams{AssetID: sql.NullString{String: assetID, Valid: true}, AfterSequence: after.Sequence, ThroughSequence: latest, Limit: int64(limit)})
	if err != nil {
		return api.ChangePage{}, fmt.Errorf("list Asset changes: %w", err)
	}
	through := latest
	if len(rows) == limit {
		through = rows[len(rows)-1].Sequence
	}
	next, err := l.AssetCursor(assetID, through)
	if err != nil {
		return api.ChangePage{}, fmt.Errorf("encode change cursor for Asset %s: %w", assetID, err)
	}
	id, err := uuid.Parse(assetID)
	if err != nil {
		return api.ChangePage{}, fmt.Errorf("parse Asset ID %s for change coverage: %w", assetID, err)
	}
	page := api.ChangePage{DatasetId: l.dataset, Changes: make([]api.EntityChange, 0, len(rows)), Cursor: next, ThroughSequence: through, Coverage: api.PictureCoverage{Scope: api.PictureCoverageScopeAsset, AssetId: &id}}
	for _, row := range rows {
		change, err := l.decode(row)
		if err != nil {
			return api.ChangePage{}, err
		}
		page.Changes = append(page.Changes, change)
	}
	if err := tx.Commit(); err != nil {
		return api.ChangePage{}, fmt.Errorf("finish change read for Asset %s: %w", assetID, err)
	}
	return page, nil
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
	change := api.EntityChange{Sequence: row.Sequence}
	switch row.ResourceType {
	case string(api.EntityResourceChangeResourceTypeEntity):
		var entity api.Entity
		if err := json.Unmarshal([]byte(row.Entity), &entity); err != nil {
			return api.EntityChange{}, fmt.Errorf("decode Entity change %d: %w", row.Sequence, err)
		}
		entity.ChangeSequence = row.Sequence
		if err := change.FromEntityResourceChange(api.EntityResourceChange{
			DatasetId: l.dataset, Sequence: row.Sequence, ResourceType: api.EntityResourceChangeResourceTypeEntity,
			ResourceId: entity.Id, Kind: api.EntityChangeKind(row.Kind), Entity: entity,
		}); err != nil {
			return api.EntityChange{}, fmt.Errorf("encode Entity change %d: %w", row.Sequence, err)
		}
	case string(api.TaskResourceChangeResourceTypeTask):
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
		if err := change.FromTaskResourceChange(api.TaskResourceChange{
			DatasetId: l.dataset, Sequence: row.Sequence, ResourceType: api.TaskResourceChangeResourceTypeTask,
			ResourceId: task.Id, Kind: api.EntityChangeKind(row.Kind), Task: task,
		}); err != nil {
			return api.EntityChange{}, fmt.Errorf("encode Task change %d: %w", row.Sequence, err)
		}
	default:
		return api.EntityChange{}, fmt.Errorf("unknown change resource type %q", row.ResourceType)
	}
	return change, nil
}
