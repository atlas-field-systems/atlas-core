package entities

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"time"

	"github.com/atlas-field-systems/atlas-core/canonical"
	"github.com/atlas-field-systems/atlas-core/coreerr"
	"github.com/atlas-field-systems/atlas-core/entities/generated/storage"
	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/identity"
	"github.com/atlas-field-systems/atlas-core/system"
	"github.com/google/uuid"
	"github.com/oapi-codegen/nullable"
)

// Reporting units with independent ordering boundaries. Position latitude and
// longitude form one unit.
const (
	unitStatus   = "status"
	unitManifest = "command_manifest"
	unitPosition = "position"
	unitSpeed    = "speed_mps"
	unitAltitude = "altitude"
	unitHeading  = "heading_deg"
)

var telemetryUnits = []string{unitPosition, unitSpeed, unitAltitude, unitHeading}

// movementQuantities are captured in movement history; heading is not.
var movementQuantities = []string{unitPosition, unitSpeed, unitAltitude}

// Derived and immutable members accepted structurally only so their presence
// rejects the whole request as a forbidden field. Registration supplies
// identity; later requests cannot change it.
var (
	forbiddenDerived    = []string{"version", "edit_revision", "created_at", "updated_at", "reporting", "task_queue"}
	forbiddenTopLevel   = append([]string{"id", "type"}, forbiddenDerived...)
	forbiddenComponents = []string{"communications", "heartbeat"}
)

var (
	descriptiveMembers = []string{"alias", "subtype", "expected_edit_revision"}
	reportMembers      = []string{"report_context", "command_manifest", "components"}
)

func forbiddenField(paths ...string) *coreerr.Error {
	return coreerr.Forbidden("forbidden_field", "The request supplies fields its caller cannot write").Paths(paths...)
}

func invalidComponent(message string, paths ...string) *coreerr.Error {
	return coreerr.Invalid("invalid_component", message).Paths(paths...)
}

// present lists which of names are members of an original JSON object.
func present(members map[string]json.RawMessage, prefix string, names []string) []string {
	var found []string
	for _, name := range names {
		if _, ok := members[name]; ok {
			found = append(found, prefix+"/"+name)
		}
	}
	return found
}

func objectMembers(members map[string]json.RawMessage, name string) (map[string]json.RawMessage, error) {
	raw, ok := members[name]
	if !ok || string(raw) == "null" {
		return nil, nil
	}
	return canonical.Members(raw)
}

// checkDerived rejects Derived and immutable members anywhere a request names
// Entity fields.
func checkDerived(members map[string]json.RawMessage, topLevel []string) error {
	paths := present(members, "", topLevel)
	components, err := objectMembers(members, "components")
	if err != nil {
		return err
	}
	paths = append(paths, present(components, "/components", forbiddenComponents)...)
	if len(paths) > 0 {
		return forbiddenField(paths...)
	}
	return nil
}

// reported is the Reported data carried by one report.
type reported struct {
	manifest  *protocol.CommandManifest
	status    nullable.Nullable[protocol.AssetStatusReport]
	telemetry nullable.Nullable[protocol.TelemetryPatch]
	// Original JSON fragments for each supplied telemetry member.
	telemetryRaw map[string]json.RawMessage
}

func reportedFrom(manifest *protocol.CommandManifest, components *protocol.ComponentsPatch, payload map[string]json.RawMessage) (reported, error) {
	rep := reported{manifest: manifest}
	if components != nil {
		rep.status, rep.telemetry = components.Status, components.Telemetry
	}
	componentMembers, err := objectMembers(payload, "components")
	if err != nil {
		return rep, err
	}
	rep.telemetryRaw, err = objectMembers(componentMembers, "telemetry")
	return rep, err
}

// validate applies the semantic checks the schema cannot express.
func (rep reported) validate(acceptance *Acceptance) error {
	if rep.status.IsSpecified() && rep.status.IsNull() {
		return invalidComponent("The required status component cannot be removed", "/components/status")
	}
	if rep.manifest != nil {
		seen := map[protocol.CommandName]bool{}
		for index, support := range *rep.manifest {
			if seen[support.Command] {
				return invalidComponent("Each Command appears once in Command support", fmt.Sprintf("/command_manifest/%d/command", index))
			}
			seen[support.Command] = true
			if len(support.Scheduling) == 2 && support.Scheduling[0] == support.Scheduling[1] {
				return invalidComponent("Scheduling choices are unique", fmt.Sprintf("/command_manifest/%d/scheduling", index))
			}
		}
	}
	if rep.telemetry.IsSpecified() && !rep.telemetry.IsNull() {
		telemetry := rep.telemetry.MustGet()
		if telemetry.HeadingDeg.IsSpecified() && !telemetry.HeadingDeg.IsNull() && telemetry.HeadingDeg.MustGet() >= 360 {
			return invalidComponent("Heading is 0 inclusive to 360 exclusive", "/components/telemetry/heading_deg")
		}
	}
	for quantity := range acceptance.ObservationTimes {
		raw, supplied := rep.telemetryRaw[quantity]
		if !slices.Contains(telemetryUnits, quantity) || !supplied || string(raw) == "null" {
			return invalidReport("Observation time names a quantity this report does not supply", "/report_context/observation_times/"+quantity)
		}
	}
	return nil
}

// apply records each reported unit that is newer than its boundary, and
// captures previously unrecorded movement. It returns the applied paths and
// new movement sample IDs.
func (m *Module) apply(ctx context.Context, tx *system.Tx, acceptance *Acceptance, rep reported) ([]string, []string, error) {
	rec := &acceptance.entity
	var applied []string
	if rep.manifest != nil {
		advance, err := boundaryAdvance(ctx, tx.SQL(), acceptance, unitManifest)
		if err != nil {
			return nil, nil, err
		}
		if advance {
			rec.manifest = *rep.manifest
			rec.reporting[unitManifest] = reportingUnit(acceptance, nil, false)
			applied = append(applied, "/command_manifest")
		}
	}
	if rep.status.IsSpecified() {
		advance, err := boundaryAdvance(ctx, tx.SQL(), acceptance, unitStatus)
		if err != nil {
			return nil, nil, err
		}
		if advance {
			status := rep.status.MustGet()
			received := acceptance.ReceivedAt
			if rec.row.StatusValue != string(status.Value) {
				rec.row.StatusChangedAt = storedTime(&received)
			}
			rec.row.StatusValue = string(status.Value)
			rec.row.StatusReason = sql.NullString{}
			if status.Reason.IsSpecified() && !status.Reason.IsNull() {
				rec.row.StatusReason = sql.NullString{String: status.Reason.MustGet(), Valid: true}
			}
			rec.row.StatusReportedAt = storedTime(acceptance.GeneratedAt)
			rec.row.StatusReceivedAt = storedTime(&received)
			rec.reporting[unitStatus] = reportingUnit(acceptance, nil, false)
			applied = append(applied, "/components/status")
		}
	}
	if rep.telemetry.IsSpecified() {
		for _, unit := range telemetryUnits {
			raw, supplied := rep.telemetryRaw[unit]
			removeAll := rep.telemetry.IsNull()
			if !removeAll && !supplied {
				continue
			}
			advance, err := boundaryAdvance(ctx, tx.SQL(), acceptance, unit)
			if err != nil {
				return nil, nil, err
			}
			if !advance {
				continue
			}
			if removeAll || string(raw) == "null" {
				if _, had := rec.telemetry[unit]; had {
					delete(rec.telemetry, unit)
					delete(rec.reporting, unit)
					applied = append(applied, "/components/telemetry/"+unit)
				}
				continue
			}
			rec.telemetry[unit] = raw
			rec.reporting[unit] = reportingUnit(acceptance, acceptance.ObservationTimes[unit], true)
			applied = append(applied, "/components/telemetry/"+unit)
		}
	}
	if len(applied) > 0 {
		acceptance.entityChanged = true
	}
	samples, err := m.captureMovement(ctx, tx, acceptance, rep)
	return applied, samples, err
}

type movementQuantity struct {
	Value       json.RawMessage `json:"value"`
	ObservedAt  *time.Time      `json:"observed_at"`
	Uncertainty json.RawMessage `json:"clock_uncertainty_ms,omitempty"`
}

// captureMovement appends one sample of the explicitly supplied movement
// quantities not previously recorded under their original evidence identity.
func (m *Module) captureMovement(ctx context.Context, tx *system.Tx, acceptance *Acceptance, rep reported) ([]string, error) {
	if !rep.telemetry.IsSpecified() || rep.telemetry.IsNull() {
		return nil, nil
	}
	queries := storage.New(tx.SQL())
	sampleID := uuid.NewString()
	quantities := map[string]movementQuantity{}
	var earliest *time.Time
	for _, quantity := range movementQuantities {
		raw, supplied := rep.telemetryRaw[quantity]
		if !supplied || string(raw) == "null" {
			continue
		}
		observation := acceptance.ObservationTimes[quantity]
		observationFact := observation
		if observationFact == nil {
			observationFact = json.RawMessage("null")
		}
		facts, err := canonical.Object(map[string]json.RawMessage{"value": raw, "observation": observationFact})
		if err != nil {
			return nil, err
		}
		existing, err := queries.GetMovementFact(ctx, storage.GetMovementFactParams{EntityID: acceptance.AssetID, EvidenceKey: acceptance.EvidenceKey, Quantity: quantity})
		if err == nil {
			if !bytes.Equal([]byte(existing.Facts), facts) {
				return nil, coreerr.Conflict("evidence_identity_conflict", "The original evidence identity was already recorded with different facts").Paths("/components/telemetry/" + quantity)
			}
			continue
		}
		if err != sql.ErrNoRows {
			return nil, fmt.Errorf("read movement evidence: %w", err)
		}
		entry := movementQuantity{Value: raw}
		if observation != nil {
			var timing protocol.MovementObservationTime
			if err := json.Unmarshal(observation, &timing); err != nil {
				return nil, fmt.Errorf("decode validated observation time: %w", err)
			}
			if timing.ObservedAt.IsSpecified() && !timing.ObservedAt.IsNull() {
				observed := timing.ObservedAt.MustGet().UTC()
				entry.ObservedAt = &observed
				if earliest == nil || observed.Before(*earliest) {
					earliest = &observed
				}
			}
			if timing.ClockUncertaintyMs.IsSpecified() {
				encoded, err := json.Marshal(timing.ClockUncertaintyMs)
				if err != nil {
					return nil, fmt.Errorf("encode observation metadata: %w", err)
				}
				entry.Uncertainty = encoded
			}
		}
		quantities[quantity] = entry
		if err := queries.InsertMovementFact(ctx, storage.InsertMovementFactParams{EntityID: acceptance.AssetID, EvidenceKey: acceptance.EvidenceKey, Quantity: quantity, Facts: string(facts), SampleID: sampleID}); err != nil {
			return nil, fmt.Errorf("record movement evidence: %w", err)
		}
	}
	if len(quantities) == 0 {
		return nil, nil
	}
	order, err := queries.NextReceivedOrder(ctx)
	if err != nil {
		return nil, fmt.Errorf("allocate movement order: %w", err)
	}
	encoded, err := json.Marshal(quantities)
	if err != nil {
		return nil, fmt.Errorf("encode movement sample: %w", err)
	}
	params := storage.InsertMovementSampleParams{
		SampleID: sampleID, EntityID: acceptance.AssetID, ReceivedOrder: order, ReceivedAt: system.FormatTime(acceptance.ReceivedAt),
		Quantities: string(encoded), EarliestObservedAt: storedTime(earliest),
	}
	if acceptance.Ordering != nil {
		params.OriginGeneration = sql.NullInt64{Int64: acceptance.Ordering.Generation, Valid: true}
		params.OriginSequence = sql.NullInt64{Int64: acceptance.Ordering.Sequence, Valid: true}
	} else {
		params.RetainedEvidenceID = sql.NullString{String: acceptance.EvidenceKey[len("r:"):], Valid: true}
	}
	if err := queries.InsertMovementSample(ctx, params); err != nil {
		return nil, fmt.Errorf("record movement sample: %w", err)
	}
	return []string{sampleID}, nil
}

// ReportResponse is the committed or replayed result of an Entity report.
type ReportResponse struct {
	Data   protocol.EntityMutationData
	Cursor string
}

// report runs one Entity report route through shared acceptance and applies
// its Reported data in the same commit.
func (m *Module) report(ctx context.Context, principal identity.Principal, datasetID string, env Envelope, extract func(*Acceptance) (reported, error)) (ReportResponse, error) {
	var response ReportResponse
	cursor, err := m.store.Commit(ctx, datasetID, "report."+env.Operation, func(tx *system.Tx) error {
		if !system.SameIdentifier(env.TargetID, env.Context.AssetId.String()) {
			return invalidReport("The report targets another Entity than its Asset", "/report_context/asset_id")
		}
		acceptance, duplicate, err := m.Accept(ctx, tx, principal, env)
		if err != nil {
			return err
		}
		if duplicate != nil {
			entity, err := m.CurrentEntity(ctx, tx.SQL(), system.CanonicalIdentifier(env.TargetID))
			if err != nil {
				return err
			}
			result := duplicate.Result
			response = ReportResponse{Data: protocol.EntityMutationData{Entity: entity, Report: &result}, Cursor: duplicate.Cursor}
			return nil
		}
		rep, err := extract(acceptance)
		if err != nil {
			return err
		}
		if err := rep.validate(acceptance); err != nil {
			return err
		}
		applied, samples, err := m.apply(ctx, tx, acceptance, rep)
		if err != nil {
			return err
		}
		result, entity, cursor, err := m.Finish(ctx, tx, acceptance, Effects{AppliedFields: applied, TaskEffect: "not_applicable", MovementSampleIDs: samples})
		if err != nil {
			return err
		}
		response = ReportResponse{Data: protocol.EntityMutationData{Entity: entity, Report: &result}, Cursor: cursor}
		return nil
	})
	if err == nil && cursor != "" {
		response.Cursor = cursor
	}
	return response, err
}

// CheckIn reports current Asset data, optionally establishing process
// authority atomically with the first report.
func (m *Module) CheckIn(ctx context.Context, principal identity.Principal, datasetID string, env Envelope, body protocol.CheckIn) (ReportResponse, error) {
	members, err := canonical.Members(env.Raw)
	if err != nil {
		return ReportResponse{}, err
	}
	if err := checkDerived(members, forbiddenTopLevel); err != nil {
		return ReportResponse{}, err
	}
	env.Context, env.Claim = body.ReportContext, body.AuthorityClaim
	return m.report(ctx, principal, datasetID, env, func(acceptance *Acceptance) (reported, error) {
		return reportedFrom(body.CommandManifest, body.Components, acceptance.Payload)
	})
}

// ReportStatus reports a complete Operational status record.
func (m *Module) ReportStatus(ctx context.Context, principal identity.Principal, datasetID string, env Envelope, body protocol.AssetStatusReportRequest) (ReportResponse, error) {
	env.Context = body.ReportContext
	return m.report(ctx, principal, datasetID, env, func(*Acceptance) (reported, error) {
		return reported{status: body.Status}, nil
	})
}

// Patch applies exactly one mutation class: a Descriptive edit or an Asset
// report.
func (m *Module) Patch(ctx context.Context, principal identity.Principal, datasetID string, env Envelope, body protocol.EntityPatch) (ReportResponse, error) {
	members, err := canonical.Members(env.Raw)
	if err != nil {
		return ReportResponse{}, err
	}
	if err := checkDerived(members, forbiddenTopLevel); err != nil {
		return ReportResponse{}, err
	}
	descriptive := present(members, "", descriptiveMembers)
	report := present(members, "", reportMembers)
	switch {
	case len(descriptive) > 0 && len(report) > 0:
		return ReportResponse{}, coreerr.Invalid("mixed_mutation_classes", "A patch carries exactly one mutation class").Paths(append(descriptive, report...)...)
	case len(descriptive) > 0:
		if principal.Kind != identity.Operator {
			return ReportResponse{}, forbiddenField(descriptive...)
		}
		return m.editDescriptive(ctx, principal, datasetID, env.TargetID, members, body)
	case len(report) > 0:
		if principal.Kind != identity.Asset {
			return ReportResponse{}, forbiddenField(report...)
		}
		if body.ReportContext == nil {
			return ReportResponse{}, invalidReport("Asset reports carry report_context", "/report_context")
		}
		env.Context = *body.ReportContext
		return m.report(ctx, principal, datasetID, env, func(acceptance *Acceptance) (reported, error) {
			return reportedFrom(body.CommandManifest, body.Components, acceptance.Payload)
		})
	default:
		return ReportResponse{}, coreerr.Invalid("invalid_request", "The patch names no mutable field")
	}
}

// editDescriptive applies an operator Descriptive edit under its edit
// revision precondition. It never touches Reported data or Contact.
func (m *Module) editDescriptive(ctx context.Context, principal identity.Principal, datasetID, id string, members map[string]json.RawMessage, body protocol.EntityPatch) (ReportResponse, error) {
	if body.ExpectedEditRevision == nil {
		return ReportResponse{}, coreerr.New(http.StatusPreconditionRequired, "precondition_required", "Descriptive edits carry expected_edit_revision").Paths("/expected_edit_revision")
	}
	var response ReportResponse
	cursor, err := m.store.Commit(ctx, datasetID, "entity.edit", func(tx *system.Tx) error {
		if err := identity.CheckActive(ctx, tx.SQL(), principal); err != nil {
			return err
		}
		rec, err := live(ctx, tx.SQL(), id)
		if err != nil {
			return err
		}
		if fmt.Sprint(rec.row.EditRevision) != *body.ExpectedEditRevision {
			return coreerr.Conflict("edit_conflict", "The Entity changed since the reviewed edit revision").With("current_edit_revision", fmt.Sprint(rec.row.EditRevision))
		}
		if _, ok := members["alias"]; ok {
			rec.row.Alias, rec.row.AliasKey = sql.NullString{}, sql.NullString{}
			if body.Alias.IsSpecified() && !body.Alias.IsNull() {
				alias := body.Alias.MustGet()
				if err := m.checkAlias(ctx, tx.SQL(), rec.row.EntityID, alias); err != nil {
					return err
				}
				rec.row.Alias = sql.NullString{String: alias, Valid: true}
				rec.row.AliasKey = sql.NullString{String: aliasKey(alias), Valid: true}
			}
		}
		if _, ok := members["subtype"]; ok {
			rec.row.Subtype = sql.NullString{}
			if body.Subtype.IsSpecified() && !body.Subtype.IsNull() {
				rec.row.Subtype = sql.NullString{String: body.Subtype.MustGet(), Valid: true}
			}
		}
		rec.row.EditRevision++
		entity, err := m.save(ctx, tx, &rec)
		response.Data = protocol.EntityMutationData{Entity: entity}
		return err
	})
	response.Cursor = cursor
	return response, err
}

func (m *Module) checkAlias(ctx context.Context, tx *sql.Tx, id, alias string) error {
	existing, err := storage.New(tx).GetEntityByAliasKey(ctx, sql.NullString{String: aliasKey(alias), Valid: true})
	if err == nil && existing.EntityID != id {
		return coreerr.Conflict("alias_conflict", "Another Entity uses this Alias, ignoring case").Paths("/alias")
	}
	if err != nil && err != sql.ErrNoRows {
		return fmt.Errorf("check Alias uniqueness: %w", err)
	}
	return nil
}
