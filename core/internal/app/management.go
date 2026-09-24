package app

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/atlas-field-systems/atlas-core/core/internal/plugins"
	"github.com/atlas-field-systems/atlas-core/core/internal/problem"
)

var (
	errNotManagement = problem.Forbidden("forbidden", "Local management identity is required.")
)

// lifecycleHandler serves the private channel local management uses to
// coordinate Plugin lifecycle with Core. It is not part of the public
// Protocol, so it sits beside the generated routes with its own secret.
func (a *App) lifecycleHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// A planned stop drains work for longer than the server's default
		// write timeout allows.
		if err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(plugins.LifecycleResponseTimeout)); err != nil {
			a.writeError(w, r, err)
			return
		}
		if err := a.requireManagement(r); err != nil {
			a.writeError(w, r, err)
			return
		}
		var request plugins.LifecycleRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRequestBytes)).Decode(&request); err != nil {
			a.writeError(w, r, invalidRequest(""))
			return
		}
		if err := a.plugins.ApplyLifecycle(r.Context(), r.PathValue("plugin_id"), request.Action); err != nil {
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
