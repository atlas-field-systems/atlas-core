// Package writecommit owns SQLite durability, Dataset fencing and atomic journals.
package writecommit

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	storage "github.com/atlas-field-systems/atlas-core/writecommit/generated/storage"
	"github.com/google/uuid"
	_ "modernc.org/sqlite"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"time"
)

//go:embed sql/schema.sql
var files embed.FS

func Schema() string { body, _ := files.ReadFile("sql/schema.sql"); return string(body) }

var ErrDataset = errors.New("dataset_mismatch")
var ErrIntegrity = errors.New("incompatible_storage")
var ErrSchemaDrift = errors.New("schema_drift")
var ErrWritingRelease = errors.New("writing_release_mismatch")
var ErrLimit = errors.New("resource_limit")

type Config struct {
	Path, WritingRelease, DatasetFingerprint, InstallationFingerprint string
	Schemas                                                           []string
	BeforeCommit                                                      func(context.Context) error
}
type Boundary struct {
	db      *sql.DB
	cfg     Config
	maximum atomic.Int64
}
type Metadata struct {
	InstallationFormat, DatasetFormat                                                                                  int64
	InstallationID, DatasetID, LastResetID, WritingRelease, DatasetFingerprint, InstallationFingerprint, Configuration string
	Position                                                                                                           int64
}
type Change struct {
	Kind, ID string
	Value    json.RawMessage
}
type Activity struct {
	ActionID, Actor, ActorType, Action, Outcome string
	Resources                                   []string
	At                                          string
}
type Commit struct {
	SQL        *sql.Tx
	Metadata   Metadata
	Changes    []Change
	Activities []Activity
	Mutated    bool
	maximum    int64
}

func (c *Commit) Changed(kind, id string, value interface{}) error {
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	c.Changes = append(c.Changes, Change{kind, id, body})
	c.Mutated = true
	return nil
}
func (c *Commit) Record(actor, action string, ids ...string) {
	c.Activities = append(c.Activities, Activity{ActionID: uuid.NewString(), Actor: actor, ActorType: "internal", Action: action, Outcome: "confirmed", Resources: ids, At: time.Now().UTC().Format(time.RFC3339Nano)})
	c.Mutated = true
}
func metadata(value storage.CoreMetadatum) Metadata {
	return Metadata{value.InstallationFormat, value.DatasetFormat, value.InstallationID, value.DatasetID, value.LastResetID, value.WritingRelease, value.DatasetFingerprint, value.InstallationFingerprint, value.Configuration, value.CommitPosition}
}
func Open(ctx context.Context, cfg Config) (_ *Boundary, result error) {
	if cfg.Path == "" {
		return nil, errors.New("owned SQLite path is required")
	}
	if err := os.MkdirAll(filepath.Dir(cfg.Path), 0700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(cfg.Path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = errors.Join(file.Chmod(0600), file.Close()); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", "file:"+url.PathEscape(cfg.Path)+"?_txlock=immediate")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	defer func() {
		if result != nil {
			result = errors.Join(result, db.Close())
		}
	}()
	if _, err = db.ExecContext(ctx, "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;"); err != nil {
		return nil, err
	}
	var exists int
	if err = db.QueryRowContext(ctx, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='core_metadata'").Scan(&exists); err != nil {
		return nil, err
	}
	q := storage.New(db)
	if exists != 0 {
		value, err := q.ReadMetadata(ctx)
		if err != nil {
			return nil, fmt.Errorf("read retained format: %w", err)
		}
		if value.InstallationFormat != 1 || value.DatasetFormat != 1 {
			return nil, ErrIntegrity
		}
		if value.WritingRelease != cfg.WritingRelease {
			return nil, ErrWritingRelease
		}
		if value.DatasetFingerprint != cfg.DatasetFingerprint || value.InstallationFingerprint != cfg.InstallationFingerprint {
			return nil, ErrSchemaDrift
		}
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() {
		if result != nil {
			result = errors.Join(result, tx.Rollback())
		}
	}()
	if exists == 0 {
		for _, schema := range append([]string{Schema()}, cfg.Schemas...) {
			if _, err = tx.ExecContext(ctx, schema); err != nil {
				return nil, fmt.Errorf("initialize owned storage: %w", err)
			}
		}
	}
	if exists == 0 {
		err = storage.New(tx).InsertMetadata(ctx, storage.InsertMetadataParams{WritingRelease: cfg.WritingRelease, DatasetFingerprint: cfg.DatasetFingerprint, InstallationFingerprint: cfg.InstallationFingerprint})
		if err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return &Boundary{db: db, cfg: cfg}, nil
}
func (b *Boundary) Close() error { return b.db.Close() }
func (b *Boundary) Inspect(ctx context.Context) (Metadata, error) {
	value, err := storage.New(b.db).ReadMetadata(ctx)
	return metadata(value), err
}
func (b *Boundary) Read(ctx context.Context, dataset string, read func(*Commit) error) error {
	_, err := b.Apply(ctx, dataset, read)
	return err
}
func (b *Boundary) Apply(ctx context.Context, dataset string, apply func(*Commit) error) (cursor string, result error) {
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer func() {
		if result != nil {
			rollback := tx.Rollback()
			if rollback != nil && !errors.Is(rollback, sql.ErrTxDone) {
				result = errors.Join(result, rollback)
			}
		}
	}()
	q := storage.New(tx)
	value, err := q.ReadMetadata(ctx)
	if err != nil {
		return "", err
	}
	if dataset != "" && dataset != value.DatasetID {
		return "", ErrDataset
	}
	c := &Commit{SQL: tx, Metadata: metadata(value), maximum: b.maximum.Load()}
	if err = apply(c); err != nil {
		return "", err
	}
	if len(c.Changes) != 0 {
		if err := c.CheckResponse(struct {
			DatasetID    string   `json:"dataset_id"`
			CommitCursor string   `json:"commit_cursor"`
			Changes      []Change `json:"changes"`
		}{c.Metadata.DatasetID, c.Cursor(), c.Changes}); err != nil {
			return "", err
		}
	}
	position := c.Metadata.Position
	if c.Mutated {
		position++
		if err = q.SetPosition(ctx, position); err != nil {
			return "", err
		}
	}
	for i, change := range c.Changes {
		if err = q.RecordChange(ctx, storage.RecordChangeParams{Position: position, Item: int64(i), ResourceKind: change.Kind, ResourceID: change.ID, Value: string(change.Value)}); err != nil {
			return "", err
		}
	}
	for i, activity := range c.Activities {
		ids, err := json.Marshal(activity.Resources)
		if err != nil {
			return "", err
		}
		if err = q.RecordActivity(ctx, storage.RecordActivityParams{Position: position, Item: int64(i), ActionID: activity.ActionID, Actor: activity.Actor, ActorType: activity.ActorType, Action: activity.Action, Outcome: activity.Outcome, Resources: string(ids), OccurredAt: activity.At}); err != nil {
			return "", err
		}
	}
	if c.Mutated && b.cfg.BeforeCommit != nil {
		if err = b.cfg.BeforeCommit(ctx); err != nil {
			return "", err
		}
	}
	if err = tx.Commit(); err != nil {
		return "", err
	}
	return strconv.FormatInt(position, 10), nil
}
func (b *Boundary) Setup(ctx context.Context, c *Commit, id, dataset, configuration string) error {
	c.Mutated = true
	return storage.New(c.SQL).EstablishSetup(ctx, storage.EstablishSetupParams{InstallationID: id, DatasetID: dataset, Configuration: configuration})
}
func (b *Boundary) Reset(ctx context.Context, c *Commit, dataset, reset string) error {
	q := storage.New(c.SQL)
	if err := q.ClearChanges(ctx); err != nil {
		return err
	}
	if err := q.ClearActivity(ctx); err != nil {
		return err
	}
	if err := q.ClearLocalActions(ctx); err != nil {
		return err
	}
	c.Metadata.Position = 0
	c.Metadata.DatasetID = dataset
	c.Metadata.LastResetID = reset
	c.Mutated = false
	return q.EstablishReset(ctx, storage.EstablishResetParams{DatasetID: dataset, LastResetID: reset})
}

func (b *Boundary) RecordLocal(ctx context.Context, c *Commit, id, actor, kind, at string) error {
	q := storage.New(c.SQL)
	if _, err := q.ReadLocalAction(ctx, id); err == nil {
		return nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if err := q.PutLocalAction(ctx, id); err != nil {
		return err
	}
	c.Activities = append(c.Activities, Activity{ActionID: id, Actor: actor, ActorType: "local_owner", Action: kind, Outcome: "accepted", Resources: []string{}, At: at})
	c.Mutated = true
	return nil
}

type JournalCounts struct{ Changes, Activities int64 }

func (b *Boundary) Journal(ctx context.Context, c *Commit) (JournalCounts, error) {
	q := storage.New(c.SQL)
	changes, err := q.CountChanges(ctx)
	if err != nil {
		return JournalCounts{}, err
	}
	activities, err := q.CountActivity(ctx)
	return JournalCounts{changes, activities}, err
}

func (c *Commit) Cursor() string {
	position := c.Metadata.Position
	if c.Mutated {
		position++
	}
	return strconv.FormatInt(position, 10)
}
func (c *Commit) CheckResponse(value interface{}) error { return CheckResult(c.maximum, value) }

// CheckResult bounds the complete public result before a mutation commits or a
// read advertises success. Callers can retry a refused page with a smaller limit.
func CheckResult(maximum int64, value interface{}) error {
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if maximum > 0 && int64(len(body)) > maximum {
		return ErrLimit
	}
	return nil
}
func (b *Boundary) SetMaximumJSONBytes(maximum int64) { b.maximum.Store(maximum) }

func (c *Commit) RecordAction(actionID, actor, actorType, action string, ids ...string) {
	c.Activities = append(c.Activities, Activity{ActionID: actionID, Actor: actor, ActorType: actorType, Action: action, Outcome: "confirmed", Resources: ids, At: time.Now().UTC().Format(time.RFC3339Nano)})
	c.Mutated = true
}
func (b *Boundary) ActivityFacts(ctx context.Context, c *Commit) ([]Activity, error) {
	rows, err := storage.New(c.SQL).ReadActivityFacts(ctx)
	if err != nil {
		return nil, err
	}
	values := []Activity{}
	for _, row := range rows {
		var ids []string
		if err = json.Unmarshal([]byte(row.Resources), &ids); err != nil {
			return nil, err
		}
		values = append(values, Activity{ActionID: row.ActionID, Actor: row.Actor, ActorType: row.ActorType, Action: row.Action, Outcome: row.Outcome, Resources: ids, At: row.OccurredAt})
	}
	return values, nil
}
