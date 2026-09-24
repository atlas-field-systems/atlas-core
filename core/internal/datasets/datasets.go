// Package datasets owns the identity of the operational Dataset.
package datasets

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"github.com/atlas-field-systems/atlas-core/core/internal/datasets/internal/db"
)

// Dataset identifies the operational state retained between Resets.
type Dataset struct {
	ID             uuid.UUID
	WritingRelease string
}

// Service holds the Dataset of the current Core run.
type Service struct {
	queries *db.Queries
	current Dataset
}

// Open loads the Dataset, creating it on first start. It refuses a Dataset
// written by another Core release; that requires the explicit update and
// Reset flow.
func Open(ctx context.Context, operational *sql.DB, release string) (*Service, error) {
	queries := db.New(operational)
	current, err := load(ctx, queries, release)
	if err != nil {
		return nil, err
	}
	if current.WritingRelease != release {
		return nil, fmt.Errorf("Dataset was written by Core release %s; use the explicit update and Reset flow before starting %s", current.WritingRelease, release)
	}
	return &Service{queries: queries, current: current}, nil
}

func load(ctx context.Context, queries *db.Queries, release string) (Dataset, error) {
	row, err := queries.GetDataset(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return create(ctx, queries, release)
	}
	if err != nil {
		return Dataset{}, fmt.Errorf("read Dataset: %w", err)
	}
	id, err := uuid.Parse(row.ID)
	if err != nil {
		return Dataset{}, fmt.Errorf("stored Dataset ID is invalid: %w", err)
	}
	return Dataset{ID: id, WritingRelease: row.WritingRelease}, nil
}

func create(ctx context.Context, queries *db.Queries, release string) (Dataset, error) {
	id, err := uuid.NewRandom()
	if err != nil {
		return Dataset{}, fmt.Errorf("allocate Dataset ID: %w", err)
	}
	if err := queries.CreateDataset(ctx, db.CreateDatasetParams{ID: id.String(), WritingRelease: release}); err != nil {
		return Dataset{}, fmt.Errorf("create Dataset: %w", err)
	}
	return Dataset{ID: id, WritingRelease: release}, nil
}

// Current returns the Dataset this Core run serves.
func (s *Service) Current() Dataset { return s.current }

// Ready reports whether Dataset storage is readable.
func (s *Service) Ready(ctx context.Context) error {
	_, err := s.queries.GetDataset(ctx)
	return err
}

// CheckStored verifies an existing Dataset without creating one, for the
// container health probe.
func CheckStored(ctx context.Context, operational *sql.DB, release string) error {
	row, err := db.New(operational).GetDataset(ctx)
	if err != nil {
		return fmt.Errorf("read Dataset: %w", err)
	}
	if row.WritingRelease != release {
		return fmt.Errorf("Dataset was written by Core release %s, not %s", row.WritingRelease, release)
	}
	return nil
}
