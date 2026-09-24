package plugins

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/atlas-field-systems/atlas-core/core/internal/plugins/internal/registrydb"
	"github.com/atlas-field-systems/atlas-core/core/internal/problem"
)

var errPluginNotFound = problem.NotFound("not_found", "Plugin not found.")

// Registry records installed Plugins in installation storage. Local
// management uses it while Core is stopped; Core reads it while running.
type Registry struct {
	db      *sql.DB
	queries *registrydb.Queries
}

func NewRegistry(installation *sql.DB) *Registry {
	return &Registry{db: installation, queries: registrydb.New(installation)}
}

// Install records a Plugin from its manifest. Core reaches it at endpoint
// and authenticates to it with dispatchSecret.
func (r *Registry) Install(ctx context.Context, manifest Manifest, endpoint, dispatchSecret string) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	queries := r.queries.WithTx(tx)
	plugin := registrydb.CreatePluginParams{ID: manifest.ID, Release: manifest.Release, Endpoint: endpoint, DispatchSecret: dispatchSecret, InstalledAt: time.Now().UnixMilli()}
	if err := queries.CreatePlugin(ctx, plugin); err != nil {
		return fmt.Errorf("record Plugin %s: %w", manifest.ID, err)
	}
	for _, capability := range manifest.Capabilities {
		params := registrydb.CreateCapabilityParams{PluginID: manifest.ID, Name: capability.Name, InputSchema: string(capability.InputSchema)}
		if err := queries.CreateCapability(ctx, params); err != nil {
			return fmt.Errorf("record capability %s of %s: %w", capability.Name, manifest.ID, err)
		}
	}
	return tx.Commit()
}

// Installed lists every installed Plugin.
func (r *Registry) Installed(ctx context.Context) ([]registrydb.Plugin, error) {
	plugins, err := r.queries.ListAllPlugins(ctx)
	if err != nil {
		return nil, fmt.Errorf("list Plugins: %w", err)
	}
	return plugins, nil
}

func (r *Registry) plugin(ctx context.Context, id string) (registrydb.Plugin, error) {
	plugin, err := r.queries.GetPlugin(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return registrydb.Plugin{}, errPluginNotFound
	}
	if err != nil {
		return registrydb.Plugin{}, fmt.Errorf("read Plugin %s: %w", id, err)
	}
	return plugin, nil
}

func (r *Registry) capabilityNames(ctx context.Context, id string) ([]string, error) {
	rows, err := r.queries.ListCapabilities(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("list capabilities of %s: %w", id, err)
	}
	names := make([]string, 0, len(rows))
	for _, row := range rows {
		names = append(names, row.Name)
	}
	return names, nil
}
