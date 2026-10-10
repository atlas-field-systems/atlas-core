// Package tasks owns Task records: admission against the Command Catalog and
// current Asset support, submission order, the queue aggregate, cancellation
// intent and Asset-reported lifecycle through the pure transition module.
package tasks

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"

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

//go:embed sql/installation.sql
var installationSchema string

//go:embed sql/dataset.sql
var datasetSchema string

// ResourceKind names Task changes in the commit change log.
const ResourceKind = "task"

// Retry identity kinds owned by Tasks.
const (
	CreationClaim     = "task_creation"
	CancellationClaim = "task_cancellation"
)

// MaxOutstandingPerAsset is the initial admission bound for outstanding Tasks.
const MaxOutstandingPerAsset = 1000

// Module is the Tasks module.
type Module struct {
	store    *system.Store
	entities *entities.Module
}

// New constructs Tasks and wires it into Entities as its collaborator.
func New(store *system.Store, assets *entities.Module) *Module {
	m := &Module{store: store, entities: assets}
	assets.SetTasks(m)
	return m
}

func (m *Module) Name() string               { return "tasks" }
func (m *Module) InstallationSchema() string { return installationSchema }
func (m *Module) DatasetSchema() string      { return datasetSchema }
func (m *Module) DatasetTables() []string {
	return []string{"tasks", "task_cancellations", "asset_queues"}
}

// OpenRetained keeps recorded statuses and reports. A Core interruption
// establishes no Asset outcome and reissues nothing.
func (m *Module) OpenRetained(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, "SELECT task_id, input FROM tasks")
	if err != nil {
		return fmt.Errorf("scan retained Tasks: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, input string
		if err := rows.Scan(&id, &input); err != nil {
			return fmt.Errorf("scan retained Task: %w", err)
		}
		if !json.Valid([]byte(input)) {
			return fmt.Errorf("retained Task %s has an integrity fault", id)
		}
	}
	return rows.Err()
}

type lifecycleEvent struct {
	ReportedAt *string `json:"reported_at"`
	ReceivedAt string  `json:"received_at"`
}

func eventTime(raw sql.NullString) (protocol.TaskLifecycleEvent, bool, error) {
	if !raw.Valid {
		return protocol.TaskLifecycleEvent{}, false, nil
	}
	var event protocol.TaskLifecycleEvent
	if err := json.Unmarshal([]byte(raw.String), &event); err != nil {
		return event, false, fmt.Errorf("decode Task lifecycle time: %w", err)
	}
	return event, true, nil
}

func nullableEvent(raw sql.NullString) (nullable.Nullable[protocol.TaskLifecycleEvent], error) {
	event, ok, err := eventTime(raw)
	if err != nil || !ok {
		return nullable.NewNullNullable[protocol.TaskLifecycleEvent](), err
	}
	return nullable.NewNullableWithValue(event), nil
}

// image builds the public Task.
func image(ctx context.Context, tx *sql.Tx, row storage.Task) (protocol.Task, error) {
	var task protocol.Task
	var input protocol.MoveTo
	if err := json.Unmarshal([]byte(row.Input), &input); err != nil {
		return task, fmt.Errorf("decode Task input: %w", err)
	}
	var id, asset, creator protocol.Identifier
	for target, value := range map[*protocol.Identifier]string{&id: row.TaskID, &asset: row.AssetID, &creator: row.CreatedByID} {
		if err := target.UnmarshalText([]byte(value)); err != nil {
			return task, fmt.Errorf("decode stored identifier: %w", err)
		}
	}
	task = protocol.Task{
		Id: id, AssetId: asset, Command: protocol.CommandName(row.Command), Scheduling: protocol.TaskScheduling(row.Scheduling),
		Input: input, SubmissionSequence: strconv.FormatInt(row.SubmissionSequence, 10), Status: protocol.TaskStatus(row.Status),
		Version: strconv.FormatInt(row.Version, 10), CreatedBy: protocol.Actor{PrincipalId: creator, Kind: protocol.PrincipalKind(row.CreatedByKind)},
		CreatedAt: system.ParseTime(row.CreatedAt), UpdatedAt: system.ParseTime(row.UpdatedAt), Cancellations: []protocol.TaskCancellation{},
	}
	var err error
	if task.Lifecycle.Acknowledged, err = nullableEvent(row.Acknowledged); err != nil {
		return task, err
	}
	if task.Lifecycle.Started, err = nullableEvent(row.Started); err != nil {
		return task, err
	}
	if task.Lifecycle.Finished, err = nullableEvent(row.Finished); err != nil {
		return task, err
	}
	if row.Progress.Valid {
		var progress protocol.TaskProgress
		if err := json.Unmarshal([]byte(row.Progress.String), &progress); err != nil {
			return task, fmt.Errorf("decode Task progress: %w", err)
		}
		task.Progress = &progress
	}
	if row.Failure.Valid {
		var failure protocol.TaskFailure
		if err := json.Unmarshal([]byte(row.Failure.String), &failure); err != nil {
			return task, fmt.Errorf("decode Task failure: %w", err)
		}
		task.Failure = &failure
	}
	cancellations, err := storage.New(tx).TaskCancellations(ctx, row.TaskID)
	if err != nil {
		return task, fmt.Errorf("read Task cancellations: %w", err)
	}
	for _, c := range cancellations {
		var cancellationID, requester protocol.Identifier
		if err := cancellationID.UnmarshalText([]byte(c.CancellationID)); err != nil {
			return task, fmt.Errorf("decode cancellation identity: %w", err)
		}
		if err := requester.UnmarshalText([]byte(c.RequestedByID)); err != nil {
			return task, fmt.Errorf("decode cancellation requester: %w", err)
		}
		resolution, err := nullableEvent(c.Resolution)
		if err != nil {
			return task, err
		}
		reason := nullable.NewNullNullable[string]()
		if c.Reason.Valid {
			reason = nullable.NewNullableWithValue(c.Reason.String)
		}
		task.Cancellations = append(task.Cancellations, protocol.TaskCancellation{
			CancellationId: cancellationID, RequestedBy: protocol.Actor{PrincipalId: requester, Kind: protocol.PrincipalKind(c.RequestedByKind)},
			RequestedAt: system.ParseTime(c.RequestedAt), Reason: reason, State: protocol.CancellationState(c.State), Resolution: resolution,
		})
	}
	return task, nil
}

func loadTask(ctx context.Context, tx *sql.Tx, id string) (storage.Task, error) {
	row, err := storage.New(tx).GetTask(ctx, system.CanonicalIdentifier(id))
	if errors.Is(err, sql.ErrNoRows) {
		return row, coreerr.NotFound("The Task does not exist in this Dataset")
	}
	if err != nil {
		return row, fmt.Errorf("read Task: %w", err)
	}
	return row, nil
}

// Get reads one Task.
func (m *Module) Get(ctx context.Context, datasetID, id string) (protocol.Task, error) {
	var task protocol.Task
	err := m.store.Read(ctx, datasetID, func(tx *sql.Tx) error {
		row, err := loadTask(ctx, tx, id)
		if err != nil {
			return err
		}
		task, err = image(ctx, tx, row)
		return err
	})
	return task, err
}

// saveTask stamps the commit's version, persists and publishes the Task.
func saveTask(ctx context.Context, tx *system.Tx, row *storage.Task) (protocol.Task, error) {
	seq, err := tx.Seq()
	if err != nil {
		return protocol.Task{}, err
	}
	row.Version, row.UpdatedAt = seq, system.FormatTime(tx.Now())
	if err := storage.New(tx.SQL()).UpdateTask(ctx, storage.UpdateTaskParams{
		Status: row.Status, ExecutionStatus: row.ExecutionStatus, Version: row.Version, UpdatedAt: row.UpdatedAt,
		Acknowledged: row.Acknowledged, Started: row.Started, Finished: row.Finished, Progress: row.Progress,
		ProgressGeneration: row.ProgressGeneration, ProgressSequence: row.ProgressSequence, Failure: row.Failure, TaskID: row.TaskID,
	}); err != nil {
		return protocol.Task{}, fmt.Errorf("update Task: %w", err)
	}
	task, err := image(ctx, tx.SQL(), *row)
	if err != nil {
		return task, err
	}
	return task, tx.Publish(ResourceKind, row.TaskID, seq, task)
}

// Mutation is a committed or replayed Task result.
type Mutation struct {
	Task    protocol.Task
	Report  *protocol.ReportResult
	Cursor  string
	Created bool
}

type creationFacts struct {
	AssetID    string          `json:"asset_id"`
	Scheduling string          `json:"scheduling"`
	Input      json.RawMessage `json:"input"`
}

// Create admits one Task for one Asset, including while it is offline. S1
// admits queued Move To with a named position target and no deadline.
func (m *Module) Create(ctx context.Context, principal identity.Principal, datasetID string, raw []byte, body protocol.TaskCreate) (Mutation, error) {
	scheduling := protocol.Queued
	if body.Scheduling != nil {
		scheduling = *body.Scheduling
	}
	if scheduling != protocol.Queued {
		return Mutation{}, coreerr.Invalid("unsupported_scheduling", "S1 admits queued Move To only").Paths("/scheduling")
	}
	target, err := body.Input.Target.Discriminator()
	if err != nil {
		return Mutation{}, fmt.Errorf("decode validated Move To target: %w", err)
	}
	if target != "position" {
		return Mutation{}, coreerr.Invalid("unsupported_target", "S1 admits named position targets only").Paths("/input/target/kind")
	}
	members, err := canonical.Members(raw)
	if err != nil {
		return Mutation{}, err
	}
	assetID := system.CanonicalIdentifier(body.AssetId.String())
	encodedFacts, err := json.Marshal(creationFacts{AssetID: assetID, Scheduling: string(scheduling), Input: members["input"]})
	if err != nil {
		return Mutation{}, fmt.Errorf("encode Task creation facts: %w", err)
	}
	facts, err := canonical.Transform(encodedFacts)
	if err != nil {
		return Mutation{}, err
	}
	var result Mutation
	cursor, err := m.store.Commit(ctx, datasetID, "task.create", func(tx *system.Tx) error {
		if err := identity.CheckActive(ctx, tx.SQL(), principal); err != nil {
			return err
		}
		if principal.Kind != identity.Operator {
			return coreerr.Forbidden("forbidden", "Tasking clients create Tasks; Assets report execution")
		}
		claim, err := tx.Claim(CreationClaim, body.RequestId.String(), facts)
		if err != nil {
			return err
		}
		switch claim.Outcome {
		case system.Conflict, system.Ended:
			return coreerr.Conflict("request_conflict", "The creation identity was already used with different tasking facts")
		case system.Replay:
			row, err := loadTask(ctx, tx.SQL(), claim.ResultRef)
			if err != nil {
				return err
			}
			task, err := image(ctx, tx.SQL(), row)
			result = Mutation{Task: task, Cursor: claim.Cursor}
			return err
		}
		asset, err := m.entities.AdmissionFacts(ctx, tx.SQL(), assetID)
		if err != nil {
			if rejection, ok := coreerr.As(err); ok && rejection.Status == http.StatusNotFound {
				return coreerr.Invalid("unknown_asset", "The assigned Asset is not registered in this Dataset").Paths("/asset_id")
			}
			return err
		}
		if !supports(asset.CommandManifest, protocol.CommandNameMoveTo, scheduling) {
			return coreerr.Invalid("command_not_supported", "The Asset does not currently advertise queued Move To support").Paths("/input/command")
		}
		queries := storage.New(tx.SQL())
		outstanding, err := queries.OutstandingCount(ctx, assetID)
		if err != nil {
			return fmt.Errorf("count outstanding Tasks: %w", err)
		}
		if outstanding >= MaxOutstandingPerAsset {
			return coreerr.New(http.StatusTooManyRequests, "resource_limit", fmt.Sprintf("The Asset already has %d outstanding Tasks", MaxOutstandingPerAsset))
		}
		q, err := loadQueue(ctx, tx.SQL(), assetID)
		if err != nil {
			return err
		}
		seq, err := tx.Seq()
		if err != nil {
			return err
		}
		taskID := uuid.NewString()
		now := system.FormatTime(tx.Now())
		row := storage.InsertTaskParams{
			TaskID: taskID, AssetID: assetID, Command: string(protocol.CommandNameMoveTo), Scheduling: string(scheduling),
			Input: string(members["input"]), SubmissionSequence: q.row.NextSubmission, Status: string(Pending), ExecutionStatus: string(Pending),
			Version: seq, CreatedByID: principal.ID, CreatedByKind: string(principal.Kind), CreatedAt: now, UpdatedAt: now,
		}
		if err := queries.InsertTask(ctx, row); err != nil {
			return fmt.Errorf("record Task: %w", err)
		}
		q.row.NextSubmission++
		q.appendTask(taskID)
		if err := q.save(ctx, tx.SQL()); err != nil {
			return err
		}
		stored, err := loadTask(ctx, tx.SQL(), taskID)
		if err != nil {
			return err
		}
		task, err := image(ctx, tx.SQL(), stored)
		if err != nil {
			return err
		}
		if err := tx.Publish(ResourceKind, taskID, seq, task); err != nil {
			return err
		}
		if err := m.entities.QueueChanged(ctx, tx, assetID); err != nil {
			return err
		}
		if err := tx.Complete(CreationClaim, body.RequestId.String(), facts, []byte(strconv.Quote(taskID)), taskID); err != nil {
			return err
		}
		tx.Record(system.Activity{
			ActionID: uuid.NewString(), Actor: principal.Actor(), Action: "task.issue", TargetKind: "task", TargetID: taskID,
			Outcome: "accepted", Summary: map[string]any{"asset_id": assetID, "command": row.Command, "scheduling": row.Scheduling},
		})
		result = Mutation{Task: task, Created: true}
		return nil
	})
	if err == nil && cursor != "" {
		result.Cursor = cursor
	}
	return result, err
}

func supports(manifest protocol.CommandManifest, command protocol.CommandName, scheduling protocol.TaskScheduling) bool {
	return slices.ContainsFunc(manifest, func(support protocol.CommandSupport) bool {
		return support.Command == command && slices.Contains(support.Scheduling, scheduling)
	})
}
