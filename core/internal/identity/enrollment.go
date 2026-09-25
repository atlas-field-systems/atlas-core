package identity

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"github.com/atlas-field-systems/atlas-core/core/internal/identity/internal/db"
	"github.com/atlas-field-systems/atlas-core/core/internal/problem"
)

var errAssetIDTaken = problem.Conflict("registration_conflict", "The Asset ID is bound to another credential.")

// AssetBinding ties an Asset ID to the principal and credential that act for it.
type AssetBinding struct {
	AssetID      string
	PrincipalID  string
	CredentialID string
}

// HasEnrollmentAuthority reports whether setup has created the enrollment authority.
func (s *Service) HasEnrollmentAuthority(ctx context.Context) (bool, error) {
	count, err := s.queries.CountEnrollmentAuthorities(ctx)
	if err != nil {
		return false, fmt.Errorf("count enrollment authorities: %w", err)
	}
	return count > 0, nil
}

// SetEnrollmentAuthority stores the verifier of the installation's enrollment credential.
func (s *Service) SetEnrollmentAuthority(ctx context.Context, credential string) error {
	if err := s.queries.CreateEnrollmentAuthority(ctx, Verifier(credential)); err != nil {
		return fmt.Errorf("store enrollment authority: %w", err)
	}
	return nil
}

// RevokeEnrollmentAuthority stops new enrollments and retries. Enrolled
// Assets keep their own credentials.
func (s *Service) RevokeEnrollmentAuthority(ctx context.Context) error {
	revoked, err := s.queries.RevokeEnrollmentAuthority(ctx)
	if err != nil {
		return fmt.Errorf("revoke enrollment authority: %w", err)
	}
	if revoked == 0 {
		return errors.New("no active enrollment authority")
	}
	return nil
}

// ReserveAsset binds an Asset ID to its credential, inactive until
// ActivateAsset. Reserving again with the same credential returns the existing
// binding; another credential cannot take the ID.
func (s *Service) ReserveAsset(ctx context.Context, assetID, credential string) (AssetBinding, error) {
	verifier := Verifier(credential)
	err := s.queries.ReserveAssetBinding(ctx, db.ReserveAssetBindingParams{
		AssetID:      assetID,
		PrincipalID:  uuid.NewString(),
		CredentialID: uuid.NewString(),
		Verifier:     verifier,
	})
	if err != nil {
		return AssetBinding{}, fmt.Errorf("reserve Asset binding %s: %w", assetID, err)
	}
	stored, err := s.queries.GetAssetBinding(ctx, assetID)
	if err != nil {
		return AssetBinding{}, fmt.Errorf("read Asset binding %s: %w", assetID, err)
	}
	if stored.Revoked || subtle.ConstantTimeCompare(stored.Verifier, verifier) != 1 {
		return AssetBinding{}, errAssetIDTaken
	}
	return AssetBinding{AssetID: assetID, PrincipalID: stored.PrincipalID, CredentialID: stored.CredentialID}, nil
}

// ActivateAsset lets a reserved Asset credential authenticate.
func (s *Service) ActivateAsset(ctx context.Context, assetID string) error {
	if err := s.queries.ActivateAssetBinding(ctx, assetID); err != nil {
		return fmt.Errorf("activate Asset binding %s: %w", assetID, err)
	}
	return nil
}

// InactiveAssets lists reserved Asset IDs whose credentials are not active yet.
func (s *Service) InactiveAssets(ctx context.Context) ([]string, error) {
	ids, err := s.queries.ListInactiveAssetBindings(ctx)
	if err != nil {
		return nil, fmt.Errorf("list inactive Asset bindings: %w", err)
	}
	return ids, nil
}
