package tasks

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strconv"

	"github.com/atlas-field-systems/atlas-core/entities"
	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/system"
	"github.com/atlas-field-systems/atlas-core/tasks/generated/storage"
	"github.com/oapi-codegen/nullable"
)

// slot is one requested-order position. An unstarted Task with unresolved
// cancellation keeps its slot excluded from the public requested order.
type slot struct {
	TaskID   string `json:"task_id"`
	Excluded bool   `json:"excluded"`
}

// queue is an Asset's Tasks-owned queue aggregate.
type queue struct {
	row   storage.AssetQueue
	slots []slot
}

func emptyQueue(assetID string) queue {
	return queue{row: storage.AssetQueue{AssetID: assetID, NextSubmission: 1, Slots: "[]", ConfirmedTaskIds: "[]", AdoptionState: "none"}}
}

func loadQueue(ctx context.Context, tx *sql.Tx, assetID string) (queue, error) {
	row, err := storage.New(tx).GetQueue(ctx, assetID)
	if errors.Is(err, sql.ErrNoRows) {
		return emptyQueue(assetID), nil
	}
	if err != nil {
		return queue{}, fmt.Errorf("read Task queue: %w", err)
	}
	q := queue{row: row}
	if err := json.Unmarshal([]byte(row.Slots), &q.slots); err != nil {
		return q, fmt.Errorf("decode Task queue: %w", err)
	}
	return q, nil
}

func (q *queue) requested() []string {
	ids := []string{}
	for _, s := range q.slots {
		if !s.Excluded {
			ids = append(ids, s.TaskID)
		}
	}
	return ids
}

// change applies a slot mutation and advances revisions only when the eligible
// requested order changed. It never implies Asset adoption.
func (q *queue) change(mutate func()) {
	before := q.requested()
	mutate()
	if !slices.Equal(before, q.requested()) {
		q.row.Revision++
		q.row.RequestedRevision = q.row.Revision
	}
}

func (q *queue) appendTask(taskID string) {
	q.change(func() { q.slots = append(q.slots, slot{TaskID: taskID}) })
}

func (q *queue) exclude(taskID string, excluded bool) {
	q.change(func() {
		for i := range q.slots {
			if q.slots[i].TaskID == taskID {
				q.slots[i].Excluded = excluded
			}
		}
	})
}

func (q *queue) remove(taskID string) {
	q.change(func() {
		q.slots = slices.DeleteFunc(q.slots, func(s slot) bool { return s.TaskID == taskID })
	})
}

// setActive records the explicitly reported active queued Task when the
// report's execution facts are newer than the current association.
func (q *queue) setActive(taskID string, ordering *entities.Token) {
	if ordering == nil {
		return
	}
	if q.row.ActiveTaskID.Valid && !ordering.After(entities.Token{Generation: q.row.ActiveGeneration.Int64, Sequence: q.row.ActiveSequence.Int64}) {
		return
	}
	q.row.ActiveTaskID = sql.NullString{String: taskID, Valid: true}
	q.row.ActiveGeneration = sql.NullInt64{Int64: ordering.Generation, Valid: true}
	q.row.ActiveSequence = sql.NullInt64{Int64: ordering.Sequence, Valid: true}
	q.row.Revision++
}

// clearActive removes the association only when it names the finished Task.
func (q *queue) clearActive(taskID string) {
	if q.row.ActiveTaskID.Valid && q.row.ActiveTaskID.String == taskID {
		q.row.ActiveTaskID = sql.NullString{}
		q.row.Revision++
	}
}

func (q *queue) save(ctx context.Context, tx *sql.Tx) error {
	encoded, err := json.Marshal(q.slots)
	if err != nil {
		return fmt.Errorf("encode Task queue: %w", err)
	}
	if q.slots == nil {
		encoded = []byte("[]")
	}
	r := q.row
	if err := storage.New(tx).PutQueue(ctx, storage.PutQueueParams{
		AssetID: r.AssetID, NextSubmission: r.NextSubmission, Revision: r.Revision, RequestedRevision: r.RequestedRevision,
		Slots: string(encoded), ConfirmedRevision: r.ConfirmedRevision, ConfirmedTaskIds: r.ConfirmedTaskIds,
		AdoptionState: r.AdoptionState, AdoptionRevision: r.AdoptionRevision, AdoptionReason: r.AdoptionReason,
		ActiveTaskID: r.ActiveTaskID, ActiveGeneration: r.ActiveGeneration, ActiveSequence: r.ActiveSequence,
		SuspendedTaskID: r.SuspendedTaskID,
	}); err != nil {
		return fmt.Errorf("record Task queue: %w", err)
	}
	return nil
}

func identifiers(ids []string) []protocol.Identifier {
	result := make([]protocol.Identifier, 0, len(ids))
	for _, id := range ids {
		var identifier protocol.Identifier
		if err := identifier.UnmarshalText([]byte(id)); err == nil {
			result = append(result, identifier)
		}
	}
	return result
}

func nullableCounter(value sql.NullInt64) nullable.Nullable[string] {
	if !value.Valid {
		return nullable.NewNullNullable[string]()
	}
	return nullable.NewNullableWithValue(strconv.FormatInt(value.Int64, 10))
}

func nullableID(value sql.NullString) nullable.Nullable[protocol.NullableIdentifier] {
	if !value.Valid {
		return nullable.NewNullNullable[protocol.NullableIdentifier]()
	}
	return nullable.NewNullableWithValue(identifiers([]string{value.String})[0])
}

// image is the public queue aggregate. Confirmed evidence stays null until an
// Asset reports adoption; S1 has no adoption route.
func (q *queue) image() (protocol.TaskQueue, error) {
	var confirmed []string
	if err := json.Unmarshal([]byte(q.row.ConfirmedTaskIds), &confirmed); err != nil {
		return protocol.TaskQueue{}, fmt.Errorf("decode confirmed queue: %w", err)
	}
	reason := nullable.NewNullNullable[string]()
	if q.row.AdoptionReason.Valid {
		reason = nullable.NewNullableWithValue(q.row.AdoptionReason.String)
	}
	return protocol.TaskQueue{
		Revision:           strconv.FormatInt(q.row.Revision, 10),
		RequestedRevision:  strconv.FormatInt(q.row.RequestedRevision, 10),
		RequestedTaskIds:   identifiers(q.requested()),
		ConfirmedRevision:  nullableCounter(q.row.ConfirmedRevision),
		ConfirmedTaskIds:   identifiers(confirmed),
		Adoption:           protocol.TaskQueueAdoption{State: protocol.QueueAdoptionState(q.row.AdoptionState), Revision: nullableCounter(q.row.AdoptionRevision), Reason: reason},
		ActiveQueuedTaskId: nullableID(q.row.ActiveTaskID),
		SuspendedTaskId:    nullableID(q.row.SuspendedTaskID),
	}, nil
}

// Queue implements the Entities collaborator: the Asset's queue aggregate.
func (m *Module) Queue(ctx context.Context, tx *sql.Tx, assetID string) (protocol.TaskQueue, error) {
	q, err := loadQueue(ctx, tx, system.CanonicalIdentifier(assetID))
	if err != nil {
		return protocol.TaskQueue{}, err
	}
	return q.image()
}

// NonterminalTaskIDs implements the Entities deletion guard.
func (m *Module) NonterminalTaskIDs(ctx context.Context, tx *sql.Tx, assetID string) ([]string, error) {
	ids, err := storage.New(tx).NonterminalTaskIDs(ctx, system.CanonicalIdentifier(assetID))
	if err != nil {
		return nil, fmt.Errorf("read nonterminal Tasks: %w", err)
	}
	return ids, nil
}
