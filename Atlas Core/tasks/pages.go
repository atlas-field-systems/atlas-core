package tasks

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/identity"
	storage "github.com/atlas-field-systems/atlas-core/tasks/generated/storage"
	"github.com/atlas-field-systems/atlas-core/writecommit"
	"strconv"
)

type ListFilters struct {
	IDs         *protocol.IdentifierFilter     `json:"ids,omitempty"`
	AssetIDs    *protocol.AssetIDFilter        `json:"asset_id,omitempty"`
	Statuses    *protocol.TaskStatusFilter     `json:"status,omitempty"`
	Scheduling  *protocol.TaskSchedulingFilter `json:"scheduling,omitempty"`
	Outstanding bool                           `json:"outstanding"`
}
type PageOptions struct {
	Filters        ListFilters
	AssetID, After string
	Assigned       bool
	Limit          int
}

func PageKey(value protocol.Task) string {
	number, _ := strconv.ParseUint(value.SubmissionSequence, 10, 64)
	return value.AssetId.String() + "/" + fmt.Sprintf("%020d", number) + "/" + value.Id.String()
}
func (m *Module) ListPage(ctx context.Context, dataset string, principal identity.Principal, options PageOptions) (values []protocol.Task, queue protocol.TaskQueue, readContext protocol.HTTPReadContext, err error) {
	values = []protocol.Task{}
	readContext, err = m.identity.Read(ctx, m.boundary, dataset, principal, func(c *writecommit.Commit) error {
		filters, e := json.Marshal(options.Filters)
		if e != nil {
			return e
		}
		q := storage.New(c.SQL)
		var rows []string
		if options.Assigned {
			rows, e = q.ListAssignedTaskPage(ctx, storage.ListAssignedTaskPageParams{AssetID: options.AssetID, Filters: string(filters), AfterKey: options.After, PageLimit: int64(options.Limit + 1)})
		} else {
			rows, e = q.ListOrdinaryTaskPage(ctx, storage.ListOrdinaryTaskPageParams{Filters: string(filters), AfterID: options.After, PageLimit: int64(options.Limit + 1)})
		}
		if e != nil {
			return e
		}
		for _, row := range rows {
			var value protocol.Task
			if e = json.Unmarshal([]byte(row), &value); e != nil {
				return e
			}
			values = append(values, value)
		}
		if options.Assigned {
			if _, e = m.entities.ReadInside(ctx, c, options.AssetID); e != nil {
				return e
			}
			queue, _, e = m.queue(ctx, c, options.AssetID)
		}
		return e
	})
	return
}
