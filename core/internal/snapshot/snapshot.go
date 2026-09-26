// Package snapshot pages the operational picture across its resource owners.
package snapshot

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/atlas-field-systems/atlas-core/core/internal/api"
	"github.com/atlas-field-systems/atlas-core/core/internal/changes"
	"github.com/atlas-field-systems/atlas-core/core/internal/entities"
	"github.com/atlas-field-systems/atlas-core/core/internal/identity"
	"github.com/atlas-field-systems/atlas-core/core/internal/pagination"
	"github.com/atlas-field-systems/atlas-core/core/internal/problem"
	"github.com/atlas-field-systems/atlas-core/core/internal/tasks"
)

type taskPosition struct {
	Baseline int64  `json:"b"`
	AfterID  string `json:"a"`
}

const taskCursorPrefix = "tasks."
const assetTaskCursorPrefix = "asset-tasks."

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

// Query selects the declared picture and enforces ownership of an Asset scope.
func (s *Service) Query(ctx context.Context, caller identity.Caller, scope *api.QueryFullParamsScope, cursor *string, limit *int) (api.EntityPage, error) {
	if scope == nil {
		return s.Full(ctx, cursor, limit)
	}
	if *scope != api.QueryFullParamsScopeAsset || caller.Kind != identity.Asset {
		return api.EntityPage{}, problem.Forbidden("forbidden", "This credential may not call this operation.")
	}
	return s.Asset(ctx, caller.ID, cursor, limit)
}

func (s *Service) Full(ctx context.Context, cursor *string, requestedLimit *int) (api.EntityPage, error) {
	limit := pagination.Limit(requestedLimit)
	if cursor != nil && strings.HasPrefix(*cursor, taskCursorPrefix) {
		return s.taskPage(ctx, strings.TrimPrefix(*cursor, taskCursorPrefix), limit, "")
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

// Asset returns the same picture shape with Core-side filtering for one Asset.
func (s *Service) Asset(ctx context.Context, assetID string, cursor *string, requestedLimit *int) (api.EntityPage, error) {
	limit := pagination.Limit(requestedLimit)
	if cursor != nil && strings.HasPrefix(*cursor, assetTaskCursorPrefix) {
		return s.taskPage(ctx, strings.TrimPrefix(*cursor, assetTaskCursorPrefix), limit, assetID)
	}
	page, err := s.entities.AssetPage(ctx, assetID, cursor, limit)
	if err != nil {
		return api.EntityPage{}, err
	}
	page.Tasks = []api.Task{}
	if page.NextCursor == nil {
		next, err := s.cursors.Encode("asset-tasks:"+assetID, taskPosition{Baseline: page.BaselineSequence})
		if err != nil {
			return api.EntityPage{}, fmt.Errorf("encode Task snapshot cursor for Asset %s: %w", assetID, err)
		}
		prefixed := assetTaskCursorPrefix + next
		page.NextCursor = &prefixed
	}
	return page, nil
}

func (s *Service) taskPage(ctx context.Context, cursor string, limit int, assetID string) (api.EntityPage, error) {
	var position taskPosition
	list := "full-tasks"
	if assetID != "" {
		list = "asset-tasks:" + assetID
	}
	if err := s.cursors.Decode(cursor, list, &position); err != nil {
		return api.EntityPage{}, err
	}
	latest, err := s.changes.Latest(ctx)
	if err != nil {
		return api.EntityPage{}, err
	}
	if position.Baseline > latest {
		return api.EntityPage{}, problem.Invalid("invalid_cursor", "The snapshot cursor is ahead of the change log.")
	}
	var tasks api.TaskPage
	if assetID == "" {
		tasks, err = s.tasks.Snapshot(ctx, position.Baseline, position.AfterID, limit)
	} else {
		tasks, err = s.tasks.AssetSnapshot(ctx, assetID, position.Baseline, position.AfterID, limit)
	}
	if err != nil {
		return api.EntityPage{}, err
	}
	baseline, err := s.changes.Cursor(position.Baseline)
	coverage := api.PictureCoverage{Scope: api.PictureCoverageScopeFull}
	if assetID != "" {
		baseline, err = s.changes.AssetCursor(assetID, position.Baseline)
		id, parseErr := uuid.Parse(assetID)
		if parseErr != nil {
			return api.EntityPage{}, fmt.Errorf("parse Asset ID %s for snapshot coverage: %w", assetID, parseErr)
		}
		coverage = api.PictureCoverage{Scope: api.PictureCoverageScopeAsset, AssetId: &id}
	}
	if err != nil {
		return api.EntityPage{}, fmt.Errorf("encode Task snapshot baseline: %w", err)
	}
	page := api.EntityPage{DatasetId: s.dataset, Baseline: baseline, BaselineSequence: position.Baseline, Entities: []api.Entity{}, Tasks: tasks.Tasks, Coverage: coverage}
	if tasks.NextCursor != nil {
		next, err := s.cursors.Encode(list, taskPosition{Baseline: position.Baseline, AfterID: *tasks.NextCursor})
		if err != nil {
			return api.EntityPage{}, err
		}
		prefix := taskCursorPrefix
		if assetID != "" {
			prefix = assetTaskCursorPrefix
		}
		prefixed := prefix + next
		page.NextCursor = &prefixed
	}
	return page, nil
}
