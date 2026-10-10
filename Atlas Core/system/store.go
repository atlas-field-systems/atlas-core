// Package system owns Core's single SQLite database, Dataset opening, the
// shared write commit, retry identity, change records and activity records.
// Owning modules supply the meaning of every record; this package never reads
// their private tables.
package system

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	_ "embed"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/atlas-field-systems/atlas-core/coreerr"
	"github.com/atlas-field-systems/atlas-core/system/generated/storage"
	"github.com/google/uuid"
	_ "modernc.org/sqlite"
)

//go:embed sql/installation.sql
var installationSchema string

//go:embed sql/dataset.sql
var datasetSchema string

// Formats of the retained representation. Fingerprints detect changed
// persisted layouts even when the release identifier did not change.
const (
	InstallationFormat = 1
	DatasetFormat      = 1
)

// Module is a Core module that holds retained state. Its schema text and
// table names belong to the module; fresh opening drops and recreates only
// the Dataset tables the module names.
type Module interface {
	Name() string
	InstallationSchema() string
	DatasetSchema() string
	DatasetTables() []string
	// OpenRetained validates the module's records from a previous Core run
	// inside the opening transaction.
	OpenRetained(ctx context.Context, tx *sql.Tx) error
}

// Store is Core's database owner for one Core run.
type Store struct {
	db      *sql.DB
	release string
	clock   func() time.Time
	modules []Module
	faults  *Faults

	mu             sync.RWMutex
	dataset        string
	tokenKey       []byte
	installationID string
}

// OpenDatabase opens the database file with the durability settings used by
// every Core write: WAL, synchronous FULL and immediate write transactions.
func OpenDatabase(ctx context.Context, path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", "file:"+url.PathEscape(path)+"?_txlock=immediate")
	if err != nil {
		return nil, fmt.Errorf("open Core SQLite: %w", err)
	}
	// One connection serializes writers and readers inside this process.
	db.SetMaxOpenConns(1)
	if _, err := db.ExecContext(ctx, "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;"); err != nil {
		return nil, errors.Join(fmt.Errorf("configure Core SQLite: %w", err), db.Close())
	}
	return db, nil
}

// NewStore binds the database to this Core release. The system module's own
// schema is always applied before registered modules.
func NewStore(db *sql.DB, release string, clock func() time.Time, faults *Faults) *Store {
	return &Store{db: db, release: release, clock: clock, faults: faults}
}

// Register adds the modules whose state this store opens. Modules are
// constructed over the store, so registration follows construction.
func (s *Store) Register(modules ...Module) { s.modules = append(s.modules, modules...) }

// Now is Core time, from the deployment-provided host clock.
func (s *Store) Now() time.Time { return s.clock().UTC() }

// DatasetID is the open Dataset, or empty before opening.
func (s *Store) DatasetID() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.dataset
}

// InstallationID is the retained installation identity.
func (s *Store) InstallationID() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.installationID
}

// TokenKey is the installation-retained key that authenticates page tokens,
// so unexpired tokens survive Restart and old-Dataset tokens remain bound.
func (s *Store) TokenKey() []byte {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.tokenKey
}

// Release is the running Core release.
func (s *Store) Release() string { return s.release }

func fingerprint(parts ...string) string {
	sum := sha256.New()
	for _, part := range parts {
		sum.Write([]byte(part))
		sum.Write([]byte{0})
	}
	return hex.EncodeToString(sum.Sum(nil))
}

func (s *Store) fingerprints() (installation, dataset string) {
	installationParts := []string{installationSchema}
	datasetParts := []string{datasetSchema}
	for _, module := range s.modules {
		installationParts = append(installationParts, module.Name(), module.InstallationSchema())
		datasetParts = append(datasetParts, module.Name(), module.DatasetSchema(), strings.Join(module.DatasetTables(), ","))
	}
	return fingerprint(installationParts...), fingerprint(datasetParts...)
}

// Opening errors explain why serving stays disabled. They never wipe or
// convert retained data.
var (
	ErrNotSetUp        = errors.New("installation_not_set_up")
	ErrReleaseMismatch = errors.New("release_mismatch")
	ErrSchemaDrift     = errors.New("schema_drift")
	ErrInstallation    = errors.New("installation_conflict")
)

// Installation is the retained installation identity and its setup time.
type Installation struct {
	ID        string
	CreatedAt time.Time
}

// SetUpInstallation creates the installation tables and identity once. A
// repeated setup with the same identity returns without change; a different
// identity conflicts. setup runs in the same transaction for module facts.
func (s *Store) SetUpInstallation(ctx context.Context, installationID string, setup func(tx *sql.Tx, now time.Time) error) (created bool, err error) {
	if _, err := uuid.Parse(installationID); err != nil {
		return false, fmt.Errorf("installation identity must be a UUID: %w", err)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin installation setup: %w", err)
	}
	defer func() {
		if err != nil {
			err = errors.Join(err, rollback(tx))
		}
	}()
	if err := s.applyInstallationSchemas(ctx, tx); err != nil {
		return false, err
	}
	queries := storage.New(tx)
	installationFingerprint, _ := s.fingerprints()
	existing, err := queries.GetInstallation(ctx)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		key := make([]byte, 32)
		if _, err := rand.Read(key); err != nil {
			return false, fmt.Errorf("generate page token key: %w", err)
		}
		now := s.Now()
		if err := queries.InsertInstallation(ctx, storage.InsertInstallationParams{
			InstallationID: installationID, InstallationFormat: InstallationFormat,
			InstallationFingerprint: installationFingerprint, TokenKey: key, CreatedAt: formatTime(now),
		}); err != nil {
			return false, fmt.Errorf("record installation identity: %w", err)
		}
		if err := setup(tx, now); err != nil {
			return false, err
		}
		created = true
	case err != nil:
		return false, fmt.Errorf("read installation identity: %w", err)
	case existing.InstallationID != installationID:
		return false, fmt.Errorf("%w: database belongs to another installation", ErrInstallation)
	default:
		if err := setup(tx, parseTime(existing.CreatedAt)); err != nil {
			return false, err
		}
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("commit installation setup: %w", err)
	}
	return created, nil
}

func (s *Store) applyInstallationSchemas(ctx context.Context, tx *sql.Tx) error {
	if _, err := tx.ExecContext(ctx, installationSchema); err != nil {
		return fmt.Errorf("apply system installation schema: %w", err)
	}
	for _, module := range s.modules {
		if _, err := tx.ExecContext(ctx, module.InstallationSchema()); err != nil {
			return fmt.Errorf("apply %s installation schema: %w", module.Name(), err)
		}
	}
	return nil
}

// Establishment is Core's independent proof of which Dataset is current and
// which Reset identity, if any, established it.
type Establishment struct {
	InstallationID string
	DatasetID      string
	ResetID        string
	WritingRelease string
	EstablishedAt  time.Time
}

// Inspect reads the current establishment without opening the Dataset.
func (s *Store) Inspect(ctx context.Context) (Establishment, error) {
	var result Establishment
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return result, fmt.Errorf("begin establishment inspection: %w", err)
	}
	defer func() { err = errors.Join(err, rollback(tx)) }()
	queries := storage.New(tx)
	installation, err := queries.GetInstallation(ctx)
	if err != nil {
		if isMissing(err) {
			return result, ErrNotSetUp
		}
		return result, fmt.Errorf("read installation identity: %w", err)
	}
	result.InstallationID = installation.InstallationID
	metadata, err := queries.GetDatasetMetadata(ctx)
	if isMissing(err) {
		return result, nil
	}
	if err != nil {
		return result, fmt.Errorf("read Dataset metadata: %w", err)
	}
	result.DatasetID = metadata.DatasetID
	result.ResetID = metadata.ResetID.String
	result.WritingRelease = metadata.WritingRelease
	result.EstablishedAt = parseTime(metadata.EstablishedAt)
	return result, nil
}

// isMissing treats both an absent row and a not-yet-created table as absent
// state, so inspection of an unset installation is not an internal failure.
func isMissing(err error) bool {
	return errors.Is(err, sql.ErrNoRows) || (err != nil && strings.Contains(err.Error(), "no such table"))
}

// Open establishes the Dataset to serve. With an empty resetID it opens the
// retained Dataset, initializing the first Dataset on first use. With a Reset
// identity it opens fresh unless that identity already established the
// current Dataset, in which case it opens retained and preserves new work.
func (s *Store) Open(ctx context.Context, resetID string) (result Establishment, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return result, fmt.Errorf("begin Dataset opening: %w", err)
	}
	defer func() {
		if err != nil {
			err = errors.Join(err, rollback(tx))
		}
	}()
	queries := storage.New(tx)
	installation, err := queries.GetInstallation(ctx)
	if err != nil {
		if isMissing(err) {
			return result, ErrNotSetUp
		}
		return result, fmt.Errorf("read installation identity: %w", err)
	}
	installationFingerprint, datasetFingerprint := s.fingerprints()
	if installation.InstallationFormat != InstallationFormat || installation.InstallationFingerprint != installationFingerprint {
		return result, fmt.Errorf("%w: installation schema differs from this release", ErrSchemaDrift)
	}
	metadata, metadataErr := queries.GetDatasetMetadata(ctx)
	if metadataErr != nil && !isMissing(metadataErr) {
		return result, fmt.Errorf("read Dataset metadata: %w", metadataErr)
	}
	exists := metadataErr == nil
	fresh := !exists || (resetID != "" && metadata.ResetID.String != resetID)
	if !fresh {
		if metadata.WritingRelease != s.release {
			return result, fmt.Errorf("%w: Dataset was written by Core %s; use the explicit update and Reset flow", ErrReleaseMismatch, metadata.WritingRelease)
		}
		if metadata.DatasetFormat != DatasetFormat || metadata.DatasetFingerprint != datasetFingerprint {
			return result, fmt.Errorf("%w: Dataset schema differs from this release; an explicit Reset replaces it", ErrSchemaDrift)
		}
		if err := s.applyInstallationSchemas(ctx, tx); err != nil {
			return result, err
		}
		for _, module := range s.modules {
			if err := module.OpenRetained(ctx, tx); err != nil {
				return result, fmt.Errorf("open retained %s state: %w", module.Name(), err)
			}
		}
		result = Establishment{installation.InstallationID, metadata.DatasetID, metadata.ResetID.String, metadata.WritingRelease, parseTime(metadata.EstablishedAt)}
	} else {
		if err := s.applyInstallationSchemas(ctx, tx); err != nil {
			return result, err
		}
		if err := s.replaceDatasetTables(ctx, tx); err != nil {
			return result, err
		}
		now := s.Now()
		result = Establishment{installation.InstallationID, uuid.NewString(), resetID, s.release, now}
		if err := queries.ReplaceDatasetMetadata(ctx, storage.ReplaceDatasetMetadataParams{
			DatasetID: result.DatasetID, DatasetFormat: DatasetFormat, DatasetFingerprint: datasetFingerprint,
			WritingRelease: s.release, ResetID: sql.NullString{String: resetID, Valid: resetID != ""},
			EstablishedAt: formatTime(now),
		}); err != nil {
			return result, fmt.Errorf("establish Dataset: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return result, fmt.Errorf("commit Dataset opening: %w", err)
	}
	s.mu.Lock()
	s.dataset = result.DatasetID
	s.tokenKey = installation.TokenKey
	s.installationID = installation.InstallationID
	s.mu.Unlock()
	return result, nil
}

func (s *Store) replaceDatasetTables(ctx context.Context, tx *sql.Tx) error {
	drop := []string{"commits", "changes", "activity", "retry_claims"}
	for _, module := range s.modules {
		drop = append(drop, module.DatasetTables()...)
	}
	for _, table := range drop {
		if _, err := tx.ExecContext(ctx, `DROP TABLE IF EXISTS "`+table+`"`); err != nil {
			return fmt.Errorf("clear Dataset table %s: %w", table, err)
		}
	}
	if _, err := tx.ExecContext(ctx, datasetSchema); err != nil {
		return fmt.Errorf("apply system Dataset schema: %w", err)
	}
	for _, module := range s.modules {
		if _, err := tx.ExecContext(ctx, module.DatasetSchema()); err != nil {
			return fmt.Errorf("apply %s Dataset schema: %w", module.Name(), err)
		}
	}
	return nil
}

// Ping checks that the database answers, for readiness.
func (s *Store) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }

// Close closes the database after every writer has stopped.
func (s *Store) Close() error { return s.db.Close() }

// DatasetMismatch rejects a request that targets another Dataset. It carries
// the current nonsecret Dataset identity.
func DatasetMismatch(current string) *coreerr.Error {
	return coreerr.Conflict("dataset_mismatch", "The request targets a Dataset that is not current").With("current_dataset_id", current)
}

func rollback(tx *sql.Tx) error {
	if err := tx.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
		return fmt.Errorf("roll back transaction: %w", err)
	}
	return nil
}

// Times are stored as RFC 3339 UTC with nanoseconds so ordering by text is
// chronological.
const timeLayout = "2006-01-02T15:04:05.000000000Z"

func formatTime(t time.Time) string { return t.UTC().Format(timeLayout) }

// FormatTime stores a Core time.
func FormatTime(t time.Time) string { return formatTime(t) }

func parseTime(value string) time.Time {
	t, err := time.Parse(timeLayout, value)
	if err != nil {
		return time.Time{}
	}
	return t
}

// ParseTime reads a stored Core time.
func ParseTime(value string) time.Time { return parseTime(value) }
