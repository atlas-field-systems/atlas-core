// Package snapshot pages the operational picture across its resource owners.
package snapshot

import (
	"context"
	"strings"

	"github.com/google/uuid"

	"github.com/atlas-field-systems/atlas-core/core/internal/api"
	"github.com/atlas-field-systems/atlas-core/core/internal/changes"
	"github.com/atlas-field-systems/atlas-core/core/internal/entities"
	"github.com/atlas-field-systems/atlas-core/core/internal/pagination"
	"github.com/atlas-field-systems/atlas-core/core/internal/problem"
	"github.com/atlas-field-systems/atlas-core/core/internal/tasks"
)

type taskPosition struct {
	Baseline int64  `json:"b"`
	AfterID  string `json:"a"`
}

const taskCursorPrefix = "tasks."

// Service keeps one snapshot baseline while paging Entities and then Tasks.
type Service struct {
	dataset  uuid.UUID
	entities *entities.Service
	tasks    *tasks.Service
	changes  *changes.Log
	cursors  pagination.Codec
}

func New(dataset uuid.UUID, entities *entities.Service, tasks *tasks.Service, changes *changes.Log) *Service {
	return &Service{dataset: dataset, entities: entities, tasks: tasks, changes: changes, cursors: pagination.NewCodec(dataset)}
}

func (s *Service) Full(ctx context.Context, cursor *string, requestedLimit *int) (api.EntityPage, error) {
	limit := pagination.Limit(requestedLimit)
	if cursor != nil && strings.HasPrefix(*cursor, taskCursorPrefix) {
		return s.taskPage(ctx, strings.TrimPrefix(*cursor, taskCursorPrefix), limit)
	}
	page, err := s.entities.Page(ctx, cursor, limit)
	if err != nil {
		return api.EntityPage{}, err
	}
	page.Tasks = []api.Task{}
	if page.NextCursor == nil {
		next, err := s.cursors.Encode("full-tasks", taskPosition{Baseline: page.BaselineSequence})
		if err != nil {
			return api.EntityPage{}, err
		}
		prefixed := taskCursorPrefix + next
		page.NextCursor = &prefixed
	}
	return page, nil
}

func (s *Service) taskPage(ctx context.Context, cursor string, limit int) (api.EntityPage, error) {
	var position taskPosition
	if err := s.cursors.Decode(cursor, "full-tasks", &position); err != nil {
		return api.EntityPage{}, err
	}
	latest, err := s.changes.Latest(ctx)
	if err != nil {
		return api.EntityPage{}, err
	}
	if position.Baseline > latest {
		return api.EntityPage{}, problem.Invalid("invalid_cursor", "The snapshot cursor is ahead of the change log.")
	}
	tasks, err := s.tasks.Snapshot(ctx, position.Baseline, position.AfterID, limit)
	if err != nil {
		return api.EntityPage{}, err
	}
	baseline, err := s.changes.Cursor(position.Baseline)
	if err != nil {
		return api.EntityPage{}, err
	}
	page := api.EntityPage{DatasetId: s.dataset, Baseline: baseline, BaselineSequence: position.Baseline, Entities: []api.Entity{}, Tasks: tasks.Tasks}
	if tasks.NextCursor != nil {
		next, err := s.cursors.Encode("full-tasks", taskPosition{Baseline: position.Baseline, AfterID: *tasks.NextCursor})
		if err != nil {
			return api.EntityPage{}, err
		}
		prefixed := taskCursorPrefix + next
		page.NextCursor = &prefixed
	}
	return page, nil
}
