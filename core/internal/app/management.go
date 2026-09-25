package app

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/atlas-field-systems/atlas-core/core/internal/plugins"
	"github.com/atlas-field-systems/atlas-core/core/internal/problem"
)

var (
	errNotManagement = problem.Forbidden("forbidden", "Local management identity is required.")
	errUnknownAction = problem.Invalid("invalid_action", "The lifecycle action is not recognized.")
)

// lifecycleHandler serves the private channel local management uses to
// coordinate Plugin lifecycle with Core. It is not part of the public
// Protocol, so it sits beside the generated routes with its own secret.
func (a *App) lifecycleHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := a.requireManagement(r); err != nil {
			a.writeError(w, r, err)
			return
		}
		var request plugins.LifecycleRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRequestBytes)).Decode(&request); err != nil {
			a.writeError(w, r, invalidRequest(""))
			return
		}
		if err := a.applyLifecycle(r.Context(), r.PathValue("plugin_id"), request.Action); err != nil {
			a.writeError(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
}

func (a *App) requireManagement(r *http.Request) error {
	valid, err := a.identity.IsManagementSecret(r.Context(), r.Header.Get(plugins.ManagementSecretHeader))
	if err != nil {
		return err
	}
	if !valid {
		return errNotManagement
	}
	return nil
}

func (a *App) applyLifecycle(ctx context.Context, pluginID, action string) error {
	switch action {
	case plugins.ActionStarted:
		return a.plugins.Started(ctx, pluginID)
	default:
		return errUnknownAction
	}
}
