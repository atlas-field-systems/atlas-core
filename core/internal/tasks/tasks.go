// Package tasks owns durable Asset Tasks, submission retries and execution reports.
package tasks

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"github.com/atlas-field-systems/atlas-core/core/internal/activity"
	"github.com/atlas-field-systems/atlas-core/core/internal/api"
	"github.com/atlas-field-systems/atlas-core/core/internal/changes"
	"github.com/atlas-field-systems/atlas-core/core/internal/datasets"
	"github.com/atlas-field-systems/atlas-core/core/internal/entities"
	"github.com/atlas-field-systems/atlas-core/core/internal/identity"
	"github.com/atlas-field-systems/atlas-core/core/internal/pagination"
	"github.com/atlas-field-systems/atlas-core/core/internal/problem"
	"github.com/atlas-field-systems/atlas-core/core/internal/tasks/internal/db"
)

var (
	errNotFound                = problem.NotFound("not_found", "Task not found.")
	errUnsupported             = problem.Conflict("unsupported_command", "The Asset does not support this Command and scheduling combination.")
	errSubmissionConflict      = problem.Conflict("submission_conflict", "The submission ID was used with different facts.")
	errInvalidTransition       = problem.Conflict("task_transition_conflict", "The Task cannot make this status transition.")
	errNotAssigned             = problem.Forbidden("forbidden", "Only the assigned Asset may report Task execution.")
	errInvalidStatus           = problem.Invalid("invalid_task_status", "The status update does not match the actor or transition.")
	errUnsupportedCancellation = problem.Conflict("unsupported_cancellation", "The assigned Asset did not advertise Task cancellation support.")
	errUnsupportedProgress     = problem.Conflict("unsupported_progress", "The assigned Asset did not advertise Task progress support.")
)

// Service keeps Tasks and their permanent per-Asset acceptance order.
type Service struct {
	db       *sql.DB
	queries  *db.Queries
	datasets *datasets.Service
	entities *entities.Service
	changes  *changes.Log
	activity *activity.Log
	cursors  pagination.Codec
}

func New(operational *sql.DB, datasets *datasets.Service, entities *entities.Service, changes *changes.Log, activity *activity.Log) *Service {
	return &Service{db: operational, queries: db.New(operational), datasets: datasets, entities: entities, changes: changes, activity: activity, cursors: pagination.NewCodec(datasets.Current().ID)}
}

// Create returns the original Task on a matching submission retry, including
// after Restart. The Task, sequence, retry facts and change commit together.
func (s *Service) Create(ctx context.Context, caller identity.Caller, request api.TaskSubmission) (api.Task, bool, error) {
	if err := s.datasets.RequireCurrent(request.DatasetId); err != nil {
		return api.Task{}, false, err
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		return api.Task{}, false, fmt.Errorf("encode Task submission: %w", err)
	}
	digest := sha256.Sum256(encoded)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return api.Task{}, false, err
	}
	defer tx.Rollback()
	queries := s.queries.WithTx(tx)
	previous, err := queries.GetTaskBySubmission(ctx, request.SubmissionId.String())
	if err == nil {
		if !bytes.Equal(previous.FactsDigest, digest[:]) {
			return api.Task{}, false, errSubmissionConflict
		}
		task, err := s.toAPI(previous)
		return task, false, err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return api.Task{}, false, fmt.Errorf("read Task submission: %w", err)
	}
	asset, err := s.entities.GetInTx(ctx, tx, request.AssetId.String())
	if err != nil {
		return api.Task{}, false, err
	}
	supported := false
	cancellationSupported := false
	progressSupported := false
	for _, command := range asset.CommandManifest {
		if command.CommandId != string(request.CommandId) {
			continue
		}
		for _, scheduling := range command.Scheduling {
			if string(scheduling) == string(request.Scheduling) {
				supported = true
				cancellationSupported = command.Cancellation != nil && *command.Cancellation
				progressSupported = command.Progress != nil && *command.Progress
			}
		}
	}
	if !supported {
		return api.Task{}, false, errUnsupported
	}
	sequence, err := queries.NextAssetSequence(ctx, request.AssetId.String())
	if err != nil {
		return api.Task{}, false, fmt.Errorf("assign Task sequence: %w", err)
	}
	id := uuid.New()
	err = queries.CreateTask(ctx, db.CreateTaskParams{ID: id.String(), SubmissionID: request.SubmissionId.String(), AssetID: request.AssetId.String(), FactsDigest: digest[:], CommandID: string(request.CommandId), DestinationLatitude: request.Input.Latitude, DestinationLongitude: request.Input.Longitude, Scheduling: string(request.Scheduling), CancellationSupported: cancellationSupported, ProgressSupported: progressSupported, AcceptanceSequence: sequence})
	if err != nil {
		return api.Task{}, false, fmt.Errorf("create Task: %w", err)
	}
	if err := s.activity.Record(ctx, tx, caller, "task_issued", id); err != nil {
		return api.Task{}, false, err
	}
	task, err := s.publish(ctx, tx, id.String(), api.Create)
	if err != nil {
		return api.Task{}, false, err
	}
	return task, true, s.changes.Commit(tx)
}

func (s *Service) Get(ctx context.Context, id uuid.UUID) (api.Task, error) {
	return s.read(ctx, s.queries, id.String())
}

func (s *Service) read(ctx context.Context, queries *db.Queries, id string) (api.Task, error) {
	row, err := queries.GetTask(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return api.Task{}, errNotFound
	}
	if err != nil {
		return api.Task{}, fmt.Errorf("read Task %s: %w", id, err)
	}
	return s.toAPI(row)
}

func (s *Service) toAPI(row db.Task) (api.Task, error) {
	id, err := uuid.Parse(row.ID)
	if err != nil {
		return api.Task{}, fmt.Errorf("stored Task ID: %w", err)
	}
	submissionID, err := uuid.Parse(row.SubmissionID)
	if err != nil {
		return api.Task{}, fmt.Errorf("stored Task submission ID: %w", err)
	}
	assetID, err := uuid.Parse(row.AssetID)
	if err != nil {
		return api.Task{}, fmt.Errorf("stored Task Asset ID: %w", err)
	}
	input := api.MoveToInput{Latitude: row.DestinationLatitude, Longitude: row.DestinationLongitude}
	task := api.Task{DatasetId: s.datasets.Current().ID, Id: id, SubmissionId: submissionID, AssetId: assetID, CommandId: api.TaskCommandId(row.CommandID), Input: input, Scheduling: api.TaskScheduling(row.Scheduling), AcceptanceSequence: row.AcceptanceSequence, Status: api.TaskStatus(row.Status), Version: int(row.Version), CreatedSequence: row.CreatedSequence, ChangeSequence: row.ChangeSequence}
	if row.ProgressPercent.Valid {
		task.ProgressPercent = &row.ProgressPercent.Float64
	}
	if row.FailureReason.Valid {
		task.FailureReason = &row.FailureReason.String
	}
	if row.CancellationRequestID.Valid {
		cancellationID, err := uuid.Parse(row.CancellationRequestID.String)
		if err != nil {
			return api.Task{}, fmt.Errorf("stored cancellation ID: %w", err)
		}
		task.CancellationRequestId = &cancellationID
	}
	return task, nil
}

func (s *Service) publish(ctx context.Context, tx *sql.Tx, id string, kind api.EntityChangeKind) (api.Task, error) {
	queries := s.queries.WithTx(tx)
	task, err := s.read(ctx, queries, id)
	if err != nil {
		return api.Task{}, err
	}
	sequence, err := s.changes.AppendTask(ctx, tx, kind, task)
	if err != nil {
		return api.Task{}, err
	}
	if err := queries.SetTaskChangeSequence(ctx, db.SetTaskChangeSequenceParams{Sequence: sequence, ID: id}); err != nil {
		return api.Task{}, fmt.Errorf("set Task change sequence: %w", err)
	}
	task.ChangeSequence = sequence
	if task.CreatedSequence == 0 {
		task.CreatedSequence = sequence
	}
	return task, nil
}

type listPosition struct {
	AfterSequence int64 `json:"s"`
}

// List reads a page without changing any Task or Asset contact state.
func (s *Service) List(ctx context.Context, assetID *uuid.UUID, cursor *string, limit int) (api.TaskPage, error) {
	list := "tasks"
	if assetID != nil {
		list += ":" + assetID.String()
	}
	var position listPosition
	if cursor != nil {
		if err := s.cursors.Decode(*cursor, list, &position); err != nil {
			return api.TaskPage{}, err
		}
	}
	var rows []db.Task
	var err error
	if assetID == nil {
		rows, err = s.queries.ListTasks(ctx, db.ListTasksParams{AfterSequence: position.AfterSequence, Limit: int64(limit + 1)})
	} else {
		if _, err := s.entities.Get(ctx, assetID.String()); err != nil {
			return api.TaskPage{}, err
		}
		rows, err = s.queries.ListAssignedTasks(ctx, db.ListAssignedTasksParams{AssetID: assetID.String(), AfterSequence: position.AfterSequence, Limit: int64(limit + 1)})
	}
	if err != nil {
		return api.TaskPage{}, fmt.Errorf("list Tasks: %w", err)
	}
	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}
	page, err := s.pageRows(rows)
	if err != nil {
		return api.TaskPage{}, err
	}
	if hasMore {
		last := rows[len(rows)-1].CreatedSequence
		if assetID != nil {
			last = rows[len(rows)-1].AcceptanceSequence
		}
		next, err := s.cursors.Encode(list, listPosition{AfterSequence: last})
		if err != nil {
			return api.TaskPage{}, err
		}
		page.NextCursor = &next
	}
	return page, nil
}

// Snapshot returns Tasks created at or before the Entity snapshot baseline.
// Later Task states may be included; replay only applies newer versions.
func (s *Service) Snapshot(ctx context.Context, baseline int64, afterID string, limit int) (api.TaskPage, error) {
	rows, err := s.queries.ListTasksAtBaseline(ctx, db.ListTasksAtBaselineParams{Baseline: baseline, AfterID: afterID, Limit: int64(limit + 1)})
	if err != nil {
		return api.TaskPage{}, fmt.Errorf("list snapshot Tasks: %w", err)
	}
	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}
	page, err := s.pageRows(rows)
	if err != nil {
		return api.TaskPage{}, err
	}
	if hasMore {
		next := rows[len(rows)-1].ID
		page.NextCursor = &next
	}
	return page, nil
}

func (s *Service) pageRows(rows []db.Task) (api.TaskPage, error) {
	page := api.TaskPage{DatasetId: s.datasets.Current().ID, Tasks: make([]api.Task, 0, len(rows))}
	for _, row := range rows {
		task, err := s.toAPI(row)
		if err != nil {
			return api.TaskPage{}, err
		}
		page.Tasks = append(page.Tasks, task)
	}
	return page, nil
}
