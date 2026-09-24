package app

import (
	"context"

	"github.com/atlas-field-systems/atlas-core/core/internal/api"
)

func (a *App) GetHealth(context.Context, api.GetHealthRequestObject) (api.GetHealthResponseObject, error) {
	return api.GetHealth200JSONResponse{Status: api.Alive}, nil
}

func (a *App) GetDataset(context.Context, api.GetDatasetRequestObject) (api.GetDatasetResponseObject, error) {
	current := a.datasets.Current()
	return api.GetDataset200JSONResponse{Id: current.ID, WritingRelease: current.WritingRelease}, nil
}

func (a *App) GetReadiness(ctx context.Context, _ api.GetReadinessRequestObject) (api.GetReadinessResponseObject, error) {
	_, installationErr := a.identity.SetUp(ctx)
	readiness := api.Readiness{Status: api.ReadinessStatusReady}
	readiness.Dependencies.Sqlite = dependencyStatus(installationErr, a.datasets.Ready(ctx))
	readiness.Dependencies.Objects = dependencyStatus(a.objects.Ready())
	for _, status := range []api.DependencyStatus{readiness.Dependencies.Sqlite, readiness.Dependencies.Objects} {
		if status == api.DependencyStatusUnavailable {
			readiness.Status = api.ReadinessStatusUnavailable
			return api.GetReadiness503JSONResponse(readiness), nil
		}
	}
	return api.GetReadiness200JSONResponse(readiness), nil
}

func dependencyStatus(errs ...error) api.DependencyStatus {
	for _, err := range errs {
		if err != nil {
			return api.DependencyStatusUnavailable
		}
	}
	return api.DependencyStatusReady
}
