// Package plugins owns installed Plugins, their availability and their
// durable Operation attempts. It never names a specific Plugin: identity,
// capabilities and input schemas come from each Plugin's manifest.
package plugins

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"sync"

	"github.com/atlas-field-systems/atlas-core/core/internal/api"
	"github.com/atlas-field-systems/atlas-core/core/internal/datasets"
	"github.com/atlas-field-systems/atlas-core/core/internal/pagination"
	"github.com/atlas-field-systems/atlas-core/core/internal/plugins/internal/operationsdb"
	"github.com/atlas-field-systems/atlas-core/core/internal/plugins/internal/registrydb"
	"github.com/atlas-field-systems/atlas-core/core/internal/signal"
)

// pluginList names Plugin list cursors in the pagination codec.
const pluginList = "plugins"

type pluginPosition struct {
	ID string `json:"i"`
}

// Service serves Plugin discovery and Operations while Core runs.
type Service struct {
	registry   *Registry
	db         *sql.DB
	queries    *operationsdb.Queries
	datasets   *datasets.Service
	containers containers
	background *worker
	log        *slog.Logger
	// settled wakes waiters whenever an attempt's status or admission changes.
	settled *signal.Broadcast

	mu        sync.Mutex
	reachable map[string]*reachability
}

func New(installation, operational *sql.DB, datasets *datasets.Service, log *slog.Logger) *Service {
	return &Service{
		registry:   NewRegistry(installation),
		db:         operational,
		queries:    operationsdb.New(operational),
		datasets:   datasets,
		containers: newContainers(),
		background: newWorker(),
		log:        log,
		settled:    signal.NewBroadcast(),
		reachable:  map[string]*reachability{},
	}
}

// Start interrupts attempts left unfinished by an earlier Core run, whose
// outcomes Core can no longer establish, then begins watching availability.
func (s *Service) Start(ctx context.Context) error {
	if err := s.queries.InterruptAllUnfinished(ctx, nullString(errPreviousRun)); err != nil {
		return fmt.Errorf("interrupt unfinished Operations: %w", err)
	}
	s.background.run(s.watch)
	return nil
}

// Close stops dispatch and monitoring.
func (s *Service) Close() { s.background.close() }

// List returns installed Plugins in ID order.
func (s *Service) List(ctx context.Context, cursor *string, limit int) (api.PluginPage, error) {
	var after pluginPosition
	if cursor != nil {
		if err := s.cursors().Decode(*cursor, pluginList, &after); err != nil {
			return api.PluginPage{}, err
		}
	}
	rows, err := s.registry.queries.ListPluginsAfter(ctx, registrydb.ListPluginsAfterParams{ID: after.ID, Limit: int64(limit + 1)})
	if err != nil {
		return api.PluginPage{}, fmt.Errorf("list Plugins: %w", err)
	}
	page := api.PluginPage{Items: make([]api.Plugin, 0, len(rows))}
	if len(rows) > limit {
		rows = rows[:limit]
		next, err := s.cursors().Encode(pluginList, pluginPosition{ID: rows[limit-1].ID})
		if err != nil {
			return api.PluginPage{}, err
		}
		page.NextCursor = &next
	}
	for _, row := range rows {
		plugin, err := s.describe(ctx, row)
		if err != nil {
			return api.PluginPage{}, err
		}
		page.Items = append(page.Items, plugin)
	}
	return page, nil
}

// Get describes one installed Plugin.
func (s *Service) Get(ctx context.Context, id string) (api.Plugin, error) {
	row, err := s.registry.plugin(ctx, id)
	if err != nil {
		return api.Plugin{}, err
	}
	return s.describe(ctx, row)
}

func (s *Service) describe(ctx context.Context, row registrydb.Plugin) (api.Plugin, error) {
	capabilities, err := s.registry.capabilityNames(ctx, row.ID)
	if err != nil {
		return api.Plugin{}, err
	}
	runtime, err := s.runtime(ctx, s.queries, row.ID)
	if err != nil {
		return api.Plugin{}, err
	}
	plugin := api.Plugin{Id: row.ID, Release: row.Release, Capabilities: capabilities, Availability: s.availability(row.ID, runtime)}
	if runtime.Fault.Valid {
		plugin.Fault = &runtime.Fault.String
	}
	return plugin, nil
}

func (s *Service) availability(id string, runtime operationsdb.PluginRuntime) api.PluginAvailability {
	switch {
	case runtime.Fault.Valid:
		return api.PluginAvailabilityFaulted
	case runtime.AdmissionOpen && s.isReachable(id):
		return api.PluginAvailabilityAvailable
	default:
		return api.PluginAvailabilityUnavailable
	}
}

// runtime reads a Plugin's admission and fault. A Plugin that has never been
// stopped or faulted admits Operations.
func (s *Service) runtime(ctx context.Context, queries *operationsdb.Queries, id string) (operationsdb.PluginRuntime, error) {
	runtime, err := queries.GetRuntime(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return operationsdb.PluginRuntime{PluginID: id, AdmissionOpen: true}, nil
	}
	if err != nil {
		return operationsdb.PluginRuntime{}, fmt.Errorf("read runtime of Plugin %s: %w", id, err)
	}
	return runtime, nil
}

func (s *Service) cursors() pagination.Codec { return pagination.NewCodec(s.datasets.Current().ID) }
