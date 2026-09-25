// Package entities owns Entities: Asset enrollment, Asset reports and reads.
package entities

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/atlas-field-systems/atlas-core/core/internal/api"
	"github.com/atlas-field-systems/atlas-core/core/internal/datasets"
	"github.com/atlas-field-systems/atlas-core/core/internal/entities/internal/db"
	"github.com/atlas-field-systems/atlas-core/core/internal/identity"
	"github.com/atlas-field-systems/atlas-core/core/internal/problem"
)

var errNotFound = problem.NotFound("not_found", "Entity not found.")

// Service stores Entities in operational storage. It checks Asset identity
// through the identity module, which keeps bindings in installation storage.
type Service struct {
	db         *sql.DB
	queries    *db.Queries
	identities *identity.Service
	datasets   *datasets.Service
}

func New(operational *sql.DB, identities *identity.Service, datasets *datasets.Service) *Service {
	return &Service{db: operational, queries: db.New(operational), identities: identities, datasets: datasets}
}

// Get reads the current Entity.
func (s *Service) Get(ctx context.Context, id string) (api.Entity, error) {
	return get(ctx, s.queries, id)
}

func get(ctx context.Context, queries *db.Queries, id string) (api.Entity, error) {
	row, err := queries.GetEntity(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return api.Entity{}, errNotFound
	}
	if err != nil {
		return api.Entity{}, fmt.Errorf("read Entity %s: %w", id, err)
	}
	return toAPI(row)
}

// Recover activates Asset credentials whose Entity committed before Core
// stopped, which happens if Core exits between the two stores' commits.
func (s *Service) Recover(ctx context.Context) error {
	inactive, err := s.identities.InactiveAssets(ctx)
	if err != nil {
		return err
	}
	for _, assetID := range inactive {
		committed, err := s.queries.EntityExists(ctx, assetID)
		if err != nil {
			return fmt.Errorf("check Asset %s: %w", assetID, err)
		}
		if committed {
			if err := s.identities.ActivateAsset(ctx, assetID); err != nil {
				return err
			}
		}
	}
	return nil
}
