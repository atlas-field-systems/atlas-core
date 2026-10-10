// Package entities owns Asset Entities: identity reservations, registration,
// current Reported, Descriptive and Derived state, shared Asset report
// acceptance, Contact, movement history and deletion coordination.
package entities

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/atlas-field-systems/atlas-core/coreconfig"
	"github.com/atlas-field-systems/atlas-core/coreerr"
	"github.com/atlas-field-systems/atlas-core/entities/generated/storage"
	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/system"
	"github.com/oapi-codegen/nullable"
)

//go:embed sql/installation.sql
var installationSchema string

//go:embed sql/dataset.sql
var datasetSchema string

// ResourceKind names Entity changes in the commit change log.
const ResourceKind = "entity"

// Tasks is the Tasks module seen from Entities: it supplies the Tasks-owned
// queue aggregate for Entity images and the nonterminal-work deletion guard.
type Tasks interface {
	Queue(ctx context.Context, tx *sql.Tx, assetID string) (protocol.TaskQueue, error)
	NonterminalTaskIDs(ctx context.Context, tx *sql.Tx, assetID string) ([]string, error)
}

// Module is the Entities module for one Core run.
type Module struct {
	store      *system.Store
	tasks      Tasks
	settings   coreconfig.Settings
	challenges *challenges
}

// New constructs Entities. Call SetTasks before serving.
func New(store *system.Store, settings coreconfig.Settings) (*Module, error) {
	issuer, err := newChallenges(store, time.Duration(coreconfig.DefaultIPChallengeWindowMS)*time.Millisecond)
	if err != nil {
		return nil, err
	}
	return &Module{store: store, settings: settings, challenges: issuer}, nil
}

// SetTasks wires the Tasks collaborator, which itself depends on Entities.
func (m *Module) SetTasks(tasks Tasks) { m.tasks = tasks }

func (m *Module) Name() string               { return "entities" }
func (m *Module) InstallationSchema() string { return installationSchema }
func (m *Module) DatasetSchema() string      { return datasetSchema }
func (m *Module) DatasetTables() []string {
	return []string{"entities", "process_generations", "accepted_reports", "unit_boundaries", "movement_samples", "movement_facts"}
}

// OpenRetained validates retained Entity records before serving.
func (m *Module) OpenRetained(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, "SELECT entity_id, command_manifest, reporting, telemetry FROM entities")
	if err != nil {
		return fmt.Errorf("scan retained Entities: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, manifest, reporting string
		var telemetry sql.NullString
		if err := rows.Scan(&id, &manifest, &reporting, &telemetry); err != nil {
			return fmt.Errorf("scan retained Entity: %w", err)
		}
		if !json.Valid([]byte(manifest)) || !json.Valid([]byte(reporting)) || (telemetry.Valid && !json.Valid([]byte(telemetry.String))) {
			return fmt.Errorf("retained Entity %s has an integrity fault", id)
		}
	}
	return rows.Err()
}

// record is an Entity row with decoded variable payloads.
type record struct {
	row       storage.Entity
	manifest  protocol.CommandManifest
	telemetry map[string]json.RawMessage
	reporting map[string]protocol.ReportingUnit
}

func load(ctx context.Context, tx *sql.Tx, id string) (record, bool, error) {
	row, err := storage.New(tx).GetEntity(ctx, system.CanonicalIdentifier(id))
	if errors.Is(err, sql.ErrNoRows) {
		return record{}, false, nil
	}
	if err != nil {
		return record{}, false, fmt.Errorf("read Entity: %w", err)
	}
	rec, err := decode(row)
	return rec, true, err
}

func decode(row storage.Entity) (record, error) {
	rec := record{row: row, telemetry: map[string]json.RawMessage{}, reporting: map[string]protocol.ReportingUnit{}}
	if err := json.Unmarshal([]byte(row.CommandManifest), &rec.manifest); err != nil {
		return rec, fmt.Errorf("decode Command support: %w", err)
	}
	if row.Telemetry.Valid {
		if err := json.Unmarshal([]byte(row.Telemetry.String), &rec.telemetry); err != nil {
			return rec, fmt.Errorf("decode telemetry: %w", err)
		}
	}
	if err := json.Unmarshal([]byte(row.Reporting), &rec.reporting); err != nil {
		return rec, fmt.Errorf("decode reporting metadata: %w", err)
	}
	return rec, nil
}

// live loads an existing, nondeleted Entity or returns the public rejection.
func live(ctx context.Context, tx *sql.Tx, id string) (record, error) {
	rec, exists, err := load(ctx, tx, id)
	if err != nil {
		return rec, err
	}
	if !exists {
		return rec, coreerr.NotFound("The Entity does not exist in this Dataset")
	}
	if rec.row.DeletedAt.Valid {
		return rec, coreerr.Gone("entity_deleted", "The Entity was deleted")
	}
	return rec, nil
}

func nullableTime(value sql.NullString) nullable.Nullable[time.Time] {
	if !value.Valid {
		return nullable.NewNullNullable[time.Time]()
	}
	return nullable.NewNullableWithValue(system.ParseTime(value.String))
}

func nullableString(value sql.NullString) nullable.Nullable[string] {
	if !value.Valid {
		return nullable.NewNullNullable[string]()
	}
	return nullable.NewNullableWithValue(value.String)
}

func storedTime(t *time.Time) sql.NullString {
	if t == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: system.FormatTime(*t), Valid: true}
}

// image builds the public Entity representation, including the Tasks-owned
// queue aggregate.
func (m *Module) image(ctx context.Context, tx *sql.Tx, rec record) (protocol.Entity, error) {
	queue, err := m.tasks.Queue(ctx, tx, rec.row.EntityID)
	if err != nil {
		return protocol.Entity{}, err
	}
	entity := protocol.Entity{
		Id:              mustIdentifier(rec.row.EntityID),
		Type:            protocol.EntityType(rec.row.EntityType),
		Alias:           nullableString(rec.row.Alias),
		Subtype:         nullableString(rec.row.Subtype),
		Version:         fmt.Sprint(rec.row.Version),
		EditRevision:    fmt.Sprint(rec.row.EditRevision),
		CreatedAt:       system.ParseTime(rec.row.CreatedAt),
		UpdatedAt:       system.ParseTime(rec.row.UpdatedAt),
		CommandManifest: rec.manifest,
		Components: protocol.EntityComponents{
			Status: protocol.AssetStatus{
				Value:      protocol.AssetStatusValue(rec.row.StatusValue),
				Reason:     nullableString(rec.row.StatusReason),
				ReportedAt: nullableTime(rec.row.StatusReportedAt),
				ReceivedAt: nullableTime(rec.row.StatusReceivedAt),
				ChangedAt:  nullableTime(rec.row.StatusChangedAt),
			},
			Communications: protocol.AssetCommunications{State: protocol.CommunicationState(rec.row.CommunicationState)},
			Heartbeat:      protocol.AssetHeartbeat{LastSeen: nullableTime(rec.row.LastSeen)},
		},
		TaskQueue: queue,
	}
	if len(rec.telemetry) > 0 {
		encoded, err := json.Marshal(rec.telemetry)
		if err != nil {
			return entity, fmt.Errorf("encode telemetry: %w", err)
		}
		var telemetry protocol.AssetTelemetry
		if err := json.Unmarshal(encoded, &telemetry); err != nil {
			return entity, fmt.Errorf("decode telemetry: %w", err)
		}
		entity.Components.Telemetry = &telemetry
	}
	reporting := protocol.EntityReporting{}
	for unit, value := range rec.reporting {
		value := value
		switch unit {
		case unitStatus:
			reporting.Status = &value
		case unitManifest:
			reporting.CommandManifest = &value
		case unitPosition:
			reporting.Position = &value
		case unitSpeed:
			reporting.SpeedMps = &value
		case unitAltitude:
			reporting.Altitude = &value
		case unitHeading:
			reporting.HeadingDeg = &value
		}
	}
	entity.Reporting = reporting
	return entity, nil
}

func mustIdentifier(value string) protocol.Identifier {
	var identifier protocol.Identifier
	if err := identifier.UnmarshalText([]byte(value)); err != nil {
		panic(fmt.Sprintf("stored identifier %q is not a UUID", value))
	}
	return identifier
}

// save writes rec's mutable state with a new version stamped by this commit
// and publishes the Entity's final image.
func (m *Module) save(ctx context.Context, tx *system.Tx, rec *record) (protocol.Entity, error) {
	seq, err := tx.Seq()
	if err != nil {
		return protocol.Entity{}, err
	}
	rec.row.Version = seq
	rec.row.UpdatedAt = system.FormatTime(tx.Now())
	manifest, err := json.Marshal(rec.manifest)
	if err != nil {
		return protocol.Entity{}, fmt.Errorf("encode Command support: %w", err)
	}
	rec.row.CommandManifest = string(manifest)
	rec.row.Telemetry = sql.NullString{}
	if len(rec.telemetry) > 0 {
		encoded, err := json.Marshal(rec.telemetry)
		if err != nil {
			return protocol.Entity{}, fmt.Errorf("encode telemetry: %w", err)
		}
		rec.row.Telemetry = sql.NullString{String: string(encoded), Valid: true}
	}
	reporting, err := json.Marshal(rec.reporting)
	if err != nil {
		return protocol.Entity{}, fmt.Errorf("encode reporting metadata: %w", err)
	}
	rec.row.Reporting = string(reporting)
	row := rec.row
	if err := storage.New(tx.SQL()).UpdateEntity(ctx, storage.UpdateEntityParams{
		Alias: row.Alias, AliasKey: row.AliasKey, Subtype: row.Subtype, Version: row.Version, EditRevision: row.EditRevision,
		UpdatedAt: row.UpdatedAt, CommandManifest: row.CommandManifest, StatusValue: row.StatusValue, StatusReason: row.StatusReason,
		StatusReportedAt: row.StatusReportedAt, StatusReceivedAt: row.StatusReceivedAt, StatusChangedAt: row.StatusChangedAt,
		CommunicationState: row.CommunicationState, LastSeen: row.LastSeen, Telemetry: row.Telemetry, Reporting: row.Reporting,
		EntityID: row.EntityID,
	}); err != nil {
		return protocol.Entity{}, fmt.Errorf("update Entity: %w", err)
	}
	entity, err := m.image(ctx, tx.SQL(), *rec)
	if err != nil {
		return entity, err
	}
	return entity, tx.Publish(ResourceKind, row.EntityID, seq, entity)
}

// AssetFacts are what Task admission needs from Entities.
type AssetFacts struct {
	CommandManifest protocol.CommandManifest
}

// AdmissionFacts reads a live Asset inside the admission commit, serializing
// assignment with deletion.
func (m *Module) AdmissionFacts(ctx context.Context, tx *sql.Tx, assetID string) (AssetFacts, error) {
	rec, err := live(ctx, tx, assetID)
	if err != nil {
		return AssetFacts{}, err
	}
	return AssetFacts{CommandManifest: rec.manifest}, nil
}

// QueueChanged republishes an Asset whose Tasks-owned queue aggregate changed
// in this commit, so the Entity change and Task change share one commit.
func (m *Module) QueueChanged(ctx context.Context, tx *system.Tx, assetID string) error {
	rec, err := live(ctx, tx.SQL(), assetID)
	if err != nil {
		return err
	}
	_, err = m.save(ctx, tx, &rec)
	return err
}

// Get reads one live Entity.
func (m *Module) Get(ctx context.Context, datasetID, id string) (protocol.Entity, error) {
	var entity protocol.Entity
	err := m.store.Read(ctx, datasetID, func(tx *sql.Tx) error {
		rec, err := live(ctx, tx, id)
		if err != nil {
			return err
		}
		entity, err = m.image(ctx, tx, rec)
		return err
	})
	return entity, err
}

// GetByAlias resolves an Alias case-insensitively.
func (m *Module) GetByAlias(ctx context.Context, datasetID, alias string) (protocol.Entity, error) {
	var entity protocol.Entity
	err := m.store.Read(ctx, datasetID, func(tx *sql.Tx) error {
		row, err := storage.New(tx).GetEntityByAliasKey(ctx, sql.NullString{String: aliasKey(alias), Valid: true})
		if errors.Is(err, sql.ErrNoRows) {
			return coreerr.NotFound("No Entity has this Alias")
		}
		if err != nil {
			return fmt.Errorf("resolve Alias: %w", err)
		}
		rec, err := decode(row)
		if err != nil {
			return err
		}
		entity, err = m.image(ctx, tx, rec)
		return err
	})
	return entity, err
}

// Status reads an Asset's Operational status component.
func (m *Module) Status(ctx context.Context, datasetID, id string) (protocol.AssetStatusData, error) {
	entity, err := m.Get(ctx, datasetID, id)
	if err != nil {
		return protocol.AssetStatusData{}, err
	}
	return protocol.AssetStatusData{EntityId: entity.Id, Status: entity.Components.Status}, nil
}

// aliasKey is the case-insensitive uniqueness key of an Alias.
func aliasKey(alias string) string { return strings.ToLower(alias) }
