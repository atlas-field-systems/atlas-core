package entities

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/atlas-field-systems/atlas-core/corefacts"
	storage "github.com/atlas-field-systems/atlas-core/entities/generated/storage"
	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/writecommit"
	"github.com/google/uuid"
	"github.com/oapi-codegen/nullable"
	"strconv"
	"strings"
	"time"
)

func observation(report Report, name string) protocol.MovementObservationTime {
	if report.Context.ObservationTimes != nil {
		if value, exists := (*report.Context.ObservationTimes)[name]; exists {
			return value
		}
	}
	return protocol.MovementObservationTime{ObservedAt: nullable.NewNullNullable[string]()}
}
func (m *Module) applyComponents(ctx context.Context, c *writecommit.Commit, value *protocol.Asset, report Report, a AcceptedReport, receipt *protocol.ReportAcceptance) (bool, error) {
	changed := false
	id := value.Id.String()
	if report.Manifest != nil {
		applied, err := newer(ctx, c, id, "command_manifest", a)
		if err != nil {
			return false, err
		}
		if applied {
			value.CommandManifest = *report.Manifest
			value.Reporting["command_manifest"] = metadataFor(report, a, receipt.ReceivedAt, nil)
			receipt.AppliedFields = append(receipt.AppliedFields, "command_manifest")
			changed = true
		}
	}
	if report.Components == nil {
		return changed, nil
	}
	if status := report.Components.Status; status != nil {
		applied, err := newer(ctx, c, id, "status", a)
		if err != nil {
			return false, err
		}
		if applied {
			reason := status.Reason
			if !reason.IsSpecified() {
				reason.SetNull()
			}
			before, err := json.Marshal(struct {
				Value   protocol.OperationalStatus
				Reason  nullable.Nullable[string]
				Details *protocol.StatusDetails
			}{value.Components.Status.Value, value.Components.Status.Reason, value.Components.Status.Details})
			if err != nil {
				return false, err
			}
			after, err := json.Marshal(struct {
				Value   protocol.OperationalStatus
				Reason  nullable.Nullable[string]
				Details *protocol.StatusDetails
			}{status.Value, reason, status.Details})
			if err != nil {
				return false, err
			}
			previousChanged := value.Components.Status.ChangedAt
			value.Components.Status = protocol.StatusComponent{Value: status.Value, Reason: reason, Details: status.Details, ReportedAt: report.Context.GeneratedAt, ReceivedAt: nullable.NewNullableWithValue(receipt.ReceivedAt), ChangedAt: previousChanged}
			if string(before) != string(after) {
				value.Components.Status.ChangedAt.Set(receipt.ReceivedAt)
			}
			value.Reporting["status"] = metadataFor(report, a, receipt.ReceivedAt, nil)
			receipt.AppliedFields = append(receipt.AppliedFields, "components.status")
			changed = true
		}
	}
	telemetry := report.Components.Telemetry
	if !telemetry.IsSpecified() {
		return changed, nil
	}
	patch := protocol.TelemetryPatch{}
	if telemetry.IsNull() {
		patch.Position.SetNull()
		patch.SpeedMps.SetNull()
		patch.Altitude.SetNull()
		patch.HeadingDeg.SetNull()
	} else {
		var err error
		patch, err = telemetry.Get()
		if err != nil {
			return false, err
		}
	}
	telemetryOf := func() *protocol.Telemetry {
		if value.Components.Telemetry == nil {
			value.Components.Telemetry = &protocol.Telemetry{}
		}
		return value.Components.Telemetry
	}
	quantities := protocol.MovementQuantities{}
	newQuantities := []string{}
	sampleID := uuid.New()
	q := storage.New(c.SQL)
	processQuantity := func(name string, encoded []byte) (bool, error) {
		identity := report.Context.ProcessGeneration + "/" + report.Context.Sequence
		if a.known {
			identity = strconv.FormatUint(a.generation, 10) + "/" + strconv.FormatUint(a.sequence, 10)
		} else {
			retained, err := report.Context.RetainedEvidenceId.Get()
			if err != nil {
				return false, err
			}
			identity = "retained/" + retained.String()
		}
		facts, err := corefacts.Canonical(encoded)
		if err != nil {
			return false, err
		}
		previous, err := q.ReadEvidence(ctx, storage.ReadEvidenceParams{AssetID: id, Identity: identity, Quantity: name})
		if err == nil {
			if previous.Original != string(facts) {
				return false, ErrEvidence
			}
			return false, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return false, err
		}
		if err = q.PutEvidence(ctx, storage.PutEvidenceParams{AssetID: id, Identity: identity, Quantity: name, Original: string(facts), SampleID: sampleID.String()}); err != nil {
			return false, err
		}
		newQuantities = append(newQuantities, name)
		return true, nil
	}
	if patch.Position.IsSpecified() {
		timing := observation(report, "position")
		quantity := protocol.MovementPosition{Value: patch.Position, ObservedAt: timing.ObservedAt, ClockUncertaintyMs: timing.ClockUncertaintyMs}
		encoded, err := json.Marshal(quantity)
		if err != nil {
			return false, err
		}
		capture, err := processQuantity("position", encoded)
		if err != nil {
			return false, err
		}
		if capture {
			quantities.Position = &quantity
		}
		applied, err := newer(ctx, c, id, "telemetry.position", a)
		if err != nil {
			return false, err
		}
		if applied {
			telemetryOf().Position = patch.Position
			if telemetry.IsNull() {
				telemetryOf().Position.SetUnspecified()
			}
			value.Reporting["telemetry.position"] = metadataFor(report, a, receipt.ReceivedAt, &timing)
			receipt.AppliedFields = append(receipt.AppliedFields, "components.telemetry.position")
			changed = true
		}
	}
	if patch.SpeedMps.IsSpecified() {
		timing := observation(report, "speed_mps")
		quantity := protocol.MovementSpeed{Value: patch.SpeedMps, ObservedAt: timing.ObservedAt, ClockUncertaintyMs: timing.ClockUncertaintyMs}
		encoded, err := json.Marshal(quantity)
		if err != nil {
			return false, err
		}
		capture, err := processQuantity("speed_mps", encoded)
		if err != nil {
			return false, err
		}
		if capture {
			quantities.SpeedMps = &quantity
		}
		applied, err := newer(ctx, c, id, "telemetry.speed_mps", a)
		if err != nil {
			return false, err
		}
		if applied {
			telemetryOf().SpeedMps = patch.SpeedMps
			if telemetry.IsNull() {
				telemetryOf().SpeedMps.SetUnspecified()
			}
			value.Reporting["telemetry.speed_mps"] = metadataFor(report, a, receipt.ReceivedAt, &timing)
			receipt.AppliedFields = append(receipt.AppliedFields, "components.telemetry.speed_mps")
			changed = true
		}
	}
	if patch.Altitude.IsSpecified() {
		timing := observation(report, "altitude")
		quantity := protocol.MovementAltitude{Value: patch.Altitude, ObservedAt: timing.ObservedAt, ClockUncertaintyMs: timing.ClockUncertaintyMs}
		encoded, err := json.Marshal(quantity)
		if err != nil {
			return false, err
		}
		capture, err := processQuantity("altitude", encoded)
		if err != nil {
			return false, err
		}
		if capture {
			quantities.Altitude = &quantity
		}
		applied, err := newer(ctx, c, id, "telemetry.altitude", a)
		if err != nil {
			return false, err
		}
		if applied {
			telemetryOf().Altitude = patch.Altitude
			if telemetry.IsNull() {
				telemetryOf().Altitude.SetUnspecified()
			}
			value.Reporting["telemetry.altitude"] = metadataFor(report, a, receipt.ReceivedAt, &timing)
			receipt.AppliedFields = append(receipt.AppliedFields, "components.telemetry.altitude")
			changed = true
		}
	}
	if patch.HeadingDeg.IsSpecified() {
		timing := observation(report, "heading_deg")
		applied, err := newer(ctx, c, id, "telemetry.heading_deg", a)
		if err != nil {
			return false, err
		}
		if applied {
			telemetryOf().HeadingDeg = patch.HeadingDeg
			if telemetry.IsNull() {
				telemetryOf().HeadingDeg.SetUnspecified()
			}
			value.Reporting["telemetry.heading_deg"] = metadataFor(report, a, receipt.ReceivedAt, &timing)
			receipt.AppliedFields = append(receipt.AppliedFields, "components.telemetry.heading_deg")
			changed = true
		}
	}
	if current := value.Components.Telemetry; telemetry.IsNull() && current != nil && !current.Position.IsSpecified() && !current.SpeedMps.IsSpecified() && !current.Altitude.IsSpecified() && !current.HeadingDeg.IsSpecified() {
		value.Components.Telemetry = nil
	}
	if len(newQuantities) != 0 {
		sample := protocol.MovementSample{Id: sampleID, EntityId: value.Id, ReportId: receipt.ReportId, ReceivedAt: receipt.ReceivedAt, Quantities: quantities, MatchedQuantities: []protocol.MovementSampleMatchedQuantities{}}
		for _, name := range newQuantities {
			sample.MatchedQuantities = append(sample.MatchedQuantities, protocol.MovementSampleMatchedQuantities(name))
		}
		body, err := json.Marshal(sample)
		if err != nil {
			return false, err
		}
		sequence, err := q.NextMovementSequence(ctx)
		if err != nil {
			return false, err
		}
		if err = q.PutMovement(ctx, storage.PutMovementParams{ID: sampleID.String(), AssetID: id, Quantity: strings.Join(newQuantities, ","), Value: string(body), ReceivedAt: receipt.ReceivedAt.Format(time.RFC3339Nano), ReceivedSeconds: receipt.ReceivedAt.Unix(), ReceivedNanos: int64(receipt.ReceivedAt.Nanosecond()), Sequence: sequence}); err != nil {
			return false, err
		}
		for _, name := range newQuantities {
			timing := observation(report, name)
			if timing.ObservedAt.IsNull() {
				continue
			}
			when, e := time.Parse(time.RFC3339Nano, timing.ObservedAt.GetOrEmpty())
			if e != nil {
				return false, e
			}
			if e = q.PutMovementObservation(ctx, storage.PutMovementObservationParams{SampleID: sampleID.String(), Quantity: name, ObservedSeconds: when.Unix(), ObservedNanos: int64(when.Nanosecond())}); e != nil {
				return false, e
			}
		}
		receipt.MovementSampleIds = append(receipt.MovementSampleIds, sampleID)
	}
	return changed, nil
}
