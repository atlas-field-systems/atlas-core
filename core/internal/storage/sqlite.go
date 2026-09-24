// Package storage opens Atlas SQLite databases and applies their migrations.
package storage

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"

	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

// Database names one SQLite file's migration set and its upgrade policy.
type Database struct {
	name string
	// upgradeInPlace applies newer migrations to existing data. Operational
	// Datasets are never migrated between schema versions (ADR-0015); an older
	// Dataset requires the explicit update and Reset flow instead.
	upgradeInPlace bool
}

var (
	Installation = Database{name: "installation", upgradeInPlace: true}
	Operational  = Database{name: "operational"}
)

// ErrResetRequired reports a Dataset written by an incompatible Core build.
var ErrResetRequired = errors.New("operational Dataset schema is incompatible with this Core build; use the explicit update and Reset flow")

//go:embed migrations
var migrations embed.FS

// connectionOptions apply to every pooled connection. Immediate transactions
// take the write lock up front so concurrent writers wait on busy_timeout
// instead of failing on a lock upgrade.
var connectionOptions = url.Values{
	"_pragma": {"busy_timeout(5000)", "foreign_keys(1)", "journal_mode(WAL)"},
	"_txlock": {"immediate"},
}

// Open opens or creates a private database file and brings its schema to the
// version this build expects.
func Open(ctx context.Context, file string, database Database) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return nil, fmt.Errorf("create %s storage directory: %w", database.name, err)
	}
	if err := os.Chmod(filepath.Dir(file), 0o700); err != nil {
		return nil, fmt.Errorf("protect %s storage directory: %w", database.name, err)
	}
	source, err := dsn(file, connectionOptions)
	if err != nil {
		return nil, fmt.Errorf("locate %s storage: %w", database.name, err)
	}
	db, err := sql.Open("sqlite", source)
	if err != nil {
		return nil, fmt.Errorf("open %s storage: %w", database.name, err)
	}
	if err := prepare(ctx, db, file, database); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func prepare(ctx context.Context, db *sql.DB, file string, database Database) error {
	if err := db.PingContext(ctx); err != nil {
		return fmt.Errorf("open %s storage: %w", database.name, err)
	}
	if err := os.Chmod(file, 0o600); err != nil {
		return fmt.Errorf("protect %s storage: %w", database.name, err)
	}
	return migrate(ctx, db, database)
}

// OpenExisting opens a database read-only without creating or migrating it,
// and fails unless its schema matches this build.
func OpenExisting(ctx context.Context, file string, database Database) (*sql.DB, error) {
	source, err := dsn(file, url.Values{"mode": {"ro"}})
	if err != nil {
		return nil, fmt.Errorf("locate %s storage: %w", database.name, err)
	}
	db, err := sql.Open("sqlite", source)
	if err != nil {
		return nil, fmt.Errorf("open %s storage: %w", database.name, err)
	}
	if err := requireCurrent(ctx, db, database); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func requireCurrent(ctx context.Context, db *sql.DB, database Database) error {
	steps, err := migrationFiles(database)
	if err != nil {
		return err
	}
	version, err := schemaVersion(ctx, db)
	if err != nil {
		return fmt.Errorf("read %s schema version: %w", database.name, err)
	}
	if version != len(steps) {
		return fmt.Errorf("%s schema version %d does not match this build's %d", database.name, version, len(steps))
	}
	return nil
}

// IsConstraint reports whether err is a SQLite constraint violation, such as
// a duplicate key.
func IsConstraint(err error) bool {
	var sqliteErr *sqlite.Error
	return errors.As(err, &sqliteErr) && sqliteErr.Code()&0xff == sqlite3.SQLITE_CONSTRAINT
}

// dsn builds a SQLite URI. The path must be absolute; a relative path would be
// read as a URI authority.
func dsn(file string, options url.Values) (string, error) {
	absolute, err := filepath.Abs(file)
	if err != nil {
		return "", err
	}
	return (&url.URL{Scheme: "file", Path: absolute, RawQuery: options.Encode()}).String(), nil
}

func migrate(ctx context.Context, db *sql.DB, database Database) error {
	steps, err := migrationFiles(database)
	if err != nil {
		return err
	}
	version, err := schemaVersion(ctx, db)
	if err != nil {
		return fmt.Errorf("read %s schema version: %w", database.name, err)
	}
	switch {
	case version > len(steps):
		return fmt.Errorf("%s storage was written by a newer Core build (schema %d, this build %d)", database.name, version, len(steps))
	case version > 0 && version < len(steps) && !database.upgradeInPlace:
		return ErrResetRequired
	}
	for index := version; index < len(steps); index++ {
		if err := applyMigration(ctx, db, steps[index], index+1); err != nil {
			return fmt.Errorf("apply %s migration %s: %w", database.name, path.Base(steps[index]), err)
		}
	}
	return nil
}

func migrationFiles(database Database) ([]string, error) {
	steps, err := fs.Glob(migrations, path.Join("migrations", database.name, "*.sql"))
	if err != nil {
		return nil, err
	}
	sort.Strings(steps)
	return steps, nil
}

func schemaVersion(ctx context.Context, db *sql.DB) (int, error) {
	var version int
	err := db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version)
	return version, err
}

func applyMigration(ctx context.Context, db *sql.DB, file string, version int) error {
	statements, err := migrations.ReadFile(file)
	if err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, string(statements)); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", version)); err != nil {
		return err
	}
	return tx.Commit()
}
