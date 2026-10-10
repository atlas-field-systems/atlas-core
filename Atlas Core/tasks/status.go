package tasks

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/atlas-field-systems/atlas-core/canonical"
	"github.com/atlas-field-systems/atlas-core/coreerr"
	"github.com/atlas-field-systems/atlas-core/entities"
	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/identity"
	"github.com/atlas-field-systems/atlas-core/system"
	"github.com/atlas-field-systems/atlas-core/tasks/generated/storage"
	"github.com/google/uuid"
	"github.com/oapi-codegen/nullable"
)

// state reads the transition module's view of a stored Task.
func state(ctx context.Context, tx *sql.Tx, row storage.Task) (State, []storage.TaskCancellation, error) {
	cancellations, err := storage.New(tx).TaskCancellations(ctx, row.TaskID)
	if err != nil {
		return State{}, nil, fmt.Errorf("read Task cancellations: %w", err)
	}
	s := State{Status: Status(row.Status), Execution: Status(row.ExecutionStatus)}
	for _, c := range cancellations {
		switch Resolution(c.State) {
		case Requested:
			s.PendingCancellation = c.CancellationID
		case Confirmed:
			s.ConfirmedCancellation = c.CancellationID
		case Declined:
			s.DeclinedCancellations = append(s.DeclinedCancellations, c.CancellationID)
		}
	}
	return s, cancellations, nil
}

// RequestCancellation records a tasking client's cancellation intent. It does
// not establish that execution stopped; only the assigned Asset resolves it.
func (m *Module) RequestCancellation(ctx context.Context, principal identity.Principal, datasetID, taskID string, raw []byte, request protocol.TaskCancellationRequest) (Mutation, error) {
	reason := json.RawMessage("null")
	members, err := canonical.Members(raw)
	if err != nil {
		return Mutation{}, err
	}
	if value, ok := members["reason"]; ok {
		reason = value
	}
	facts, err := canonical.Object(map[string]json.RawMessage{"task_id": canonical.String(system.CanonicalIdentifier(taskID)), "reason": reason})
	if err != nil {
		return Mutation{}, err
	}
	var result Mutation
	cursor, err := m.store.Commit(ctx, datasetID, "task.request_cancellation", func(tx *system.Tx) error {
		if err := identity.CheckActive(ctx, tx.SQL(), principal); err != nil {
			return err
		}
		if principal.Kind != identity.Operator {
			return coreerr.Forbidden("forbidden", "Tasking clients request cancellation; the assigned Asset reports its decision")
		}
		claim, err := tx.Claim(CancellationClaim, request.CancellationId.String(), facts)
		if err != nil {
			return err
		}
		switch claim.Outcome {
		case system.Conflict, system.Ended:
			return coreerr.Conflict("request_conflict", "The cancellation identity was already used with different facts")
		case system.Replay:
			row, err := loadTask(ctx, tx.SQL(), taskID)
			if err != nil {
				return err
			}
			task, err := image(ctx, tx.SQL(), row)
			result = Mutation{Task: task, Cursor: claim.Cursor}
			return err
		}
		row, err := loadTask(ctx, tx.SQL(), taskID)
		if err != nil {
			return err
		}
		current, cancellations, err := state(ctx, tx.SQL(), row)
		if err != nil {
			return err
		}
		cancellationID := system.CanonicalIdentifier(request.CancellationId.String())
		decision, err := Apply(current, Event{Kind: RequestCancellation, CancellationID: cancellationID})
		if err != nil {
			return err
		}
		row.Status = string(decision.Next.Status)
		var storedReason sql.NullString
		if request.Reason.IsSpecified() && !request.Reason.IsNull() {
			storedReason = sql.NullString{String: request.Reason.MustGet(), Valid: true}
		}
		if err := storage.New(tx.SQL()).InsertCancellation(ctx, storage.InsertCancellationParams{
			TaskID: row.TaskID, CancellationID: cancellationID, Ordinal: int64(len(cancellations)), RequestedByID: principal.ID,
			RequestedByKind: string(principal.Kind), RequestedAt: system.FormatTime(tx.Now()), Reason: storedReason, State: string(Requested),
		}); err != nil {
			return fmt.Errorf("record cancellation request: %w", err)
		}
		task, err := saveTask(ctx, tx, &row)
		if err != nil {
			return err
		}
		if current.Execution.unstarted() {
			if err := m.updateQueue(ctx, tx, row.AssetID, func(q *queue) { q.exclude(row.TaskID, true) }); err != nil {
				return err
			}
		}
		if err := tx.Complete(CancellationClaim, cancellationID, facts, []byte(strconv.Quote(cancellationID)), row.TaskID); err != nil {
			return err
		}
		tx.Record(system.Activity{
			ActionID: uuid.NewString(), Actor: principal.Actor(), Action: "task.request_cancellation", TargetKind: "task", TargetID: row.TaskID,
			Outcome: "recorded", Summary: map[string]any{"cancellation_id": cancellationID, "asset_id": row.AssetID},
		})
		result = Mutation{Task: task}
		return nil
	})
	if err == nil && cursor != "" {
		result.Cursor = cursor
	}
	return result, err
}

func (m *Module) updateQueue(ctx context.Context, tx *system.Tx, assetID string, mutate func(*queue)) error {
	q, err := loadQueue(ctx, tx.SQL(), assetID)
	if err != nil {
		return err
	}
	before := q.row.Revision
	mutate(&q)
	if q.row.Revision == before {
		return nil
	}
	if err := q.save(ctx, tx.SQL()); err != nil {
		return err
	}
	return m.entities.QueueChanged(ctx, tx, assetID)
}

func eventJSON(acceptance *entities.Acceptance) (sql.NullString, error) {
	event := protocol.TaskLifecycleEvent{ReceivedAt: acceptance.ReceivedAt.UTC(), ReportedAt: nullable.NewNullNullable[time.Time]()}
	if acceptance.GeneratedAt != nil {
		event.ReportedAt = nullable.NewNullableWithValue(*acceptance.GeneratedAt)
	}
	encoded, err := json.Marshal(event)
	if err != nil {
		return sql.NullString{}, fmt.Errorf("encode Task lifecycle time: %w", err)
	}
	return sql.NullString{String: string(encoded), Valid: true}, nil
}

// Report records the assigned Asset's lifecycle evidence through shared
// report acceptance and the pure transition module in one commit.
func (m *Module) Report(ctx context.Context, principal identity.Principal, datasetID string, env entities.Envelope, report protocol.TaskLifecycleReport) (Mutation, error) {
	env.Context = report.ReportContext
	if err := validateReport(report); err != nil {
		return Mutation{}, err
	}
	var result Mutation
	cursor, err := m.store.Commit(ctx, datasetID, "report.task_status", func(tx *system.Tx) error {
		row, err := loadTask(ctx, tx.SQL(), env.TargetID)
		if err != nil {
			return err
		}
		if !system.SameIdentifier(row.AssetID, report.ReportContext.AssetId.String()) {
			return coreerr.Forbidden("forbidden", "Only the assigned Asset reports this Task's execution")
		}
		acceptance, duplicate, err := m.entities.Accept(ctx, tx, principal, env)
		if err != nil {
			return err
		}
		if duplicate != nil {
			task, err := image(ctx, tx.SQL(), row)
			if err != nil {
				return err
			}
			reportResult := duplicate.Result
			result = Mutation{Task: task, Report: &reportResult, Cursor: duplicate.Cursor}
			return nil
		}
		if len(acceptance.ObservationTimes) > 0 {
			return coreerr.Invalid("invalid_report", "Task reports supply no movement quantities").Paths("/report_context/observation_times")
		}
		current, _, err := state(ctx, tx.SQL(), row)
		if err != nil {
			return err
		}
		event := Event{Kind: EventKind(report.Event)}
		if report.CancellationId != nil {
			event.CancellationID = system.CanonicalIdentifier(report.CancellationId.String())
		}
		decision, err := Apply(current, event)
		if err != nil {
			return err
		}
		applied, err := m.applyDecision(ctx, tx, &row, acceptance, report, current, decision)
		if err != nil {
			return err
		}
		effect := "unchanged"
		var task protocol.Task
		if len(applied) > 0 {
			effect = "changed"
			if task, err = saveTask(ctx, tx, &row); err != nil {
				return err
			}
		} else if task, err = image(ctx, tx.SQL(), row); err != nil {
			return err
		}
		reportResult, _, _, err := m.entities.Finish(ctx, tx, acceptance, entities.Effects{AppliedFields: applied, TaskEffect: effect})
		if err != nil {
			return err
		}
		result = Mutation{Task: task, Report: &reportResult}
		return nil
	})
	if err == nil && cursor != "" {
		result.Cursor = cursor
	}
	return result, err
}

func validateReport(report protocol.TaskLifecycleReport) error {
	cancellationEvent := report.Event == protocol.TaskReportEventCancellationConfirmed || report.Event == protocol.TaskReportEventCancellationDeclined
	switch {
	case (report.Event == protocol.TaskReportEventFailed) != (report.Failure != nil):
		return coreerr.Invalid("invalid_report", "A failure report carries failure, and only a failure report does").Paths("/failure")
	case cancellationEvent != (report.CancellationId != nil):
		return coreerr.Invalid("invalid_report", "Cancellation decisions identify their request, and only they do").Paths("/cancellation_id")
	case cancellationEvent && report.Progress != nil:
		return coreerr.Invalid("invalid_report", "Cancellation decisions carry no progress").Paths("/progress")
	}
	return nil
}

// applyDecision persists a transition decision and the report's execution
// facts. Progress values follow the Task's execution-stream ordering.
func (m *Module) applyDecision(ctx context.Context, tx *system.Tx, row *storage.Task, acceptance *entities.Acceptance, report protocol.TaskLifecycleReport, before State, decision Decision) ([]string, error) {
	var applied []string
	if decision.Changed {
		if row.Status != string(decision.Next.Status) || row.ExecutionStatus != string(decision.Next.Execution) {
			applied = append(applied, "/status")
		}
		row.Status, row.ExecutionStatus = string(decision.Next.Status), string(decision.Next.Execution)
	}
	now, err := eventJSON(acceptance)
	if err != nil {
		return nil, err
	}
	switch {
	case decision.Next.Execution == Acknowledged && before.Execution == Pending:
		row.Acknowledged = now
	case decision.Started:
		row.Started = now
	}
	if decision.Terminal {
		row.Finished = now
		if report.Failure != nil {
			encoded, err := json.Marshal(report.Failure)
			if err != nil {
				return nil, fmt.Errorf("encode Task failure: %w", err)
			}
			row.Failure = sql.NullString{String: string(encoded), Valid: true}
		}
	}
	if report.Progress != nil && (decision.Terminal || !Status(row.Status).Terminal()) {
		if report.Progress.Details != nil && string(report.Progress.Details.Command) != row.Command {
			return nil, coreerr.Invalid("invalid_report", "Progress details belong to another Command").Paths("/progress/details/command")
		}
		newer := acceptance.Ordering != nil && (!row.ProgressGeneration.Valid ||
			acceptance.Ordering.After(entities.Token{Generation: row.ProgressGeneration.Int64, Sequence: row.ProgressSequence.Int64}))
		if newer || (acceptance.Ordering == nil && !row.Progress.Valid) {
			progress := protocol.TaskProgress{Fraction: report.Progress.Fraction, Details: report.Progress.Details, ReceivedAt: acceptance.ReceivedAt.UTC(), ReportedAt: nullable.NewNullNullable[time.Time]()}
			if !progress.Fraction.IsSpecified() {
				progress.Fraction = nullable.NewNullNullable[float64]()
			}
			if acceptance.GeneratedAt != nil {
				progress.ReportedAt = nullable.NewNullableWithValue(*acceptance.GeneratedAt)
			}
			encoded, err := json.Marshal(progress)
			if err != nil {
				return nil, fmt.Errorf("encode Task progress: %w", err)
			}
			row.Progress = sql.NullString{String: string(encoded), Valid: true}
			if acceptance.Ordering != nil {
				row.ProgressGeneration = sql.NullInt64{Int64: acceptance.Ordering.Generation, Valid: true}
				row.ProgressSequence = sql.NullInt64{Int64: acceptance.Ordering.Sequence, Valid: true}
			}
			applied = append(applied, "/progress")
		}
	}
	if decision.Resolution != NoResolution {
		cancellationID := event(report)
		if decision.Resolution == Closed {
			cancellationID = before.PendingCancellation
		}
		resolution, err := eventJSON(acceptance)
		if err != nil {
			return nil, err
		}
		if err := storage.New(tx.SQL()).ResolveCancellation(ctx, storage.ResolveCancellationParams{State: string(decision.Resolution), Resolution: resolution, TaskID: row.TaskID, CancellationID: cancellationID}); err != nil {
			return nil, fmt.Errorf("record cancellation resolution: %w", err)
		}
		applied = append(applied, "/cancellations")
	}
	if row.Scheduling == string(protocol.Queued) {
		err := m.updateQueue(ctx, tx, row.AssetID, func(q *queue) {
			switch {
			case decision.Terminal:
				q.remove(row.TaskID)
				q.clearActive(row.TaskID)
			case decision.Started:
				q.remove(row.TaskID)
				q.setActive(row.TaskID, acceptance.Ordering)
			case decision.Restored:
				q.exclude(row.TaskID, false)
			case decision.Resolution == Declined:
				q.remove(row.TaskID)
			}
		})
		if err != nil {
			return nil, err
		}
	}
	return applied, nil
}

func event(report protocol.TaskLifecycleReport) string {
	if report.CancellationId == nil {
		return ""
	}
	return system.CanonicalIdentifier(report.CancellationId.String())
}
