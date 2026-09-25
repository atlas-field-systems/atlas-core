package app

import (
	"context"

	"github.com/atlas-field-systems/atlas-core/core/internal/api"
	"github.com/atlas-field-systems/atlas-core/core/internal/pagination"
)

func (a *App) CreateTask(ctx context.Context, request api.CreateTaskRequestObject) (api.CreateTaskResponseObject, error) {
	task, created, err := a.tasks.Create(ctx, callerFrom(ctx), *request.Body)
	if err != nil {
		return nil, err
	}
	if created {
		return api.CreateTask201JSONResponse(task), nil
	}
	return api.CreateTask200JSONResponse(task), nil
}

func (a *App) GetTask(ctx context.Context, request api.GetTaskRequestObject) (api.GetTaskResponseObject, error) {
	task, err := a.tasks.Get(ctx, request.TaskId)
	if err != nil {
		return nil, err
	}
	return api.GetTask200JSONResponse(task), nil
}

func (a *App) ListTasks(ctx context.Context, request api.ListTasksRequestObject) (api.ListTasksResponseObject, error) {
	page, err := a.tasks.List(ctx, nil, request.Params.Cursor, pagination.Limit(request.Params.Limit))
	if err != nil {
		return nil, err
	}
	return api.ListTasks200JSONResponse(page), nil
}

func (a *App) ListAssignedTasks(ctx context.Context, request api.ListAssignedTasksRequestObject) (api.ListAssignedTasksResponseObject, error) {
	page, err := a.tasks.List(ctx, &request.EntityId, request.Params.Cursor, pagination.Limit(request.Params.Limit))
	if err != nil {
		return nil, err
	}
	return api.ListAssignedTasks200JSONResponse(page), nil
}

func (a *App) UpdateTaskStatus(ctx context.Context, request api.UpdateTaskStatusRequestObject) (api.UpdateTaskStatusResponseObject, error) {
	task, err := a.tasks.UpdateStatus(ctx, callerFrom(ctx), request.TaskId, *request.Body)
	if err != nil {
		return nil, err
	}
	return api.UpdateTaskStatus200JSONResponse(task), nil
}
