package plugins

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/atlas-field-systems/atlas-core/core/internal/plugins/internal/operationsdb"
)

// The private lifecycle channel between local management and Core.
const (
	// ManagementSecretHeader carries local management's secret.
	ManagementSecretHeader = "X-Atlas-Management-Secret"
	// ActionStarted follows starting a Plugin container.
	ActionStarted = "started"
)

// LifecycleRequest is one coordination message from local management.
type LifecycleRequest struct {
	Action string `json:"action"`
}

// Started records that local management has (re)started a Plugin container:
// attempts it held earlier cannot finish, any fault is cleared, and
// admission opens.
func (s *Service) Started(ctx context.Context, id string) error {
	if _, err := s.registry.plugin(ctx, id); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	queries := s.queries.WithTx(tx)
	if err := queries.InterruptUnfinishedOf(ctx, operationsdb.InterruptUnfinishedOfParams{Error: nullString(errRestarted), PluginID: id}); err != nil {
		return fmt.Errorf("interrupt earlier Operations of %s: %w", id, err)
	}
	if err := queries.SetRuntime(ctx, operationsdb.SetRuntimeParams{PluginID: id, AdmissionOpen: true, Fault: sql.NullString{}}); err != nil {
		return fmt.Errorf("open admission of %s: %w", id, err)
	}
	return tx.Commit()
}
