package entities

import (
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/oapi-codegen/nullable"

	"github.com/atlas-field-systems/atlas-core/core/internal/api"
	"github.com/atlas-field-systems/atlas-core/core/internal/entities/internal/db"
)

// mergeReport applies a report's components to the stored ones and checks
// the result. Status is applied separately because it carries its own time.
func mergeReport(current db.Entity, update api.AssetReport) (db.SetComponentsParams, error) {
	merged := db.SetComponentsParams{
		ID:              current.ID,
		Latitude:        current.Latitude,
		Longitude:       current.Longitude,
		AltitudeM:       current.AltitudeM,
		SpeedMps:        current.SpeedMps,
		HeadingDeg:      current.HeadingDeg,
		BatteryPercent:  current.BatteryPercent,
		CommandManifest: current.CommandManifest,
	}
	if components := update.Components; components != nil {
		if err := mergeTelemetry(&merged, components.Telemetry); err != nil {
			return db.SetComponentsParams{}, err
		}
		if err := mergeHealth(&merged, components.Health); err != nil {
			return db.SetComponentsParams{}, err
		}
	}
	if update.CommandManifest != nil {
		manifest, err := json.Marshal(*update.CommandManifest)
		if err != nil {
			return db.SetComponentsParams{}, fmt.Errorf("encode command manifest: %w", err)
		}
		merged.CommandManifest = string(manifest)
	}
	if merged.Latitude.Valid != merged.Longitude.Valid {
		return db.SetComponentsParams{}, errPartialPosition
	}
	return merged, nil
}

// mergeTelemetry replaces present fields, clears null ones, and clears all
// telemetry when the component itself is null.
func mergeTelemetry(merged *db.SetComponentsParams, patch nullable.Nullable[api.AssetTelemetryPatch]) error {
	if !patch.IsSpecified() {
		return nil
	}
	fields := []*sql.NullFloat64{&merged.Latitude, &merged.Longitude, &merged.AltitudeM, &merged.SpeedMps, &merged.HeadingDeg}
	if patch.IsNull() {
		for _, field := range fields {
			*field = sql.NullFloat64{}
		}
		return nil
	}
	telemetry, err := patch.Get()
	if err != nil {
		return err
	}
	values := []nullable.Nullable[float64]{telemetry.Latitude, telemetry.Longitude, telemetry.AltitudeM, telemetry.SpeedMps, telemetry.HeadingDeg}
	for index, value := range values {
		if err := mergeField(fields[index], value); err != nil {
			return err
		}
	}
	return nil
}

func mergeHealth(merged *db.SetComponentsParams, patch nullable.Nullable[api.AssetHealthPatch]) error {
	if !patch.IsSpecified() {
		return nil
	}
	if patch.IsNull() {
		merged.BatteryPercent = sql.NullFloat64{}
		return nil
	}
	health, err := patch.Get()
	if err != nil {
		return err
	}
	merged.BatteryPercent = sql.NullFloat64{Float64: health.BatteryPercent, Valid: true}
	return nil
}

func mergeField(field *sql.NullFloat64, patch nullable.Nullable[float64]) error {
	switch {
	case !patch.IsSpecified():
		return nil
	case patch.IsNull():
		*field = sql.NullFloat64{}
		return nil
	}
	value, err := patch.Get()
	if err != nil {
		return err
	}
	*field = sql.NullFloat64{Float64: value, Valid: true}
	return nil
}
