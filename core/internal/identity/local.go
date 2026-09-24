package identity

import (
	"context"
	"crypto/subtle"
	"fmt"

	"github.com/atlas-field-systems/atlas-core/core/internal/identity/internal/db"
)

// AddPluginKey stores the verifier of a managed Plugin's integration credential.
func (s *Service) AddPluginKey(ctx context.Context, pluginID, credential string) error {
	if err := s.queries.CreatePluginKey(ctx, db.CreatePluginKeyParams{PluginID: pluginID, Verifier: Verifier(credential)}); err != nil {
		return fmt.Errorf("store Plugin credential for %s: %w", pluginID, err)
	}
	return nil
}

// SetManagementSecret stores the verifier of local management's secret, once.
func (s *Service) SetManagementSecret(ctx context.Context, secret string) error {
	if err := s.queries.SetManagementSecret(ctx, Verifier(secret)); err != nil {
		return fmt.Errorf("store management secret: %w", err)
	}
	return nil
}

// IsManagementSecret reports whether secret is local management's secret.
func (s *Service) IsManagementSecret(ctx context.Context, secret string) (bool, error) {
	verifier, err := s.queries.GetManagementSecret(ctx)
	if err != nil {
		return false, fmt.Errorf("read management secret: %w", err)
	}
	return subtle.ConstantTimeCompare(verifier, Verifier(secret)) == 1, nil
}
