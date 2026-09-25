package entities

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/atlas-field-systems/atlas-core/core/internal/api"
	"github.com/atlas-field-systems/atlas-core/core/internal/entities/internal/db"
	"github.com/atlas-field-systems/atlas-core/core/internal/pagination"
	"github.com/atlas-field-systems/atlas-core/core/internal/problem"
)

// snapshotList names snapshot cursors in the pagination codec.
const snapshotList = "snapshot"

var errSnapshotAhead = problem.Invalid("invalid_cursor", "The snapshot cursor is ahead of the change log.")

type snapshotPosition struct {
	Baseline int64  `json:"b"`
	AfterID  string `json:"a"`
}

// Page returns one page of the snapshot that cursor continues, or the first
// page of a new snapshot at the current change sequence.
func (s *Service) Page(ctx context.Context, cursor *string, limit int) (api.EntityPage, error) {
	position, err := s.snapshotPosition(ctx, cursor)
	if err != nil {
		return api.EntityPage{}, err
	}
	rows, err := s.queries.ListEntitiesAtBaseline(ctx, db.ListEntitiesAtBaselineParams{
		Baseline: sql.NullInt64{Int64: position.Baseline, Valid: true},
		AfterID:  position.AfterID,
		Limit:    int64(limit + 1),
	})
	if err != nil {
		return api.EntityPage{}, fmt.Errorf("list snapshot Entities: %w", err)
	}
	return s.newPage(position.Baseline, rows, limit)
}

func (s *Service) snapshotPosition(ctx context.Context, cursor *string) (snapshotPosition, error) {
	latest, err := s.changes.Latest(ctx)
	if err != nil {
		return snapshotPosition{}, err
	}
	if cursor == nil {
		return snapshotPosition{Baseline: latest}, nil
	}
	var position snapshotPosition
	if err := s.cursors().Decode(*cursor, snapshotList, &position); err != nil {
		return snapshotPosition{}, err
	}
	if position.Baseline > latest {
		return snapshotPosition{}, errSnapshotAhead
	}
	return position, nil
}

func (s *Service) newPage(baseline int64, rows []db.Entity, limit int) (api.EntityPage, error) {
	replayFrom, err := s.changes.Cursor(baseline)
	if err != nil {
		return api.EntityPage{}, err
	}
	page := api.EntityPage{DatasetId: s.datasets.Current().ID, Baseline: replayFrom, BaselineSequence: baseline, Entities: []api.Entity{}}
	if len(rows) > limit {
		rows = rows[:limit]
		next, err := s.cursors().Encode(snapshotList, snapshotPosition{Baseline: baseline, AfterID: rows[limit-1].ID})
		if err != nil {
			return api.EntityPage{}, err
		}
		page.NextCursor = &next
	}
	for _, row := range rows {
		entity, err := toAPI(row, page.DatasetId)
		if err != nil {
			return api.EntityPage{}, err
		}
		page.Entities = append(page.Entities, entity)
	}
	return page, nil
}

func (s *Service) cursors() pagination.Codec { return pagination.NewCodec(s.datasets.Current().ID) }
