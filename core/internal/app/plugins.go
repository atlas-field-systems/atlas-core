package app

import (
	"context"

	"github.com/atlas-field-systems/atlas-core/core/internal/api"
	"github.com/atlas-field-systems/atlas-core/core/internal/pagination"
	"github.com/atlas-field-systems/atlas-core/core/internal/plugins"
)

func (a *App) ListPlugins(ctx context.Context, request api.ListPluginsRequestObject) (api.ListPluginsResponseObject, error) {
	page, err := a.plugins.List(ctx, request.Params.Cursor, pagination.Limit(request.Params.Limit))
	if err != nil {
		return nil, err
	}
	return api.ListPlugins200JSONResponse(page), nil
}

func (a *App) GetPlugin(ctx context.Context, request api.GetPluginRequestObject) (api.GetPluginResponseObject, error) {
	plugin, err := a.plugins.Get(ctx, request.PluginId)
	if err != nil {
		return nil, err
	}
	return api.GetPlugin200JSONResponse(plugin), nil
}

func (a *App) ListPluginOperations(ctx context.Context, request api.ListPluginOperationsRequestObject) (api.ListPluginOperationsResponseObject, error) {
	page, err := a.plugins.Operations(ctx, request.PluginId, request.Params.Cursor, pagination.Limit(request.Params.Limit))
	if err != nil {
		return nil, err
	}
	return api.ListPluginOperations200JSONResponse(page), nil
}

func (a *App) SubmitPluginOperation(ctx context.Context, request api.SubmitPluginOperationRequestObject) (api.SubmitPluginOperationResponseObject, error) {
	operation, err := a.plugins.Submit(ctx, request.PluginId, *request.Body)
	if err != nil {
		return nil, err
	}
	location := plugins.Location(operation)
	return api.SubmitPluginOperation202JSONResponse{Body: operation, Headers: api.SubmitPluginOperation202ResponseHeaders{Location: &location}}, nil
}

func (a *App) GetPluginOperation(ctx context.Context, request api.GetPluginOperationRequestObject) (api.GetPluginOperationResponseObject, error) {
	operation, err := a.plugins.Operation(ctx, request.PluginId, request.OperationId)
	if err != nil {
		return nil, err
	}
	return api.GetPluginOperation200JSONResponse(operation), nil
}

func (a *App) ReportPluginOperation(ctx context.Context, request api.ReportPluginOperationRequestObject) (api.ReportPluginOperationResponseObject, error) {
	operation, err := a.plugins.Report(ctx, callerFrom(ctx), request.PluginId, request.OperationId, *request.Body)
	if err != nil {
		return nil, err
	}
	return api.ReportPluginOperation200JSONResponse(operation), nil
}
