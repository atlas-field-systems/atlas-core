package tasks

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"github.com/atlas-field-systems/atlas-core/core/internal/api"
	"github.com/atlas-field-systems/atlas-core/core/internal/identity"
	"github.com/atlas-field-systems/atlas-core/core/internal/storage"
	"github.com/atlas-field-systems/atlas-core/core/internal/tasks/internal/db"
)

// UpdateStatus records tasking-client cancellation or an assigned-Asset report.
// Asset contact, Task state and both change records commit in one transaction.
func (s *Service) UpdateStatus(ctx context.Context, caller identity.Caller, id uuid.UUID, update api.TaskStatusUpdate) (api.Task, error) {
	if err := s.datasets.RequireCurrent(update.DatasetId); err != nil {
		return api.Task{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return api.Task{}, err
	}
	defer tx.Rollback()
	queries := s.queries.WithTx(tx)
	row, err := queries.GetTask(ctx, id.String())
	if errors.Is(err, sql.ErrNoRows) {
		return api.Task{}, errNotFound
	}
	if err != nil {
		return api.Task{}, fmt.Errorf("read Task %s: %w", id, err)
	}
	current, err := s.toAPI(row)
	if err != nil {
		return api.Task{}, err
	}
	capabilities := taskCapabilities{Cancellation: row.CancellationSupported, Progress: row.ProgressSupported}
	if update.Status != nil && *update.Status == api.TaskStatusCancellationRequested {
		return s.cancel(ctx, tx, queries, caller, current, capabilities, update)
	}
	return s.report(ctx, tx, queries, caller, id, current, capabilities, update)
}

type taskCapabilities struct {
	Cancellation bool
	Progress     bool
}

func (s *Service) report(ctx context.Context, tx *sql.Tx, queries *db.Queries, caller identity.Caller, id uuid.UUID, current api.Task, capabilities taskCapabilities, update api.TaskStatusUpdate) (api.Task, error) {
	if caller.Kind != identity.Asset || caller.ID != current.AssetId.String() {
		return api.Task{}, errNotAssigned
	}
	if update.ReportId == nil || update.Sequence == nil || update.RequestId != nil {
		return api.Task{}, errInvalidStatus
	}
	// Include the Task identity in the report digest: one report ID cannot be
	// reused to change another Task even if its body happens to match.
	facts := struct {
		TaskID uuid.UUID            `json:"task_id"`
		Update api.TaskStatusUpdate `json:"update"`
	}{id, update}
	contact, resent, err := s.entities.AcceptTaskReport(ctx, tx, caller, current.AssetId.String(), update.DatasetId, update.ReportId.String(), *update.Sequence, facts)
	if err != nil {
		return api.Task{}, err
	}
	if resent {
		if contact.ChangeSequence > current.ChangeSequence {
			current.ReceiptSequence = &contact.ChangeSequence
		}
		return current, nil
	}
	status, err := validateReport(current, capabilities, update)
	if err != nil {
		return api.Task{}, err
	}
	if update.Status == nil && current.Status != api.TaskStatusInProgress && current.Status != api.TaskStatusCancellationRequested {
		return api.Task{}, errInvalidStatus
	}
	if terminal(current.Status) && current.Status == status && sameTerminalFacts(current, update) {
		current.ReceiptSequence = &contact.ChangeSequence
		return current, s.changes.Commit(tx)
	}
	if terminal(current.Status) || (update.Status != nil && !allowed(current.Status, status)) {
		return api.Task{}, errInvalidTransition
	}
	if update.ProgressPercent != nil && current.ProgressPercent != nil && *update.ProgressPercent < *current.ProgressPercent {
		return api.Task{}, errInvalidTransition
	}
	if current.Status == api.TaskStatusCancellationRequested && (status == api.TaskStatusAcknowledged || status == api.TaskStatusInProgress) {
		status = current.Status
	}
	return s.storeReport(ctx, tx, queries, id, current, status, update)
}

func validateReport(current api.Task, capabilities taskCapabilities, update api.TaskStatusUpdate) (api.TaskStatus, error) {
	if update.ProgressPercent != nil && !capabilities.Progress {
		return "", errUnsupportedProgress
	}
	status := current.Status
	if update.Status != nil {
		status = *update.Status
	}
	if update.Status == nil && update.ProgressPercent == nil {
		return "", errInvalidStatus
	}
	if status == api.TaskStatusCancelled {
		if update.CancellationRequestId == nil || current.CancellationRequestId == nil || *update.CancellationRequestId != *current.CancellationRequestId {
			return "", errInvalidTransition
		}
	} else if update.CancellationRequestId != nil {
		return "", errInvalidStatus
	}
	if status == api.TaskStatusFailed && update.FailureReason == nil {
		return "", errInvalidStatus
	}
	if status != api.TaskStatusFailed && update.FailureReason != nil {
		return "", errInvalidStatus
	}
	return status, nil
}

func (s *Service) storeReport(ctx context.Context, tx *sql.Tx, queries *db.Queries, id uuid.UUID, current api.Task, status api.TaskStatus, update api.TaskStatusUpdate) (api.Task, error) {
	progress := current.ProgressPercent
	if update.ProgressPercent != nil {
		progress = update.ProgressPercent
	}
	params := db.UpdateTaskStatusParams{ID: id.String(), Status: string(status), ProgressPercent: nullableFloat(progress), FailureReason: nullableString(update.FailureReason), CancellationRequestID: nullableUUID(current.CancellationRequestId)}
	if err := queries.UpdateTaskStatus(ctx, params); err != nil {
		return api.Task{}, fmt.Errorf("update Task status: %w", err)
	}
	task, err := s.publish(ctx, tx, id.String(), api.Update)
	if err != nil {
		return api.Task{}, err
	}
	return task, s.changes.Commit(tx)
}

func (s *Service) cancel(ctx context.Context, tx *sql.Tx, queries *db.Queries, caller identity.Caller, current api.Task, capabilities taskCapabilities, update api.TaskStatusUpdate) (api.Task, error) {
	if caller.Kind != identity.Operator && caller.Kind != identity.Plugin {
		return api.Task{}, errInvalidStatus
	}
	if update.RequestId == nil || update.ReportId != nil || update.Sequence != nil || update.ProgressPercent != nil || update.FailureReason != nil || update.CancellationRequestId != nil {
		return api.Task{}, errInvalidStatus
	}
	if terminal(current.Status) {
		return current, nil
	}
	if !capabilities.Cancellation {
		return api.Task{}, errUnsupportedCancellation
	}
	if current.Status == api.TaskStatusCancellationRequested {
		if current.CancellationRequestId != nil && *current.CancellationRequestId == *update.RequestId {
			return current, nil
		}
		return api.Task{}, errInvalidTransition
	}
	params := db.UpdateTaskStatusParams{ID: current.Id.String(), Status: string(*update.Status), ProgressPercent: nullableFloat(current.ProgressPercent), FailureReason: nullableString(current.FailureReason), CancellationRequestID: nullableUUID(update.RequestId)}
	if err := queries.UpdateTaskStatus(ctx, params); err != nil {
		if storage.IsConstraint(err) {
			return api.Task{}, errInvalidTransition
		}
		return api.Task{}, fmt.Errorf("request Task cancellation: %w", err)
	}
	if err := s.activity.Record(ctx, tx, caller, "task_cancellation_requested", current.Id); err != nil {
		return api.Task{}, err
	}
	task, err := s.publish(ctx, tx, current.Id.String(), api.Update)
	if err != nil {
		return api.Task{}, err
	}
	return task, s.changes.Commit(tx)
}

func terminal(status api.TaskStatus) bool {
	return status == api.TaskStatusCompleted || status == api.TaskStatusFailed || status == api.TaskStatusCancelled
}

func allowed(current, next api.TaskStatus) bool {
	switch next {
	case api.TaskStatusAcknowledged:
		return current == api.TaskStatusPending || current == api.TaskStatusCancellationRequested
	case api.TaskStatusInProgress:
		return current == api.TaskStatusPending || current == api.TaskStatusAcknowledged || current == api.TaskStatusInProgress || current == api.TaskStatusCancellationRequested
	case api.TaskStatusCompleted, api.TaskStatusFailed:
		return current == api.TaskStatusPending || current == api.TaskStatusAcknowledged || current == api.TaskStatusInProgress || current == api.TaskStatusCancellationRequested
	case api.TaskStatusCancelled:
		return current == api.TaskStatusCancellationRequested
	default:
		return false
	}
}

func sameTerminalFacts(current api.Task, update api.TaskStatusUpdate) bool {
	if current.Status == api.TaskStatusFailed && (current.FailureReason == nil || update.FailureReason == nil || *current.FailureReason != *update.FailureReason) {
		return false
	}
	if current.Status == api.TaskStatusCancelled && (current.CancellationRequestId == nil || update.CancellationRequestId == nil || *current.CancellationRequestId != *update.CancellationRequestId) {
		return false
	}
	if update.ProgressPercent != nil && (current.ProgressPercent == nil || *current.ProgressPercent != *update.ProgressPercent) {
		return false
	}
	return true
}

func nullableFloat(value *float64) sql.NullFloat64 {
	if value == nil {
		return sql.NullFloat64{}
	}
	return sql.NullFloat64{Float64: *value, Valid: true}
}

func nullableString(value *string) sql.NullString {
	if value == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: *value, Valid: true}
}

func nullableUUID(value *uuid.UUID) sql.NullString {
	if value == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: value.String(), Valid: true}
}
