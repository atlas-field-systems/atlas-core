// Package management implements local administration shared by atlasctl and
// the TUI. It works on installation files directly and never uses the public
// API.
package management

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/atlas-field-systems/atlas-core/core/internal/identity"
	"github.com/atlas-field-systems/atlas-core/core/internal/storage"
)

// Installation is a local Atlas directory holding compose.yaml and state/.
type Installation struct {
	Root string
}

func (i Installation) SetupDir() string       { return filepath.Join(i.Root, "state", "setup") }
func (i Installation) OperationalDir() string { return filepath.Join(i.Root, "state", "operational") }
func (i Installation) FirstKeyFile() string   { return filepath.Join(i.SetupDir(), "first-key") }
func (i Installation) composeFile() string    { return filepath.Join(i.Root, "compose.yaml") }
func (i Installation) databaseFile() string {
	return filepath.Join(i.SetupDir(), "installation.sqlite")
}

func (i Installation) openIdentity(ctx context.Context) (*identity.Service, func() error, error) {
	db, err := storage.Open(ctx, i.databaseFile(), storage.Installation)
	if err != nil {
		return nil, nil, err
	}
	return identity.New(db), db.Close, nil
}

// Setup provisions the first operator credential and keeps one protected
// local copy. If an earlier Setup stopped after writing that copy, Setup
// finishes with the retained credential instead of issuing another.
func (i Installation) Setup(ctx context.Context) (string, error) {
	identities, closeDB, err := i.openIdentity(ctx)
	if err != nil {
		return "", err
	}
	defer closeDB()
	if setUp, err := identities.SetUp(ctx); err != nil || setUp {
		return "", errors.Join(errors.New("installation is already set up"), err)
	}
	key, err := readSecretFile(i.FirstKeyFile(), identity.OperatorPrefix)
	if errors.Is(err, os.ErrNotExist) {
		return i.issueFirstKey(ctx, identities)
	}
	if err != nil {
		return "", fmt.Errorf("inspect retained first credential: %w", err)
	}
	return key, identities.AddOperatorKey(ctx, key)
}

func (i Installation) issueFirstKey(ctx context.Context, identities *identity.Service) (string, error) {
	key, err := identity.NewCredential(identity.OperatorPrefix)
	if err != nil {
		return "", err
	}
	if err := writeSecretFile(i.FirstKeyFile(), key); err != nil {
		return "", fmt.Errorf("retain first credential: %w", err)
	}
	if err := identities.AddOperatorKey(ctx, key); err != nil {
		return "", errors.Join(err, os.Remove(i.FirstKeyFile()))
	}
	return key, nil
}

// Recover issues another operator credential through the trusted local
// filesystem boundary.
func (i Installation) Recover(ctx context.Context) (string, error) {
	identities, closeDB, err := i.openIdentity(ctx)
	if err != nil {
		return "", err
	}
	defer closeDB()
	if setUp, err := identities.SetUp(ctx); err != nil || !setUp {
		return "", errors.Join(errors.New("installation is not set up"), err)
	}
	key, err := identity.NewCredential(identity.OperatorPrefix)
	if err != nil {
		return "", err
	}
	return key, identities.AddOperatorKey(ctx, key)
}
