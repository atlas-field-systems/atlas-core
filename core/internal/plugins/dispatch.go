package plugins

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/atlas-field-systems/atlas-core/core/internal/api"
	"github.com/atlas-field-systems/atlas-core/core/internal/plugins/internal/operationsdb"
	"github.com/atlas-field-systems/atlas-core/core/internal/plugins/internal/registrydb"
)

// dispatch sends a retained attempt to its Plugin in the background. The
// caller's connection plays no part, so a departing caller cannot stop it.
func (s *Service) dispatch(plugin registrydb.Plugin, operation operationsdb.PluginOperation) {
	s.background.run(func(ctx context.Context) {
		if err := s.deliver(ctx, plugin, operation); err != nil {
			s.log.Error("dispatch Operation", "plugin", plugin.ID, "operation", operation.ID, "error", err)
		}
	})
}

// deliver claims an attempt for dispatch, so a cancellation that wins the
// claim keeps it undispatched, then invokes the Plugin.
func (s *Service) deliver(ctx context.Context, plugin registrydb.Plugin, operation operationsdb.PluginOperation) error {
	claimed, err := s.queries.ClaimDispatch(ctx, operation.ID)
	if err != nil || claimed == 0 {
		return err
	}
	request := invocation{ID: operation.ID, Capability: operation.Capability, Input: json.RawMessage(operation.Input)}
	err = s.containers.invoke(ctx, plugin, request)
	var refused refusedError
	switch {
	case err == nil:
		return nil
	case ctx.Err() != nil:
		return nil // Core is stopping; the next start interrupts the attempt.
	case errors.As(err, &refused):
		return s.settlePending(ctx, operation.ID, api.OperationStatusFailed, refused.Error()+".")
	default:
		return errors.Join(err, s.settlePending(ctx, operation.ID, api.OperationStatusInterrupted, errDispatchUnknown))
	}
}

// settlePending records an outcome unless the Plugin has already reported.
func (s *Service) settlePending(ctx context.Context, id string, status api.OperationStatus, reason string) error {
	params := operationsdb.SetOutcomeFromParams{Status: string(status), Error: nullString(reason), ID: id, Expected: string(api.OperationStatusPending)}
	if _, err := s.queries.SetOutcomeFrom(ctx, params); err != nil {
		return fmt.Errorf("settle Operation %s: %w", id, err)
	}
	return nil
}

func nullString(value string) sql.NullString {
	return sql.NullString{String: value, Valid: true}
}
