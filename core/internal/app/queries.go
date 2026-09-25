package app

import (
	"context"

	"github.com/atlas-field-systems/atlas-core/core/internal/api"
	"github.com/atlas-field-systems/atlas-core/core/internal/pagination"
)

func (a *App) QueryFull(ctx context.Context, request api.QueryFullRequestObject) (api.QueryFullResponseObject, error) {
	page, err := a.snapshot.Full(ctx, request.Params.Cursor, request.Params.Limit)
	if err != nil {
		return nil, err
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
