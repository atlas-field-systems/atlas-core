package api

import (
	"context"

	"github.com/atlas-field-systems/atlas-core/coreerr"
	"github.com/atlas-field-systems/atlas-core/entities"
	"github.com/atlas-field-systems/atlas-core/generated/protocol"
)

func (s *Server) ListEntities(ctx context.Context, request protocol.ListEntitiesRequestObject) (protocol.ListEntitiesResponseObject, error) {
	page, err := s.entities.List(ctx, from(ctx).dataset, request.Params)
	if err != nil {
		return nil, err
	}
	dataset, version := s.headers(ctx)
	return protocol.ListEntities200JSONResponse{
		Body:    protocol.EntityPageResponse{DatasetId: dataset, Data: page},
		Headers: protocol.ListEntities200ResponseHeaders{AtlasDatasetID: dataset, AtlasProtocolVersion: version},
	}, nil
}

func (s *Server) CreateEntity(ctx context.Context, request protocol.CreateEntityRequestObject) (protocol.CreateEntityResponseObject, error) {
	result, err := s.entities.Register(ctx, from(ctx).principal, from(ctx).enrollment, from(ctx).dataset, from(ctx).raw, *request.Body)
	if err != nil {
		return nil, err
	}
	dataset, version := s.headers(ctx)
	body := protocol.RegistrationResponse{DatasetId: dataset, CommitCursor: result.Cursor, Data: result.Data}
	if result.Created {
		return protocol.CreateEntity201JSONResponse{Body: body, Headers: protocol.CreateEntity201ResponseHeaders{AtlasDatasetID: dataset, AtlasProtocolVersion: version}}, nil
	}
	return protocol.CreateEntity200JSONResponse{Body: body, Headers: protocol.CreateEntity200ResponseHeaders{AtlasDatasetID: dataset, AtlasProtocolVersion: version}}, nil
}

func (s *Server) GetEntityByAlias(ctx context.Context, request protocol.GetEntityByAliasRequestObject) (protocol.GetEntityByAliasResponseObject, error) {
	entity, err := s.entities.GetByAlias(ctx, from(ctx).dataset, request.Alias)
	if err != nil {
		return nil, err
	}
	dataset, version := s.headers(ctx)
	return protocol.GetEntityByAlias200JSONResponse{
		Body:    protocol.EntityResponse{DatasetId: dataset, Data: entity},
		Headers: protocol.GetEntityByAlias200ResponseHeaders{AtlasDatasetID: dataset, AtlasProtocolVersion: version},
	}, nil
}

func (s *Server) GetEntity(ctx context.Context, request protocol.GetEntityRequestObject) (protocol.GetEntityResponseObject, error) {
	entity, err := s.entities.Get(ctx, from(ctx).dataset, request.EntityId.String())
	if err != nil {
		return nil, err
	}
	dataset, version := s.headers(ctx)
	return protocol.GetEntity200JSONResponse{
		Body:    protocol.EntityResponse{DatasetId: dataset, Data: entity},
		Headers: protocol.GetEntity200ResponseHeaders{AtlasDatasetID: dataset, AtlasProtocolVersion: version},
	}, nil
}

func (s *Server) PatchEntity(ctx context.Context, request protocol.PatchEntityRequestObject) (protocol.PatchEntityResponseObject, error) {
	result, err := s.entities.Patch(ctx, principal(ctx), from(ctx).dataset, envelope(ctx, entities.OpEntityPatch, request.EntityId.String()), *request.Body)
	if err != nil {
		return nil, err
	}
	dataset, version := s.headers(ctx)
	return protocol.PatchEntity200JSONResponse{
		Body:    protocol.EntityMutationResponse{DatasetId: dataset, CommitCursor: result.Cursor, Data: result.Data},
		Headers: protocol.PatchEntity200ResponseHeaders{AtlasDatasetID: dataset, AtlasProtocolVersion: version},
	}, nil
}

func (s *Server) DeleteEntity(ctx context.Context, request protocol.DeleteEntityRequestObject) (protocol.DeleteEntityResponseObject, error) {
	cursor, err := s.entities.Delete(ctx, principal(ctx), from(ctx).dataset, request.EntityId.String())
	if err != nil {
		return nil, err
	}
	dataset, version := s.headers(ctx)
	return protocol.DeleteEntity204Response{Headers: protocol.DeleteEntity204ResponseHeaders{AtlasCommitCursor: cursor, AtlasDatasetID: dataset, AtlasProtocolVersion: version}}, nil
}

func (s *Server) CheckIn(ctx context.Context, request protocol.CheckInRequestObject) (protocol.CheckInResponseObject, error) {
	result, err := s.entities.CheckIn(ctx, principal(ctx), from(ctx).dataset, envelope(ctx, entities.OpCheckIn, request.EntityId.String()), *request.Body)
	if err != nil {
		return nil, err
	}
	dataset, version := s.headers(ctx)
	return protocol.CheckIn200JSONResponse{
		Body:    protocol.EntityMutationResponse{DatasetId: dataset, CommitCursor: result.Cursor, Data: result.Data},
		Headers: protocol.CheckIn200ResponseHeaders{AtlasDatasetID: dataset, AtlasProtocolVersion: version},
	}, nil
}

func (s *Server) GetAssetStatus(ctx context.Context, request protocol.GetAssetStatusRequestObject) (protocol.GetAssetStatusResponseObject, error) {
	status, err := s.entities.Status(ctx, from(ctx).dataset, request.EntityId.String())
	if err != nil {
		return nil, err
	}
	dataset, version := s.headers(ctx)
	return protocol.GetAssetStatus200JSONResponse{
		Body:    protocol.AssetStatusResponse{DatasetId: dataset, Data: status},
		Headers: protocol.GetAssetStatus200ResponseHeaders{AtlasDatasetID: dataset, AtlasProtocolVersion: version},
	}, nil
}

func (s *Server) ReportAssetStatus(ctx context.Context, request protocol.ReportAssetStatusRequestObject) (protocol.ReportAssetStatusResponseObject, error) {
	result, err := s.entities.ReportStatus(ctx, principal(ctx), from(ctx).dataset, envelope(ctx, entities.OpStatusReport, request.EntityId.String()), *request.Body)
	if err != nil {
		return nil, err
	}
	dataset, version := s.headers(ctx)
	return protocol.ReportAssetStatus200JSONResponse{
		Body:    protocol.EntityMutationResponse{DatasetId: dataset, CommitCursor: result.Cursor, Data: result.Data},
		Headers: protocol.ReportAssetStatus200ResponseHeaders{AtlasDatasetID: dataset, AtlasProtocolVersion: version},
	}, nil
}

func (s *Server) ListAssignedTasks(ctx context.Context, request protocol.ListAssignedTasksRequestObject) (protocol.ListAssignedTasksResponseObject, error) {
	page, err := s.tasks.Assigned(ctx, from(ctx).dataset, request.EntityId.String(), request.Params)
	if err != nil {
		return nil, err
	}
	dataset, version := s.headers(ctx)
	return protocol.ListAssignedTasks200JSONResponse{
		Body:    protocol.AssignedTaskPageResponse{DatasetId: dataset, Data: page},
		Headers: protocol.ListAssignedTasks200ResponseHeaders{AtlasDatasetID: dataset, AtlasProtocolVersion: version},
	}, nil
}

func (s *Server) GetMovementHistory(ctx context.Context, request protocol.GetMovementHistoryRequestObject) (protocol.GetMovementHistoryResponseObject, error) {
	page, err := s.entities.MovementHistory(ctx, from(ctx).dataset, request.EntityId.String(), request.Params)
	if err != nil {
		return nil, err
	}
	dataset, version := s.headers(ctx)
	return protocol.GetMovementHistory200JSONResponse{
		Body:    protocol.MovementHistoryResponse{DatasetId: dataset, Data: page},
		Headers: protocol.GetMovementHistory200ResponseHeaders{AtlasDatasetID: dataset, AtlasProtocolVersion: version},
	}, nil
}

func (s *Server) ListTasks(ctx context.Context, request protocol.ListTasksRequestObject) (protocol.ListTasksResponseObject, error) {
	page, err := s.tasks.List(ctx, from(ctx).dataset, request.Params)
	if err != nil {
		return nil, err
	}
	dataset, version := s.headers(ctx)
	return protocol.ListTasks200JSONResponse{
		Body:    protocol.TaskPageResponse{DatasetId: dataset, Data: page},
		Headers: protocol.ListTasks200ResponseHeaders{AtlasDatasetID: dataset, AtlasProtocolVersion: version},
	}, nil
}

func (s *Server) CreateTask(ctx context.Context, request protocol.CreateTaskRequestObject) (protocol.CreateTaskResponseObject, error) {
	result, err := s.tasks.Create(ctx, principal(ctx), from(ctx).dataset, from(ctx).raw, *request.Body)
	if err != nil {
		return nil, err
	}
	dataset, version := s.headers(ctx)
	body := protocol.TaskMutationResponse{DatasetId: dataset, CommitCursor: result.Cursor, Data: result.Task}
	if result.Created {
		return protocol.CreateTask201JSONResponse{Body: body, Headers: protocol.CreateTask201ResponseHeaders{AtlasDatasetID: dataset, AtlasProtocolVersion: version}}, nil
	}
	return protocol.CreateTask200JSONResponse{Body: body, Headers: protocol.CreateTask200ResponseHeaders{AtlasDatasetID: dataset, AtlasProtocolVersion: version}}, nil
}

func (s *Server) GetTask(ctx context.Context, request protocol.GetTaskRequestObject) (protocol.GetTaskResponseObject, error) {
	task, err := s.tasks.Get(ctx, from(ctx).dataset, request.TaskId.String())
	if err != nil {
		return nil, err
	}
	dataset, version := s.headers(ctx)
	return protocol.GetTask200JSONResponse{
		Body:    protocol.TaskResponse{DatasetId: dataset, Data: task},
		Headers: protocol.GetTask200ResponseHeaders{AtlasDatasetID: dataset, AtlasProtocolVersion: version},
	}, nil
}

func (s *Server) UpdateTaskStatus(ctx context.Context, request protocol.UpdateTaskStatusRequestObject) (protocol.UpdateTaskStatusResponseObject, error) {
	kind, err := request.Body.Discriminator()
	if err != nil {
		return nil, coreerr.Invalid("invalid_request", "The Task status update has no action")
	}
	var result struct {
		task   protocol.Task
		report *protocol.ReportResult
		cursor string
	}
	switch kind {
	case "request_cancellation":
		body, err := request.Body.AsTaskCancellationRequest()
		if err != nil {
			return nil, err
		}
		mutation, err := s.tasks.RequestCancellation(ctx, principal(ctx), from(ctx).dataset, request.TaskId.String(), from(ctx).raw, body)
		if err != nil {
			return nil, err
		}
		result.task, result.cursor = mutation.Task, mutation.Cursor
	default:
		body, err := request.Body.AsTaskLifecycleReport()
		if err != nil {
			return nil, err
		}
		mutation, err := s.tasks.Report(ctx, principal(ctx), from(ctx).dataset, envelope(ctx, entities.OpTaskStatus, request.TaskId.String()), body)
		if err != nil {
			return nil, err
		}
		result.task, result.report, result.cursor = mutation.Task, mutation.Report, mutation.Cursor
	}
	dataset, version := s.headers(ctx)
	return protocol.UpdateTaskStatus200JSONResponse{
		Body:    protocol.TaskStatusResponse{DatasetId: dataset, CommitCursor: result.cursor, Data: protocol.TaskStatusData{Task: result.task, Report: result.report}},
		Headers: protocol.UpdateTaskStatus200ResponseHeaders{AtlasDatasetID: dataset, AtlasProtocolVersion: version},
	}, nil
}
