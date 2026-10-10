package entities

import (
	"context"
	"encoding/json"
	storage "github.com/atlas-field-systems/atlas-core/entities/generated/storage"
	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/identity"
	"github.com/atlas-field-systems/atlas-core/writecommit"
)

type ListFilters struct {
	IDs        *protocol.IdentifierFilter `json:"ids,omitempty"`
	Types      *protocol.EntityTypeFilter `json:"type,omitempty"`
	Alias      *string                    `json:"alias,omitempty"`
	AliasIsSet *bool                      `json:"alias_is_set,omitempty"`
}

func (m *Module) ListPage(ctx context.Context, dataset string, principal identity.Principal, filters ListFilters, after string, limit int) (values []protocol.Asset, readContext protocol.HTTPReadContext, err error) {
	values = []protocol.Asset{}
	if filters.Alias != nil {
		key := aliasKey(*filters.Alias)
		filters.Alias = &key
	}
	readContext, err = m.identity.Read(ctx, m.boundary, dataset, principal, func(c *writecommit.Commit) error {
		encoded, e := json.Marshal(filters)
		if e != nil {
			return e
		}
		rows, e := storage.New(c.SQL).ListEntityPage(ctx, storage.ListEntityPageParams{Filters: string(encoded), AfterID: after, PageLimit: int64(limit + 1)})
		if e != nil {
			return e
		}
		for _, row := range rows {
			var value protocol.Asset
			if e = json.Unmarshal([]byte(row), &value); e != nil {
				return e
			}
			if e = m.refreshCommunication(ctx, c, &value); e != nil {
				return e
			}
			values = append(values, value)
		}
		return nil
	})
	return
}
