package app

import (
	"context"

	"github.com/atlas-field-systems/atlas-core/core/internal/api"
)

func (a *App) CreateEntity(ctx context.Context, request api.CreateEntityRequestObject) (api.CreateEntityResponseObject, error) {
	enrollment, err := a.entities.Enroll(ctx, *request.Body)
	if err != nil {
		return nil, err
	}
	if enrollment.Created {
		return api.CreateEntity201JSONResponse(enrollment.Result), nil
	}
	return api.CreateEntity200JSONResponse(enrollment.Result), nil
}

func (a *App) GetEntity(ctx context.Context, request api.GetEntityRequestObject) (api.GetEntityResponseObject, error) {
	entity, err := a.entities.Get(ctx, request.EntityId.String())
	if err != nil {
		return nil, err
	}
	return api.GetEntity200JSONResponse(entity), nil
}

func (a *App) ReportAssetStatus(ctx context.Context, request api.ReportAssetStatusRequestObject) (api.ReportAssetStatusResponseObject, error) {
	entity, err := a.entities.ReportStatus(ctx, callerFrom(ctx), request.EntityId.String(), *request.Body)
	if err != nil {
		return nil, err
	}
	return api.ReportAssetStatus200JSONResponse(entity), nil
}

func (a *App) GetAssetStatus(ctx context.Context, request api.GetAssetStatusRequestObject) (api.GetAssetStatusResponseObject, error) {
	view, err := a.entities.StatusView(ctx, request.EntityId.String())
	if err != nil {
		return nil, err
	}
	return api.GetAssetStatus200JSONResponse(view), nil
}

func (a *App) PatchEntity(ctx context.Context, request api.PatchEntityRequestObject) (api.PatchEntityResponseObject, error) {
	entity, err := a.entities.Report(ctx, callerFrom(ctx), request.EntityId.String(), *request.Body)
	if err != nil {
		return nil, err
	}
	return api.PatchEntity200JSONResponse(entity), nil
}

func (a *App) CheckInAsset(ctx context.Context, request api.CheckInAssetRequestObject) (api.CheckInAssetResponseObject, error) {
	entity, err := a.entities.Report(ctx, callerFrom(ctx), request.EntityId.String(), *request.Body)
	if err != nil {
		return nil, err
	}
	return api.CheckInAsset200JSONResponse(entity), nil
}
