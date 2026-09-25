// Package entities owns Entities: Asset enrollment, Asset reports and reads.
package entities

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/atlas-field-systems/atlas-core/core/internal/api"
	"github.com/atlas-field-systems/atlas-core/core/internal/changes"
	"github.com/atlas-field-systems/atlas-core/core/internal/datasets"
	"github.com/atlas-field-systems/atlas-core/core/internal/entities/internal/db"
	"github.com/atlas-field-systems/atlas-core/core/internal/identity"
	"github.com/atlas-field-systems/atlas-core/core/internal/problem"
)

var errNotFound = problem.NotFound("not_found", "Entity not found.")

// Service stores Entities in operational storage and publishes every
// committed change to the change log. It checks Asset identity through the
// identity module, which keeps bindings in installation storage.
type Service struct {
	db         *sql.DB
	queries    *db.Queries
	identities *identity.Service
	datasets   *datasets.Service
	changes    *changes.Log
}

func New(operational *sql.DB, identities *identity.Service, datasets *datasets.Service, changes *changes.Log) *Service {
	return &Service{db: operational, queries: db.New(operational), identities: identities, datasets: datasets, changes: changes}
}

// Get reads the current Entity.
func (s *Service) Get(ctx context.Context, id string) (api.Entity, error) {
	return s.read(ctx, s.queries, id)
}

// GetInTx lets a collaborating module validate an Asset against the same
// transaction in which it records assigned work.
func (s *Service) GetInTx(ctx context.Context, tx *sql.Tx, id string) (api.Entity, error) {
	return s.read(ctx, s.queries.WithTx(tx), id)
}

// StatusView reads an Asset's status, communications and contact.
func (s *Service) StatusView(ctx context.Context, id string) (api.AssetStatusView, error) {
	entity, err := s.Get(ctx, id)
	if err != nil {
		return api.AssetStatusView{}, err
	}
	return api.AssetStatusView{Status: entity.Components.Status, Communications: entity.Components.Communications, Heartbeat: entity.Components.Heartbeat}, nil
}

func (s *Service) read(ctx context.Context, queries *db.Queries, id string) (api.Entity, error) {
	row, err := queries.GetEntity(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return api.Entity{}, errNotFound
	}
	if err != nil {
		return api.Entity{}, fmt.Errorf("read Entity %s: %w", id, err)
	}
	return toAPI(row, s.datasets.Current().ID)
}

// publish appends the Entity's state inside tx to the change log and
// returns that state with its change sequence.
func (s *Service) publish(ctx context.Context, tx *sql.Tx, id string, kind api.EntityChangeKind) (api.Entity, error) {
	queries := s.queries.WithTx(tx)
	entity, err := s.read(ctx, queries, id)
	if err != nil {
		return api.Entity{}, err
	}
	sequence, err := s.changes.Append(ctx, tx, kind, entity)
	if err != nil {
		return api.Entity{}, err
	}
	if err := queries.SetChangeSequence(ctx, db.SetChangeSequenceParams{Sequence: sequence, ID: id}); err != nil {
		return api.Entity{}, fmt.Errorf("set change sequence of Entity %s: %w", id, err)
	}
	entity.ChangeSequence = sequence
	return entity, nil
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
