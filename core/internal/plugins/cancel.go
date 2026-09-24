package plugins

import (
	"context"

	"github.com/google/uuid"

	"github.com/atlas-field-systems/atlas-core/core/internal/api"
	"github.com/atlas-field-systems/atlas-core/core/internal/plugins/internal/operationsdb"
	"github.com/atlas-field-systems/atlas-core/core/internal/plugins/internal/registrydb"
)

const errCanceledBeforeDispatch = "Canceled before the Plugin received it."

// Cancel cancels an attempt Core has not dispatched, or asks the Plugin to
// cancel a dispatched one. A terminal attempt is returned unchanged.
func (s *Service) Cancel(ctx context.Context, pluginID string, id uuid.UUID) (api.Operation, error) {
	plugin, err := s.registry.plugin(ctx, pluginID)
	if err != nil {
		return api.Operation{}, err
	}
	if _, err := s.operation(ctx, s.queries, pluginID, id.String()); err != nil {
		return api.Operation{}, err
	}
	if err := s.markCanceled(ctx, id.String()); err != nil {
		return api.Operation{}, err
	}
	row, err := s.operation(ctx, s.queries, pluginID, id.String())
	if err != nil {
		return api.Operation{}, err
	}
	if api.OperationStatus(row.Status) == api.OperationStatusCancellationRequested {
		s.sendCancel(plugin, row.ID)
	}
	return s.toAPI(row)
}

// markCanceled applies whichever cancellation the attempt's state allows.
// Each update is one conditional statement, so a racing dispatch or report
// decides which applies.
func (s *Service) markCanceled(ctx context.Context, id string) error {
	defer s.settled.Notify()
	if _, err := s.queries.CancelUndispatched(ctx, operationsdb.CancelUndispatchedParams{Error: nullString(errCanceledBeforeDispatch), ID: id}); err != nil {
		return err
	}
	_, err := s.queries.RequestCancellation(ctx, id)
	return err
}

// sendCancel asks the Plugin to stop an attempt. A repeated cancellation
// request sends it again.
func (s *Service) sendCancel(plugin registrydb.Plugin, id string) {
	s.background.run(func(ctx context.Context) {
		if err := s.containers.cancel(ctx, plugin, id); err != nil && ctx.Err() == nil {
			s.log.Error("send cancellation", "plugin", plugin.ID, "operation", id, "error", err)
		}
	})
}
