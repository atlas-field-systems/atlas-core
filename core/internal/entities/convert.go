package entities

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/oapi-codegen/nullable"

	"github.com/atlas-field-systems/atlas-core/core/internal/api"
	"github.com/atlas-field-systems/atlas-core/core/internal/entities/internal/db"
	"github.com/atlas-field-systems/atlas-core/core/internal/problem"
)

var errPartialPosition = problem.Invalid("invalid_request", "Latitude and longitude must be supplied together.")

// checkPosition enforces the one telemetry rule the schema cannot express.
func checkPosition(telemetry *api.AssetTelemetryComponent) error {
	if telemetry != nil && (telemetry.Latitude == nil) != (telemetry.Longitude == nil) {
		return errPartialPosition
	}
	return nil
}

func toAPI(row db.Entity) (api.Entity, error) {
	id, err := uuid.Parse(row.ID)
	if err != nil {
		return api.Entity{}, fmt.Errorf("stored Entity ID %q: %w", row.ID, err)
	}
	entity := api.Entity{
		Id:      id,
		Kind:    api.EntityKindAsset,
		Alias:   nullableString(row.Alias),
		Subtype: nullableString(row.Subtype),
		Version: int(row.Version),
	}
	entity.Components.Status = api.AssetStatusComponent{Value: api.AssetStatus(row.Status), ReportedAt: nullableTime(row.StatusReportedAt)}
	entity.Components.Communications.LinkState = api.Communications(row.LinkState)
	entity.Components.Heartbeat.LastSeen = nullableTime(row.LastSeen)
	entity.Components.Telemetry = telemetryOf(row)
	entity.Components.Health = healthOf(row)
	if err := json.Unmarshal([]byte(row.CommandManifest), &entity.CommandManifest); err != nil {
		return api.Entity{}, fmt.Errorf("stored command manifest of %s: %w", row.ID, err)
	}
	return entity, nil
}

// telemetryOf returns nil when the Asset has reported no telemetry.
func telemetryOf(row db.Entity) *api.AssetTelemetryComponent {
	telemetry := api.AssetTelemetryComponent{
		Latitude:   floatPointer(row.Latitude),
		Longitude:  floatPointer(row.Longitude),
		AltitudeM:  floatPointer(row.AltitudeM),
		SpeedMps:   floatPointer(row.SpeedMps),
		HeadingDeg: floatPointer(row.HeadingDeg),
	}
	if telemetry == (api.AssetTelemetryComponent{}) {
		return nil
	}
	return &telemetry
}

func healthOf(row db.Entity) *api.AssetHealthComponent {
	if !row.BatteryPercent.Valid {
		return nil
	}
	return &api.AssetHealthComponent{BatteryPercent: row.BatteryPercent.Float64}
}

func batteryPercent(health *api.AssetHealthComponent) sql.NullFloat64 {
	if health == nil {
		return sql.NullFloat64{}
	}
	return sql.NullFloat64{Float64: health.BatteryPercent, Valid: true}
}

func valueOr[T any](value *T, fallback T) T {
	if value == nil {
		return fallback
	}
	return *value
}

func nullString(value *string) sql.NullString {
	if value == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: *value, Valid: true}
}

func nullFloat(value *float64) sql.NullFloat64 {
	if value == nil {
		return sql.NullFloat64{}
	}
	return sql.NullFloat64{Float64: *value, Valid: true}
}

func floatPointer(value sql.NullFloat64) *float64 {
	if !value.Valid {
		return nil
	}
	return &value.Float64
}

func nullableString(value sql.NullString) nullable.Nullable[string] {
	if !value.Valid {
		return nullable.NewNullNullable[string]()
	}
	return nullable.NewNullableWithValue(value.String)
}

func nullableTime(unixMilli sql.NullInt64) nullable.Nullable[time.Time] {
	if !unixMilli.Valid {
		return nullable.NewNullNullable[time.Time]()
	}
	return nullable.NewNullableWithValue(time.UnixMilli(unixMilli.Int64).UTC())
}
