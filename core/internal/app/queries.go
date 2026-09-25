package app

import (
	"context"
	"strings"

	"github.com/atlas-field-systems/atlas-core/core/internal/api"
	"github.com/atlas-field-systems/atlas-core/core/internal/pagination"
	"github.com/atlas-field-systems/atlas-core/core/internal/problem"
)

type taskSnapshotPosition struct {
	Baseline int64  `json:"b"`
	AfterID  string `json:"a"`
}

const taskSnapshotPrefix = "tasks."

func (a *App) QueryFull(ctx context.Context, request api.QueryFullRequestObject) (api.QueryFullResponseObject, error) {
	if request.Params.Cursor != nil && strings.HasPrefix(*request.Params.Cursor, taskSnapshotPrefix) {
		codec := pagination.NewCodec(a.datasets.Current().ID)
		var position taskSnapshotPosition
		if err := codec.Decode(strings.TrimPrefix(*request.Params.Cursor, taskSnapshotPrefix), "full-tasks", &position); err != nil {
			return nil, err
		}
		latest, err := a.changes.Latest(ctx)
		if err != nil {
			return nil, err
		}
		if position.Baseline > latest {
			return nil, problem.Invalid("invalid_cursor", "The snapshot cursor is ahead of the change log.")
		}
		tasks, err := a.tasks.Snapshot(ctx, position.Baseline, position.AfterID, pagination.Limit(request.Params.Limit))
		if err != nil {
			return nil, err
		}
		baseline, err := a.changes.Cursor(position.Baseline)
		if err != nil {
			return nil, err
		}
		page := api.EntityPage{DatasetId: a.datasets.Current().ID, Baseline: baseline, BaselineSequence: position.Baseline, Entities: []api.Entity{}, Tasks: tasks.Tasks}
		if tasks.NextCursor != nil {
			next, err := codec.Encode("full-tasks", taskSnapshotPosition{Baseline: position.Baseline, AfterID: *tasks.NextCursor})
			if err != nil {
				return nil, err
			}
			cursor := taskSnapshotPrefix + next
			page.NextCursor = &cursor
		}
		return api.QueryFull200JSONResponse(page), nil
	}
	page, err := a.entities.Page(ctx, request.Params.Cursor, pagination.Limit(request.Params.Limit))
	if err != nil {
		return nil, err
	}
	page.Tasks = []api.Task{}
	if page.NextCursor == nil {
		next, err := pagination.NewCodec(a.datasets.Current().ID).Encode("full-tasks", taskSnapshotPosition{Baseline: page.BaselineSequence})
		if err != nil {
			return nil, err
		}
		cursor := taskSnapshotPrefix + next
		page.NextCursor = &cursor
	}
	return api.QueryFull200JSONResponse(page), nil
}

func (a *App) QueryChangedSince(ctx context.Context, request api.QueryChangedSinceRequestObject) (api.QueryChangedSinceResponseObject, error) {
	page, err := a.changes.Since(ctx, request.Params.Cursor, pagination.Limit(request.Params.Limit))
	if err != nil {
		return nil, err
	}
	return api.QueryChangedSince200JSONResponse(page), nil
}
