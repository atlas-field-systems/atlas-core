// Package app composes the Core modules and serves them over HTTP.
package app

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"path/filepath"
	"sync"

	"github.com/atlas-field-systems/atlas-core/core/internal/changes"
	"github.com/atlas-field-systems/atlas-core/core/internal/datasets"
	"github.com/atlas-field-systems/atlas-core/core/internal/entities"
	"github.com/atlas-field-systems/atlas-core/core/internal/identity"
	"github.com/atlas-field-systems/atlas-core/core/internal/objects"
	"github.com/atlas-field-systems/atlas-core/core/internal/storage"
)

// Config locates an installation's storage and sets its limits.
type Config struct {
	SetupDir       string
	OperationalDir string
	Release        string
	// ChangeRetention is how many recent changes stay replayable.
	ChangeRetention int
}

func (c Config) installationFile() string { return filepath.Join(c.SetupDir, "installation.sqlite") }
func (c Config) operationalFile() string {
	return filepath.Join(c.OperationalDir, "operational.sqlite")
}
func (c Config) objectsDir() string { return filepath.Join(c.OperationalDir, "objects") }

// App is one Core run.
type App struct {
	// lifetime ends when Close begins; long-lived connections watch it.
	lifetime     context.Context
	endLifetime  context.CancelFunc
	connections  sync.WaitGroup
	log          *slog.Logger
	installation *sql.DB
	operational  *sql.DB
	identity     *identity.Service
	datasets     *datasets.Service
	changes      *changes.Log
	entities     *entities.Service
	objects      *objects.Store
	handler      http.Handler
}

// Open opens installation and operational storage and prepares every module.
// It refuses to start an installation that local setup has not provisioned.
func Open(ctx context.Context, config Config, log *slog.Logger) (_ *App, err error) {
	if config.SetupDir == "" || config.OperationalDir == "" || config.Release == "" || config.ChangeRetention < 1 {
		return nil, errors.New("setup directory, operational directory, release and change retention are required")
	}
	a := &App{log: log}
	a.lifetime, a.endLifetime = context.WithCancel(context.Background())
	defer func() {
		if err != nil {
			a.Close()
		}
	}()
	if err := a.openInstallation(ctx, config); err != nil {
		return nil, err
	}
	if err := a.openOperational(ctx, config); err != nil {
		return nil, err
	}
	if a.handler, err = a.newHandler(); err != nil {
		return nil, err
	}
	return a, nil
}

func (a *App) openInstallation(ctx context.Context, config Config) (err error) {
	if a.installation, err = storage.Open(ctx, config.installationFile(), storage.Installation); err != nil {
		return err
	}
	a.identity = identity.New(a.installation)
	setUp, err := a.identity.SetUp(ctx)
	if err != nil {
		return err
	}
	if !setUp {
		return errors.New("installation is not set up; run atlasctl setup")
	}
	return nil
}

func (a *App) openOperational(ctx context.Context, config Config) (err error) {
	if a.operational, err = storage.Open(ctx, config.operationalFile(), storage.Operational); err != nil {
		return err
	}
	if a.datasets, err = datasets.Open(ctx, a.operational, config.Release); err != nil {
		return err
	}
	a.changes = changes.New(a.operational, a.datasets.Current().ID, config.ChangeRetention)
	a.entities = entities.New(a.operational, a.identity, a.datasets, a.changes)
	if err := a.entities.Recover(ctx); err != nil {
		return fmt.Errorf("recover Asset enrollment: %w", err)
	}
	a.objects, err = objects.Open(config.objectsDir())
	return err
}

// Handler serves the public Protocol.
func (a *App) Handler() http.Handler { return a.handler }

// Close ends open feed connections, then releases storage. It is safe on a
// partially opened App.
func (a *App) Close() error {
	a.endLifetime()
	a.connections.Wait()
	var errs []error
	for _, db := range []*sql.DB{a.operational, a.installation} {
		if db != nil {
			errs = append(errs, db.Close())
		}
	}
	return errors.Join(errs...)
}

// CheckReady is the container's private health probe. It never creates or
// migrates state.
func CheckReady(ctx context.Context, config Config) error {
	installation, err := storage.OpenExisting(ctx, config.installationFile(), storage.Installation)
	if err != nil {
		return err
	}
	defer installation.Close()
	if setUp, err := identity.New(installation).SetUp(ctx); err != nil || !setUp {
		return errors.Join(errors.New("installation credentials are unavailable"), err)
	}
	operational, err := storage.OpenExisting(ctx, config.operationalFile(), storage.Operational)
	if err != nil {
		return err
	}
	defer operational.Close()
	if err := datasets.CheckStored(ctx, operational, config.Release); err != nil {
		return err
	}
	if err := objects.Existing(config.objectsDir()).Ready(); err != nil {
		return fmt.Errorf("private Object storage is unavailable: %w", err)
	}
	return nil
}
