package entities

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"slices"

	"github.com/atlas-field-systems/atlas-core/entities/generated/storage"
	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/system"
	"github.com/oapi-codegen/nullable"
)

// Page sizes follow the shared list contract.
const (
	DefaultPageSize = 100
	MaxPageSize     = 1000
	scanBatch       = 256
)

// PageSize resolves an optional requested page size.
func PageSize(limit *int) int {
	if limit == nil {
		return DefaultPageSize
	}
	return *limit
}

// Scope digests a list's filters so its page token cannot be reused for
// another query.
func Scope(filters any) (string, error) {
	encoded, err := json.Marshal(filters)
	if err != nil {
		return "", fmt.Errorf("encode list filters: %w", err)
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:16]), nil
}

// List returns live Entities in permanent ID order. Filters combine with AND;
// values within one filter combine with OR.
func (m *Module) List(ctx context.Context, datasetID string, params protocol.ListEntitiesParams) (protocol.EntityPage, error) {
	limit := PageSize(params.Limit)
	filters := struct {
		IDs        *[]protocol.Identifier `json:"ids"`
		Types      *[]protocol.EntityType `json:"type"`
		Alias      *string                `json:"alias"`
		AliasIsSet *bool                  `json:"alias_is_set"`
	}{params.Ids, params.Type, params.Alias, params.AliasIsSet}
	scope, err := Scope(filters)
	if err != nil {
		return protocol.EntityPage{}, err
	}
	page := protocol.EntityPage{Items: []protocol.Entity{}, NextPageToken: nullable.NewNullNullable[string]()}
	err = m.store.Read(ctx, datasetID, func(tx *sql.Tx) error {
		after := ""
		if params.PageToken != nil {
			token, err := m.store.OpenToken(*params.PageToken, "entities", scope, limit)
			if err != nil {
				return err
			}
			after = token.After
		}
		match := func(row storage.Entity) bool {
			if filters.IDs != nil && !slices.ContainsFunc(*filters.IDs, func(id protocol.Identifier) bool { return id.String() == row.EntityID }) {
				return false
			}
			if filters.Types != nil && !slices.Contains(*filters.Types, protocol.EntityType(row.EntityType)) {
				return false
			}
			if filters.Alias != nil && (!row.AliasKey.Valid || row.AliasKey.String != aliasKey(*filters.Alias)) {
				return false
			}
			if filters.AliasIsSet != nil && row.Alias.Valid != *filters.AliasIsSet {
				return false
			}
			return true
		}
		queries := storage.New(tx)
		more := false
		for len(page.Items) <= limit {
			rows, err := queries.ListEntities(ctx, storage.ListEntitiesParams{EntityID: after, Limit: scanBatch})
			if err != nil {
				return fmt.Errorf("list Entities: %w", err)
			}
			for _, row := range rows {
				after = row.EntityID
				if !match(row) {
					continue
				}
				if len(page.Items) == limit {
					more = true
					break
				}
				rec, err := decode(row)
				if err != nil {
					return err
				}
				entity, err := m.image(ctx, tx, rec)
				if err != nil {
					return err
				}
				page.Items = append(page.Items, entity)
			}
			if more || len(rows) < scanBatch {
				break
			}
		}
		if more {
			last := page.Items[len(page.Items)-1].Id.String()
			token, err := m.store.SealToken(system.PageToken{Kind: "entities", Scope: scope, Limit: limit, After: last})
			if err != nil {
				return err
			}
			page.NextPageToken = nullable.NewNullableWithValue(token)
		}
		return nil
	})
	return page, err
}
