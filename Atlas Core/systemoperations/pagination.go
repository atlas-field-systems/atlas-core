package systemoperations

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/atlas-field-systems/atlas-core/entities"
	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/tasks"
	"github.com/atlas-field-systems/atlas-core/writecommit"
	"github.com/oapi-codegen/nullable"
)

type pagination struct {
	key      []byte
	lifetime time.Duration
	clock    func() time.Time
}
type pageIdentity struct {
	Edition, Dataset, Scope, After, QueueRevision string
	Limit                                         int
	ExpiresAt                                     time.Time
	HistoryAfter                                  *entities.HistoryPosition `json:"history_after,omitempty"`
	HistoryUpper                                  *int64                    `json:"history_upper,omitempty"`
}

func (p *pagination) token(value pageIdentity) (string, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, p.key)
	mac.Write(body)
	return base64.RawURLEncoding.EncodeToString(body) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}
func (p *pagination) parse(token string) (pageIdentity, error) {
	if len(token) > 4096 {
		return pageIdentity{}, errors.New("cursor exceeds supported size")
	}
	left, right, ok := strings.Cut(token, ".")
	if !ok {
		return pageIdentity{}, errors.New("invalid cursor")
	}
	body, err := base64.RawURLEncoding.Strict().DecodeString(left)
	if err != nil {
		return pageIdentity{}, err
	}
	proof, err := base64.RawURLEncoding.Strict().DecodeString(right)
	if err != nil {
		return pageIdentity{}, err
	}
	mac := hmac.New(sha256.New, p.key)
	mac.Write(body)
	if !hmac.Equal(proof, mac.Sum(nil)) {
		return pageIdentity{}, errors.New("invalid cursor")
	}
	var value pageIdentity
	err = json.Unmarshal(body, &value)
	return value, err
}
func (p *pagination) begin(dataset, scope string, limit *int, cursor *string) (pageIdentity, error) {
	count := 100
	if limit != nil {
		count = *limit
	}
	if count < 1 || count > 1000 {
		return pageIdentity{}, &publicError{400, "invalid_request", "Page limit is outside its supported range"}
	}
	value := pageIdentity{Edition: ProtocolVersion, Dataset: dataset, Scope: scope, Limit: count, ExpiresAt: p.clock().UTC().Add(p.lifetime)}
	if cursor == nil {
		return value, nil
	}
	existing, err := p.parse(*cursor)
	if err != nil || existing.Edition != ProtocolVersion || existing.Dataset != dataset || existing.Scope != scope || existing.Limit != count {
		return pageIdentity{}, &publicError{400, "cursor_invalid", "Continuation does not match this Dataset and read"}
	}
	if !p.clock().Before(existing.ExpiresAt) {
		return pageIdentity{}, &publicError{409, "cursor_expired", "Continuation expired; restart the read"}
	}
	return existing, nil
}
func finishPage[T interface{}](p *pagination, identity pageIdentity, values []T, key func(T) string) ([]T, nullable.Nullable[string], error) {
	next := nullable.NewNullNullable[string]()
	if len(values) <= identity.Limit {
		return values, next, nil
	}
	values = values[:identity.Limit]
	identity.After = key(values[len(values)-1])
	token, err := p.token(identity)
	if err != nil {
		return nil, next, err
	}
	next.Set(token)
	return values, next, nil
}
func (a *httpAPI) ListEntities(ctx context.Context, r protocol.ListEntitiesRequestObject) (protocol.ListEntitiesResponseObject, error) {
	filters := entities.ListFilters{IDs: r.Params.Ids, Types: r.Params.Type, Alias: r.Params.Alias, AliasIsSet: r.Params.AliasIsSet}
	scope, err := pageScope("entities/", filters)
	if err != nil {
		return nil, err
	}
	identity, err := a.pager.begin(r.Params.AtlasDatasetID.String(), scope, r.Params.Limit, r.Params.Cursor)
	if err != nil {
		return nil, err
	}
	values, readContext, err := a.core.entities.ListPage(ctx, identity.Dataset, wire(ctx).principal, filters, identity.After, identity.Limit)
	if err != nil {
		return nil, err
	}
	items, next, err := finishPage(a.pager, identity, values, func(value protocol.Asset) string { return value.Id.String() })
	if err != nil {
		return nil, err
	}
	body := protocol.AssetPageResponse{DatasetId: r.Params.AtlasDatasetID, ReadContext: readContext, Data: protocol.AssetPageResponseData{Items: items, NextCursor: next}}
	if err = writecommit.CheckResult(a.maximum, body); err != nil {
		return nil, err
	}
	return protocol.ListEntities200JSONResponse{Body: body, Headers: protocol.ListEntities200ResponseHeaders{AtlasDatasetID: r.Params.AtlasDatasetID, AtlasProtocolVersion: ProtocolVersion}}, nil
}
func pageScope(prefix string, filters interface{}) (string, error) {
	encoded, err := json.Marshal(filters)
	if err != nil {
		return "", err
	}
	// Accepted lists can contain 1000 IDs. Bind the decoded query without
	// copying that large selection into every signed continuation.
	digest := sha256.Sum256(encoded)
	return prefix + base64.RawURLEncoding.EncodeToString(digest[:]), nil
}
func taskFilters(ids *protocol.IdentifierFilter, assetIDs *protocol.AssetIDFilter, statuses *protocol.TaskStatusFilter, scheduling *protocol.TaskSchedulingFilter, outstanding *bool) tasks.ListFilters {
	filters := tasks.ListFilters{IDs: ids, AssetIDs: assetIDs, Statuses: statuses, Scheduling: scheduling}
	if outstanding != nil {
		filters.Outstanding = *outstanding
	}
	return filters
}
func (a *httpAPI) ListTasks(ctx context.Context, r protocol.ListTasksRequestObject) (protocol.ListTasksResponseObject, error) {
	filters := taskFilters(r.Params.Ids, r.Params.AssetId, r.Params.Status, r.Params.Scheduling, r.Params.Outstanding)
	scope, err := pageScope("tasks/", filters)
	if err != nil {
		return nil, err
	}
	identity, err := a.pager.begin(r.Params.AtlasDatasetID.String(), scope, r.Params.Limit, r.Params.Cursor)
	if err != nil {
		return nil, err
	}
	values, _, readContext, err := a.core.tasks.ListPage(ctx, identity.Dataset, wire(ctx).principal, tasks.PageOptions{Filters: filters, After: identity.After, Limit: identity.Limit})
	if err != nil {
		return nil, err
	}
	items, next, err := finishPage(a.pager, identity, values, func(value protocol.Task) string { return value.Id.String() })
	if err != nil {
		return nil, err
	}
	body := protocol.TaskPageResponse{DatasetId: r.Params.AtlasDatasetID, ReadContext: readContext, Data: protocol.TaskPageResponseData{Items: items, NextCursor: next}}
	if err = writecommit.CheckResult(a.maximum, body); err != nil {
		return nil, err
	}
	return protocol.ListTasks200JSONResponse{Body: body, Headers: protocol.ListTasks200ResponseHeaders{AtlasDatasetID: r.Params.AtlasDatasetID, AtlasProtocolVersion: ProtocolVersion}}, nil
}
func (a *httpAPI) GetAssignedTasks(ctx context.Context, r protocol.GetAssignedTasksRequestObject) (protocol.GetAssignedTasksResponseObject, error) {
	outstanding := r.Params.Outstanding
	if outstanding == nil {
		value := true
		outstanding = &value
	}
	filters := taskFilters(r.Params.Ids, nil, r.Params.Status, r.Params.Scheduling, outstanding)
	scope, err := pageScope("assigned/"+r.EntityId.String()+"/", filters)
	if err != nil {
		return nil, err
	}
	identity, err := a.pager.begin(r.Params.AtlasDatasetID.String(), scope, r.Params.Limit, r.Params.Cursor)
	if err != nil {
		return nil, err
	}
	values, queue, readContext, err := a.core.tasks.ListPage(ctx, identity.Dataset, wire(ctx).principal, tasks.PageOptions{Filters: filters, Assigned: true, AssetID: r.EntityId.String(), After: identity.After, Limit: identity.Limit})
	if err != nil {
		return nil, err
	}
	if identity.QueueRevision != "" && identity.QueueRevision != queue.Revision {
		return nil, &publicError{409, "page_changed", "Assigned queue changed; restart the read"}
	}
	identity.QueueRevision = queue.Revision
	items, next, err := finishPage(a.pager, identity, values, tasks.PageKey)
	if err != nil {
		return nil, err
	}
	body := protocol.AssignedTaskPageResponse{DatasetId: r.Params.AtlasDatasetID, ReadContext: readContext, Data: protocol.AssignedTaskPageResponseData{Items: items, NextCursor: next, QueueRevision: queue.Revision, TaskQueue: queue}}
	if err = writecommit.CheckResult(a.maximum, body); err != nil {
		return nil, err
	}
	return protocol.GetAssignedTasks200JSONResponse{Body: body, Headers: protocol.GetAssignedTasks200ResponseHeaders{AtlasDatasetID: r.Params.AtlasDatasetID, AtlasProtocolVersion: ProtocolVersion}}, nil
}
func (a *httpAPI) GetMovementHistory(ctx context.Context, r protocol.GetMovementHistoryRequestObject) (protocol.GetMovementHistoryResponseObject, error) {
	basis := "received_at"
	if r.Params.TimeBasis != nil {
		basis = string(*r.Params.TimeBasis)
	}
	scope, err := json.Marshal(struct{ Asset, Basis, From, To string }{r.EntityId.String(), basis, r.Params.From.UTC().Format(time.RFC3339Nano), r.Params.To.UTC().Format(time.RFC3339Nano)})
	if err != nil {
		return nil, err
	}
	identity, err := a.pager.begin(r.Params.AtlasDatasetID.String(), "movement/"+string(scope), r.Params.Limit, r.Params.Cursor)
	if err != nil {
		return nil, err
	}
	page, readContext, err := a.core.entities.HistoryPage(ctx, identity.Dataset, wire(ctx).principal, r.EntityId.String(), entities.HistoryOptions{From: r.Params.From, To: r.Params.To, TimeBasis: basis, UpperSequence: identity.HistoryUpper, After: identity.HistoryAfter, Limit: identity.Limit})
	if err != nil {
		return nil, err
	}
	next := nullable.NewNullNullable[string]()
	if page.Next != nil {
		identity.HistoryAfter = page.Next
		identity.HistoryUpper = &page.UpperSequence
		token, err := a.pager.token(identity)
		if err != nil {
			return nil, err
		}
		next.Set(token)
	}
	body := protocol.MovementPageResponse{DatasetId: r.Params.AtlasDatasetID, ReadContext: readContext, Data: protocol.MovementPageResponseData{Items: page.Items, NextCursor: next, EntityDeleted: page.Deleted, TimeBasis: protocol.MovementPageResponseDataTimeBasis(basis)}}
	if err = writecommit.CheckResult(a.maximum, body); err != nil {
		return nil, err
	}
	return protocol.GetMovementHistory200JSONResponse{Body: body, Headers: protocol.GetMovementHistory200ResponseHeaders{AtlasDatasetID: r.Params.AtlasDatasetID, AtlasProtocolVersion: ProtocolVersion}}, nil
}
