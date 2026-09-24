// Package identity owns Atlas credentials and resolves them to callers.
package identity

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/atlas-field-systems/atlas-core/core/internal/identity/internal/db"
	"github.com/atlas-field-systems/atlas-core/core/internal/problem"
)

// Kind names a kind of caller. Each value matches a Protocol security scheme.
type Kind string

const (
	Operator   Kind = "operator"
	Enrollment Kind = "enrollment"
	Asset      Kind = "asset"
)

// Caller is an authenticated credential holder. For an Asset, ID is its
// Entity ID.
type Caller struct {
	Kind Kind
	ID   string
}

var (
	errUnknownCredential = problem.Unauthorized("unauthorized", "A valid credential is required.")
	errUnavailable       = problem.Unavailable("authentication_unavailable", "Credential storage is unavailable.")
)

// Service stores credential verifiers in installation storage.
type Service struct {
	queries *db.Queries
}

func New(installation *sql.DB) *Service {
	return &Service{queries: db.New(installation)}
}

// Authenticate resolves a presented credential to its caller.
func (s *Service) Authenticate(ctx context.Context, credential string) (Caller, error) {
	row, err := s.queries.CallerByVerifier(ctx, Verifier(credential))
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return Caller{}, errUnknownCredential
	case err != nil:
		return Caller{}, fmt.Errorf("%w: %w", errUnavailable, err)
	}
	return Caller{Kind: Kind(row.Kind), ID: row.ID}, nil
}

// SetUp reports whether local setup has provisioned an operator credential.
func (s *Service) SetUp(ctx context.Context) (bool, error) {
	count, err := s.queries.CountOperatorKeys(ctx)
	if err != nil {
		return false, fmt.Errorf("count operator credentials: %w", err)
	}
	return count > 0, nil
}

// AddOperatorKey stores the verifier of a new operator credential.
func (s *Service) AddOperatorKey(ctx context.Context, credential string) error {
	err := s.queries.CreateOperatorKey(ctx, db.CreateOperatorKeyParams{
		ID:        uuid.NewString(),
		Verifier:  Verifier(credential),
		CreatedAt: time.Now().UnixMilli(),
	})
	if err != nil {
		return fmt.Errorf("store operator credential: %w", err)
	}
	return nil
}
