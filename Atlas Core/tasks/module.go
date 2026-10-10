package tasks

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"github.com/atlas-field-systems/atlas-core/corefacts"
	"github.com/atlas-field-systems/atlas-core/entities"
	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/identity"
	"github.com/atlas-field-systems/atlas-core/retryidentity"
	storage "github.com/atlas-field-systems/atlas-core/tasks/generated/storage"
	"github.com/atlas-field-systems/atlas-core/writecommit"
	"github.com/google/uuid"
	"github.com/oapi-codegen/nullable"
	"strconv"
	"time"
)

//go:embed sql/schema.sql
var files embed.FS

func Schema() string { body, _ := files.ReadFile("sql/schema.sql"); return string(body) }

type Module struct {
	boundary           *writecommit.Boundary
	entities           *entities.Module
	identity           *identity.Module
	validate           func(protocol.Task) error
	maximumOutstanding int64
}

type Options struct {
	Validate           func(protocol.Task) error
	MaximumOutstanding int64
}

func New(b *writecommit.Boundary, e *entities.Module, id *identity.Module, options Options) *Module {
	return &Module{boundary: b, entities: e, identity: id, validate: options.Validate, maximumOutstanding: options.MaximumOutstanding}
}
func EmptyQueue() protocol.TaskQueue {
	return protocol.TaskQueue{Revision: "0", RequestedRevision: "0", RequestedTaskIds: []protocol.Identifier{}, ConfirmedRevision: nullable.NewNullNullable[string](), ConfirmedTaskIds: []protocol.Identifier{}, Adoption: protocol.QueueAdoption{State: "none", ReportedRevision: nullable.NewNullNullable[string](), Reason: nullable.NewNullNullable[string]()}, ActiveQueuedTaskId: nullable.NewNullNullable[protocol.Identifier](), SuspendedTaskId: nullable.NewNullNullable[protocol.Identifier](), ExecutionOrder: nullable.NewNullNullable[protocol.EvidenceOrigin]()}
}
func (m *Module) InitialQueue(ctx context.Context, c *writecommit.Commit, id string) (protocol.TaskQueue, error) {
	queue := EmptyQueue()
	body, err := json.Marshal(queue)
	if err != nil {
		return queue, err
	}
	return queue, storage.New(c.SQL).SaveQueue(ctx, storage.SaveQueueParams{AssetID: id, Value: string(body), NextSequence: 1})
}
func (m *Module) queue(ctx context.Context, c *writecommit.Commit, id string) (protocol.TaskQueue, int64, error) {
	row, err := storage.New(c.SQL).ReadQueue(ctx, id)
	if err != nil {
		return protocol.TaskQueue{}, 0, err
	}
	var queue protocol.TaskQueue
	err = json.Unmarshal([]byte(row.Value), &queue)
	return queue, row.NextSequence, err
}
func (m *Module) saveQueue(ctx context.Context, c *writecommit.Commit, id string, queue protocol.TaskQueue, sequence int64) error {
	body, err := json.Marshal(queue)
	if err != nil {
		return err
	}
	if err = storage.New(c.SQL).SaveQueue(ctx, storage.SaveQueueParams{AssetID: id, Value: string(body), NextSequence: sequence}); err != nil {
		return err
	}
	return m.entities.UpdateQueue(ctx, c, id, queue)
}
func (m *Module) read(ctx context.Context, c *writecommit.Commit, id string) (protocol.Task, error) {
	body, err := storage.New(c.SQL).ReadTask(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return protocol.Task{}, entities.ErrNotFound
	}
	if err != nil {
		return protocol.Task{}, err
	}
	var value protocol.Task
	err = json.Unmarshal([]byte(body), &value)
	return value, err
}
func (m *Module) save(ctx context.Context, c *writecommit.Commit, value *protocol.Task, advance bool) error {
	if advance {
		version, err := strconv.ParseUint(value.Version, 10, 64)
		if err != nil {
			return err
		}
		value.Version = strconv.FormatUint(version+1, 10)
		value.UpdatedAt = time.Now().UTC()
	}
	if m.validate != nil {
		if err := m.validate(*value); err != nil {
			return err
		}
	}
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	sequence, err := strconv.ParseInt(value.SubmissionSequence, 10, 64)
	if err != nil {
		return err
	}
	if err = storage.New(c.SQL).SaveTask(ctx, storage.SaveTaskParams{ID: value.Id.String(), AssetID: value.AssetId.String(), SubmissionSequence: sequence, Value: string(body)}); err != nil {
		return err
	}
	return c.Changed("task", value.Id.String(), value)
}
func (m *Module) Read(ctx context.Context, dataset string, principal identity.Principal, id string) (value protocol.Task, readContext protocol.HTTPReadContext, err error) {
	readContext, err = m.identity.Read(ctx, m.boundary, dataset, principal, func(c *writecommit.Commit) error { var e error; value, e = m.read(ctx, c, id); return e })
	return
}
func (m *Module) listInside(ctx context.Context, c *writecommit.Commit, asset string) (values []protocol.Task, err error) {
	q := storage.New(c.SQL)
	var bodies []string
	if asset == "" {
		bodies, err = q.ListTasks(ctx)
	} else {
		bodies, err = q.ListAssigned(ctx, asset)
	}
	if err != nil {
		return
	}
	values = []protocol.Task{}
	for _, body := range bodies {
		var value protocol.Task
		if err = json.Unmarshal([]byte(body), &value); err != nil {
			return
		}
		values = append(values, value)
	}
	return
}
func (m *Module) List(ctx context.Context, dataset, asset string) (values []protocol.Task, queue protocol.TaskQueue, err error) {
	err = m.boundary.Read(ctx, dataset, func(c *writecommit.Commit) error {
		var e error
		values, e = m.listInside(ctx, c, asset)
		if e != nil {
			return e
		}
		if asset != "" {
			if _, e = m.entities.ReadInside(ctx, c, asset); e != nil {
				return e
			}
			queue, _, e = m.queue(ctx, c, asset)
		}
		return e
	})
	return
}
func (m *Module) HasNonterminal(ctx context.Context, c *writecommit.Commit, asset string) (bool, error) {
	values, err := m.listInside(ctx, c, asset)
	if err != nil {
		return false, err
	}
	for _, value := range values {
		if !Terminal(value.Status) {
			return true, nil
		}
	}
	return false, nil
}
func (m *Module) Create(ctx context.Context, dataset string, principal identity.Principal, request protocol.CreateTaskRequest, raw []byte) (value protocol.Task, cursor string, err error) {
	cursor, err = m.boundary.Apply(ctx, dataset, func(c *writecommit.Commit) error {
		if principal.Kind != "operator" && principal.Kind != "plugin" {
			return identity.ErrForbidden
		}
		if e := m.identity.Authorize(ctx, c, principal); e != nil {
			return e
		}
		claim, e := retryidentity.Check(ctx, c, "task_creation", dataset, request.IdempotencyKey.String(), raw)
		if e != nil {
			return e
		}
		if claim.Replay {
			value, e = m.read(ctx, c, claim.ResultID)
			return e
		}
		asset, e := m.entities.ReadInside(ctx, c, request.AssetId.String())
		if e != nil {
			return e
		}
		if _, e = m.identity.Binding(ctx, c, request.AssetId.String()); e != nil {
			return e
		}
		supported := false
		for _, entry := range asset.CommandManifest {
			if entry.Command == "move_to" {
				for _, scheduling := range entry.Scheduling {
					if scheduling == "queued" {
						supported = true
					}
				}
			}
		}
		if !supported || request.Command != "move_to" || request.Scheduling != nil && *request.Scheduling != "queued" {
			return ErrUnsupported
		}
		count, e := storage.New(c.SQL).CountOutstanding(ctx, request.AssetId.String())
		if e != nil {
			return e
		}
		if count >= m.maximumOutstanding {
			return writecommit.ErrLimit
		}
		queue, sequence, e := m.queue(ctx, c, request.AssetId.String())
		if e != nil {
			return e
		}
		now := time.Now().UTC()
		value = protocol.Task{Id: uuid.New(), AssetId: request.AssetId, Command: "move_to", Input: request.Input, Scheduling: "queued", SubmissionSequence: strconv.FormatInt(sequence, 10), Status: "pending", ExecutionStatus: "pending", ExecutionId: nullable.NewNullNullable[protocol.Identifier](), Progress: nullable.NewNullNullable[protocol.MoveToProgress](), Failure: nullable.NewNullNullable[protocol.TaskFailure](), CancellationRequests: []protocol.CancellationRequest{}, AcknowledgedAt: nullable.NewNullNullable[string](), StartedAt: nullable.NewNullNullable[string](), FinishedAt: nullable.NewNullNullable[string](), CreatedAt: now, UpdatedAt: now, Version: "1"}
		if e = m.save(ctx, c, &value, false); e != nil {
			return e
		}
		revision, e := strconv.ParseUint(queue.Revision, 10, 64)
		if e != nil {
			return e
		}
		queue.Revision = strconv.FormatUint(revision+1, 10)
		queue.RequestedRevision = queue.Revision
		queue.RequestedTaskIds = append(queue.RequestedTaskIds, value.Id)
		if e = m.saveQueue(ctx, c, request.AssetId.String(), queue, sequence+1); e != nil {
			return e
		}
		if e = retryidentity.Store(ctx, c, claim, value.Id.String()); e != nil {
			return e
		}
		c.RecordAction(request.IdempotencyKey.String(), principal.ID, principal.Kind, "task_issued", value.Id.String(), request.AssetId.String())
		return c.CheckResponse(protocol.TaskMutationResponse{DatasetId: uuid.MustParse(c.Metadata.DatasetID), Data: value, CommitCursor: c.Cursor()})
	})
	return
}
func (m *Module) Cancel(ctx context.Context, dataset string, principal identity.Principal, id string, request protocol.RequestCancellationRequest, raw []byte) (value protocol.Task, cursor string, err error) {
	cursor, err = m.boundary.Apply(ctx, dataset, func(c *writecommit.Commit) error {
		if principal.Kind != "operator" && principal.Kind != "plugin" {
			return identity.ErrForbidden
		}
		if e := m.identity.Authorize(ctx, c, principal); e != nil {
			return e
		}
		claim, e := retryidentity.Check(ctx, c, "cancellation", id, request.RequestId.String(), raw)
		if e != nil {
			return e
		}
		value, e = m.read(ctx, c, id)
		if e != nil {
			return e
		}
		if claim.Replay {
			return nil
		}
		if Terminal(value.Status) {
			return ErrTerminal
		}
		if value.Status == "cancellation_requested" {
			return ErrTransition
		}
		reason := request.Reason
		if !reason.IsSpecified() {
			reason.SetNull()
		}
		value.CancellationRequests = append(value.CancellationRequests, protocol.CancellationRequest{RequestId: request.RequestId, Reason: reason, RequestedAt: time.Now().UTC(), Outcome: "pending", ResolvedAt: nullable.NewNullNullable[time.Time]()})
		value.Status = "cancellation_requested"
		if e = m.save(ctx, c, &value, true); e != nil {
			return e
		}
		if e = m.refreshQueue(ctx, c, value.AssetId.String(), nil, nil); e != nil {
			return e
		}
		if e = retryidentity.Store(ctx, c, claim, id); e != nil {
			return e
		}
		c.RecordAction(request.RequestId.String(), principal.ID, principal.Kind, "task_cancellation_requested", id)
		return c.CheckResponse(protocol.TaskMutationResponse{DatasetId: uuid.MustParse(c.Metadata.DatasetID), Data: value, CommitCursor: c.Cursor()})
	})
	return
}
func (m *Module) refreshQueue(ctx context.Context, c *writecommit.Commit, asset string, affected *protocol.Task, accepted *entities.AcceptedReport) error {
	queue, sequence, err := m.queue(ctx, c, asset)
	if err != nil {
		return err
	}
	values, err := m.listInside(ctx, c, asset)
	if err != nil {
		return err
	}
	requested := []protocol.Identifier{}
	for _, value := range values {
		if !Terminal(value.Status) && value.Status != "cancellation_requested" && (value.ExecutionStatus == "pending" || value.ExecutionStatus == "acknowledged") {
			requested = append(requested, value.Id)
		}
	}
	before, err := json.Marshal(queue)
	if err != nil {
		return err
	}
	queue.RequestedTaskIds = requested
	if accepted != nil {
		g, s, known := accepted.Order()
		if known {
			newer := true
			if !queue.ExecutionOrder.IsNull() {
				previous, e := queue.ExecutionOrder.Get()
				if e != nil {
					return e
				}
				pg, e := strconv.ParseUint(previous.ProcessGeneration, 10, 64)
				if e != nil {
					return e
				}
				ps, e := strconv.ParseUint(previous.Sequence, 10, 64)
				if e != nil {
					return e
				}
				newer = g > pg || g == pg && s > ps
			}
			if newer {
				if affected != nil {
					if affected.ExecutionStatus == "in_progress" && !Terminal(affected.Status) {
						queue.ActiveQueuedTaskId.Set(affected.Id)
					}
					if affected.ExecutionStatus == "paused" {
						queue.SuspendedTaskId.Set(affected.Id)
						if queue.ActiveQueuedTaskId.GetOrEmpty() == affected.Id {
							queue.ActiveQueuedTaskId.SetNull()
						}
					}
					if affected.ExecutionStatus == "in_progress" && queue.SuspendedTaskId.GetOrEmpty() == affected.Id {
						queue.SuspendedTaskId.SetNull()
					}
					if Terminal(affected.Status) && queue.SuspendedTaskId.GetOrEmpty() == affected.Id {
						queue.SuspendedTaskId.SetNull()
					}
				}
				if !queue.ActiveQueuedTaskId.IsNull() {
					active := queue.ActiveQueuedTaskId.GetOrEmpty()
					for _, value := range values {
						if value.Id == active && Terminal(value.Status) {
							queue.ActiveQueuedTaskId.SetNull()
						}
					}
				}
				queue.ExecutionOrder.Set(protocol.EvidenceOrigin{ProcessGeneration: strconv.FormatUint(g, 10), Sequence: strconv.FormatUint(s, 10)})
			}
		}
	}
	after, err := json.Marshal(queue)
	if err != nil {
		return err
	}
	if string(before) == string(after) {
		return nil
	}
	revision, err := strconv.ParseUint(queue.Revision, 10, 64)
	if err != nil {
		return err
	}
	queue.Revision = strconv.FormatUint(revision+1, 10)
	previousRequested := string(mustJSONRequested(before))
	currentRequested, err := json.Marshal(requested)
	if err != nil {
		return err
	}
	if previousRequested != string(currentRequested) {
		queue.RequestedRevision = queue.Revision
	}
	return m.saveQueue(ctx, c, asset, queue, sequence)
}
func mustJSONRequested(before []byte) []byte {
	var value struct {
		Requested json.RawMessage `json:"requested_task_ids"`
	}
	if err := json.Unmarshal(before, &value); err != nil {
		return nil
	}
	return value.Requested
}
func (m *Module) Report(ctx context.Context, principal identity.Principal, id string, request protocol.TaskReportRequest, report entities.Report) (value protocol.Task, receipt protocol.ReportAcceptance, cursor string, err error) {
	cursor, err = m.boundary.Apply(ctx, report.DatasetID, func(c *writecommit.Commit) error {
		current, e := m.read(ctx, c, id)
		if e != nil {
			return e
		}
		if current.AssetId != request.ReportContext.AssetId {
			return identity.ErrForbidden
		}
		_, receipt, _, e = m.entities.AcceptInside(ctx, c, principal, report, func(ctx context.Context, c *writecommit.Commit, a entities.AcceptedReport) (bool, error) {
			if !a.Valid() {
				return false, identity.ErrForbidden
			}
			q := storage.New(c.SQL)
			g, s, known := a.Order()
			identityKey := request.ReportContext.RetainedEvidenceId.GetOrEmpty().String()
			if known {
				identityKey = strconv.FormatUint(g, 10) + "/" + strconv.FormatUint(s, 10)
			}
			var body map[string]json.RawMessage
			if e := json.Unmarshal(report.Raw, &body); e != nil {
				return false, e
			}
			delete(body, "report_context")
			facts, e := corefacts.Encode(struct {
				Payload     map[string]json.RawMessage `json:"payload"`
				GeneratedAt nullable.Nullable[string]  `json:"generated_at"`
			}{body, request.ReportContext.GeneratedAt})
			if e != nil {
				return false, e
			}
			previous, e := q.ReadEvidence(ctx, storage.ReadEvidenceParams{TaskID: id, Identity: identityKey})
			if e == nil {
				if previous != string(facts) {
					return false, entities.ErrEvidence
				}
				value = current
				return false, nil
			}
			if !errors.Is(e, sql.ErrNoRows) {
				return false, e
			}
			newer := true
			if known {
				old, e := q.ReadOrder(ctx, id)
				if e == nil {
					oldSequence, e := strconv.ParseUint(old.Sequence, 10, 64)
					if e != nil {
						return false, e
					}
					newer = g > uint64(old.Generation) || g == uint64(old.Generation) && s > oldSequence
				} else if !errors.Is(e, sql.ErrNoRows) {
					return false, e
				}
			}
			next, changed, e := Transition(current, request, newer)
			if e != nil {
				return false, e
			}
			if e = q.PutEvidence(ctx, storage.PutEvidenceParams{TaskID: id, Identity: identityKey, Original: string(facts)}); e != nil {
				return false, e
			}
			if newer && known {
				if e = q.SaveOrder(ctx, storage.SaveOrderParams{TaskID: id, Generation: int64(g), Sequence: strconv.FormatUint(s, 10)}); e != nil {
					return false, e
				}
			}
			value = next
			if changed {
				now := time.Now().UTC()
				for i, cancellation := range value.CancellationRequests {
					if cancellation.Outcome != "pending" && cancellation.ResolvedAt.IsNull() {
						value.CancellationRequests[i].ResolvedAt.Set(now)
					}
				}
				if e = m.save(ctx, c, &value, true); e != nil {
					return false, e
				}
				var queueEvidence *entities.AcceptedReport
				if current.ExecutionStatus != value.ExecutionStatus || current.Status != value.Status {
					queueEvidence = &a
				}
				if e = m.refreshQueue(ctx, c, value.AssetId.String(), &value, queueEvidence); e != nil {
					return false, e
				}
			}
			return changed, nil
		})
		if e != nil {
			return e
		}
		value, e = m.read(ctx, c, id)
		if e != nil {
			return e
		}
		return c.CheckResponse(protocol.TaskReportResponse{DatasetId: uuid.MustParse(c.Metadata.DatasetID), Data: protocol.TaskReportResponseData{Task: value, Acceptance: receipt}, CommitCursor: c.Cursor()})
	})
	return
}
func (m *Module) Clear(ctx context.Context, c *writecommit.Commit) error {
	q := storage.New(c.SQL)
	for _, clear := range []func(context.Context) error{q.ClearTasks, q.ClearQueues, q.ClearOrder, q.ClearEvidence} {
		if err := clear(ctx); err != nil {
			return err
		}
	}
	return nil
}
