package tasks

import (
	"context"
	"database/sql"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/atlas-field-systems/atlas-core/entities"
	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/system"
	"github.com/atlas-field-systems/atlas-core/tasks/generated/storage"
	"github.com/oapi-codegen/nullable"
)

const scanBatch = 256

// List returns Tasks in permanent ID order with AND-combined filters.
func (m *Module) List(ctx context.Context, datasetID string, params protocol.ListTasksParams) (protocol.TaskPage, error) {
	limit := entities.PageSize(params.Limit)
	filters := struct {
		IDs        *[]protocol.Identifier     `json:"ids"`
		Assets     *[]protocol.Identifier     `json:"asset_id"`
		Statuses   *[]protocol.TaskStatus     `json:"status"`
		Scheduling *[]protocol.TaskScheduling `json:"scheduling"`
	}{params.Ids, params.AssetId, params.Status, params.Scheduling}
	scope, err := entities.Scope(filters)
	if err != nil {
		return protocol.TaskPage{}, err
	}
	contains := func(values *[]protocol.Identifier, value string) bool {
		return values == nil || slices.ContainsFunc(*values, func(id protocol.Identifier) bool { return id.String() == value })
	}
	match := func(row storage.Task) bool {
		return contains(filters.IDs, row.TaskID) && contains(filters.Assets, row.AssetID) &&
			(filters.Statuses == nil || slices.Contains(*filters.Statuses, protocol.TaskStatus(row.Status))) &&
			(filters.Scheduling == nil || slices.Contains(*filters.Scheduling, protocol.TaskScheduling(row.Scheduling)))
	}
	page := protocol.TaskPage{Items: []protocol.Task{}, NextPageToken: nullable.NewNullNullable[string]()}
	err = m.store.Read(ctx, datasetID, func(tx *sql.Tx) error {
		after := ""
		if params.PageToken != nil {
			token, err := m.store.OpenToken(*params.PageToken, "tasks", scope, limit)
			if err != nil {
				return err
			}
			after = token.After
		}
		queries := storage.New(tx)
		more := false
		for !more {
			rows, err := queries.ListTasks(ctx, storage.ListTasksParams{TaskID: after, Limit: scanBatch})
			if err != nil {
				return fmt.Errorf("list Tasks: %w", err)
			}
			for _, row := range rows {
				after = row.TaskID
				if !match(row) {
					continue
				}
				if len(page.Items) == limit {
					more = true
					break
				}
				task, err := image(ctx, tx, row)
				if err != nil {
					return err
				}
				page.Items = append(page.Items, task)
			}
			if len(rows) < scanBatch {
				break
			}
		}
		if more {
			token, err := m.store.SealToken(system.PageToken{Kind: "tasks", Scope: scope, Limit: limit, After: page.Items[limit-1].Id.String()})
			if err != nil {
				return err
			}
			page.NextPageToken = nullable.NewNullableWithValue(token)
		}
		return nil
	})
	return page, err
}

// Assigned returns an Asset's Tasks in default requested order: Immediate
// Tasks by submission sequence, then Queued Tasks by requested order with
// submission sequence and ID as tie-breakers. Every page pins the queue
// revision; listing never acknowledges, starts or adopts work.
func (m *Module) Assigned(ctx context.Context, datasetID, assetID string, params protocol.ListAssignedTasksParams) (protocol.AssignedTaskPage, error) {
	limit := entities.PageSize(params.Limit)
	outstanding := params.Outstanding != nil && *params.Outstanding
	assetID = system.CanonicalIdentifier(assetID)
	scope, err := entities.Scope([]any{assetID, outstanding})
	if err != nil {
		return protocol.AssignedTaskPage{}, err
	}
	var page protocol.AssignedTaskPage
	err = m.store.Read(ctx, datasetID, func(tx *sql.Tx) error {
		if _, err := m.entities.AdmissionFacts(ctx, tx, assetID); err != nil {
			return err
		}
		q, err := loadQueue(ctx, tx, assetID)
		if err != nil {
			return err
		}
		revision := strconv.FormatInt(q.row.Revision, 10)
		offset := 0
		if params.PageToken != nil {
			token, err := m.store.OpenToken(*params.PageToken, "assigned_tasks", scope, limit)
			if err != nil {
				return err
			}
			if token.Pinned["queue_revision"] != revision {
				return system.PageChanged()
			}
			if offset, err = strconv.Atoi(token.After); err != nil {
				return fmt.Errorf("decode assigned-work position: %w", err)
			}
		}
		rows, err := storage.New(tx).AssetTasks(ctx, assetID)
		if err != nil {
			return fmt.Errorf("list assigned Tasks: %w", err)
		}
		rows = slices.DeleteFunc(rows, func(row storage.Task) bool { return outstanding && Status(row.Status).Terminal() })
		position := map[string]int{}
		for index, id := range q.requested() {
			position[id] = index
		}
		// Immediate work first; then started queued work, which is ahead of
		// everything still waiting; then the eligible requested order; then
		// unstarted work excluded by pending cancellation, by submission.
		order := func(row storage.Task) (int, int) {
			if row.Scheduling == string(protocol.Immediate) {
				return 0, 0
			}
			if execution := Status(row.ExecutionStatus); !execution.unstarted() && !execution.Terminal() {
				return 1, 0
			}
			if index, ok := position[row.TaskID]; ok {
				return 2, index
			}
			return 3, 0
		}
		slices.SortStableFunc(rows, func(a, b storage.Task) int {
			groupA, indexA := order(a)
			groupB, indexB := order(b)
			switch {
			case groupA != groupB:
				return groupA - groupB
			case indexA != indexB:
				return indexA - indexB
			case a.SubmissionSequence != b.SubmissionSequence:
				return int(a.SubmissionSequence - b.SubmissionSequence)
			}
			return strings.Compare(a.TaskID, b.TaskID)
		})
		queueImage, err := q.image()
		if err != nil {
			return err
		}
		page = protocol.AssignedTaskPage{AssetId: identifiers([]string{assetID})[0], QueueRevision: revision, TaskQueue: queueImage, Items: []protocol.Task{}, NextPageToken: nullable.NewNullNullable[string]()}
		end := min(offset+limit, len(rows))
		for _, row := range rows[min(offset, len(rows)):end] {
			task, err := image(ctx, tx, row)
			if err != nil {
				return err
			}
			page.Items = append(page.Items, task)
		}
		if end < len(rows) {
			token, err := m.store.SealToken(system.PageToken{Kind: "assigned_tasks", Scope: scope, Limit: limit, After: strconv.Itoa(end), Pinned: map[string]string{"queue_revision": revision}})
			if err != nil {
				return err
			}
			page.NextPageToken = nullable.NewNullableWithValue(token)
		}
		return nil
	})
	return page, err
}
