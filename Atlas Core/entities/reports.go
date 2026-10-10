package entities

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/atlas-field-systems/atlas-core/corefacts"
	storage "github.com/atlas-field-systems/atlas-core/entities/generated/storage"
	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/identity"
	"github.com/atlas-field-systems/atlas-core/writecommit"
	"github.com/google/uuid"
	"github.com/oapi-codegen/nullable"
	"strconv"
	"time"
)

type Report struct {
	DatasetID, DatasetFact, ProtocolVersion, Kind, TargetID string
	Context                                                 protocol.ReportContext
	Raw                                                     []byte
	Authority                                               *protocol.AuthorityClaim
	Components                                              *protocol.ReportedComponents
	Manifest                                                *protocol.CommandManifest
}
type AcceptedReport struct {
	context              protocol.ReportContext
	generation, sequence uint64
	known                bool
	valid                bool
}

func (a AcceptedReport) Context() protocol.ReportContext { return a.context }
func (a AcceptedReport) Order() (uint64, uint64, bool)   { return a.generation, a.sequence, a.known }
func (a AcceptedReport) Valid() bool                     { return a.valid }

type Effect func(context.Context, *writecommit.Commit, AcceptedReport) (bool, error)

func ReportSigningFacts(raw []byte, kind, dataset, version, target string) ([]byte, error) {
	var body map[string]json.RawMessage
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, err
	}
	var context map[string]json.RawMessage
	if err := json.Unmarshal(body["report_context"], &context); err != nil {
		return nil, err
	}
	delete(context, "process_proof")
	delete(body, "report_context")
	delete(body, "authority_claim")
	return corefacts.Encode(struct {
		Kind            string                     `json:"kind"`
		DatasetID       string                     `json:"dataset_id"`
		ProtocolVersion string                     `json:"protocol_version"`
		TargetID        string                     `json:"target_id"`
		ReportContext   map[string]json.RawMessage `json:"report_context"`
		Payload         map[string]json.RawMessage `json:"payload"`
	}{kind, dataset, version, target, context, body})
}
func authorityFacts(raw []byte, dataset, asset, digest string) ([]byte, error) {
	var body struct {
		Claim map[string]json.RawMessage `json:"authority_claim"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, err
	}
	delete(body.Claim, "recovery_proof")
	for key, value := range map[string]string{"kind": "authority_transfer", "dataset_id": dataset, "asset_id": asset, "report_digest": digest} {
		encoded, err := json.Marshal(value)
		if err != nil {
			return nil, err
		}
		body.Claim[key] = encoded
	}
	return corefacts.Encode(body.Claim)
}
func originalReport(facts, raw []byte) ([]byte, error) {
	var body struct {
		Authority json.RawMessage `json:"authority_claim"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, err
	}
	return corefacts.Encode(struct {
		Facts     json.RawMessage `json:"facts"`
		Authority json.RawMessage `json:"authority_claim,omitempty"`
	}{facts, body.Authority})
}
func parseCounter(value string) (uint64, error) {
	n, err := strconv.ParseUint(value, 10, 64)
	if err != nil || n == 0 {
		return 0, ErrInvalid
	}
	return n, nil
}
func acceptedOrder(ctx protocol.ReportContext, current uint64) (AcceptedReport, error) {
	g, err := parseCounter(ctx.ProcessGeneration)
	if err != nil {
		return AcceptedReport{}, err
	}
	s, err := parseCounter(ctx.Sequence)
	if err != nil {
		return AcceptedReport{}, err
	}
	a := AcceptedReport{context: ctx, generation: g, sequence: s, known: true, valid: true}
	if ctx.EvidenceKind == "current" {
		if !ctx.EvidenceOrigin.IsNull() || !ctx.RetainedEvidenceId.IsNull() {
			return a, ErrInvalid
		}
		return a, nil
	}
	if ctx.EvidenceKind != "historical" {
		return a, ErrInvalid
	}
	if !ctx.EvidenceOrigin.IsNull() {
		if !ctx.RetainedEvidenceId.IsNull() {
			return a, ErrInvalid
		}
		origin, err := ctx.EvidenceOrigin.Get()
		if err != nil {
			return a, ErrInvalid
		}
		a.generation, err = parseCounter(origin.ProcessGeneration)
		if err != nil || a.generation > current {
			return a, ErrInvalid
		}
		a.sequence, err = parseCounter(origin.Sequence)
		if err != nil {
			return a, err
		}
		return a, nil
	}
	if ctx.RetainedEvidenceId.IsNull() {
		return a, ErrInvalid
	}
	a.known = false
	return a, nil
}
func (m *Module) ChallengeInside(ctx context.Context, c *writecommit.Commit, principal identity.Principal, asset, generation string) (value protocol.ContactChallenge, err error) {
	if principal.Kind != "asset" || principal.AssetID != asset {

		return value, identity.ErrForbidden
	}
	if err := m.identity.Authorize(ctx, c, principal); err != nil {

		return value, err
	}
	if _, err := m.read(ctx, c, asset); err != nil {

		return value, err
	}
	current := uint64(0)
	retained, err := storage.New(c.SQL).ReadGeneration(ctx, asset)
	if err == nil {
		current = uint64(retained.Generation)
	} else if !errors.Is(err, sql.ErrNoRows) {

		return value, err
	}
	candidate, err := parseCounter(generation)
	if err != nil || candidate != current && candidate != current+1 {

		return value, ErrGeneration
	}
	now := time.Now()
	value = protocol.ContactChallenge{Token: uuid.NewString(), AssetId: uuid.MustParse(asset), ProcessGeneration: generation, IssuedAt: now.UTC(), ExpiresAt: now.Add(m.freshness).UTC()}
	m.challengeMu.Lock()
	defer m.challengeMu.Unlock()
	for key, item := range m.challenges {
		if !now.Before(item.expires) {
			delete(m.challenges, key)
		}
	}
	if len(m.challenges) >= 4096 {

		return value, writecommit.ErrLimit
	}
	m.challenges[value.Token] = challenge{value, now, now.Add(m.freshness), c.Metadata.DatasetID}

	return value, nil
}
func (m *Module) fresh(report Report, now time.Time) bool {
	context := report.Context
	if context.EvidenceKind != "current" || context.ContactChallenge.IsNull() || context.GeneratedAt.IsNull() {
		return false
	}
	token, err := context.ContactChallenge.Get()
	if err != nil {
		return false
	}
	m.challengeMu.Lock()
	item, ok := m.challenges[token]
	m.challengeMu.Unlock()
	if !ok || item.dataset != report.DatasetID || item.value.AssetId != context.AssetId || item.value.ProcessGeneration != context.ProcessGeneration || !now.Before(item.expires) {
		return false
	}
	generated, err := time.Parse(time.RFC3339Nano, context.GeneratedAt.GetOrEmpty())
	if err != nil {
		return false
	}
	return !generated.Before(item.value.IssuedAt) && !generated.After(item.value.ExpiresAt)
}
func (m *Module) generation(ctx context.Context, c *writecommit.Commit, principal identity.Principal, report Report, facts []byte) (*protocol.AuthorityAssociation, error) {
	if principal.Kind != "asset" || principal.AssetID != report.Context.AssetId.String() {
		return nil, identity.ErrForbidden
	}
	if err := m.identity.Authorize(ctx, c, principal); err != nil {
		return nil, err
	}
	binding, err := m.identity.Binding(ctx, c, principal.AssetID)
	if err != nil {
		return nil, err
	}
	q := storage.New(c.SQL)
	current, err := q.ReadGeneration(ctx, principal.AssetID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	hasCurrent := err == nil
	claim := report.Authority
	if claim == nil {
		if !hasCurrent || strconv.FormatInt(current.Generation, 10) != report.Context.ProcessGeneration {
			return nil, ErrObsolete
		}
		if corefacts.Verify(current.PublicKey, report.Context.ProcessProof, facts) != nil {
			return nil, identity.ErrUnauthorized
		}
		return nil, nil
	}
	var source struct {
		Context struct {
			AssetID string `json:"asset_id"`
		} `json:"report_context"`
	}
	if err = json.Unmarshal(report.Raw, &source); err != nil {
		return nil, err
	}
	datasetFact := report.DatasetFact
	if datasetFact == "" {
		datasetFact = report.DatasetID
	}
	proofFacts, err := authorityFacts(report.Raw, datasetFact, source.Context.AssetID, corefacts.Digest(facts))
	if err != nil {
		return nil, err
	}
	if corefacts.Verify(binding.RecoveryPublicKey, claim.RecoveryProof, proofFacts) != nil || corefacts.Verify(claim.ProcessPublicKey, report.Context.ProcessProof, facts) != nil {
		return nil, identity.ErrUnauthorized
	}
	original, err := corefacts.Canonical(report.Raw)
	if err != nil {
		return nil, err
	}
	expected, err := strconv.ParseUint(claim.ExpectedGeneration, 10, 63)
	if err != nil {
		return nil, ErrGeneration
	}
	candidate := expected + 1
	if strconv.FormatUint(candidate, 10) != report.Context.ProcessGeneration {
		return nil, ErrGeneration
	}
	existing, err := q.ReadTransfer(ctx, claim.TransferId.String())
	if err == nil {
		if existing.Original != string(original) {
			return nil, ErrReportConflict
		}
		if !hasCurrent || current.Generation != existing.Generation || current.ProcessID != claim.ProcessId.String() {
			return nil, ErrObsolete
		}
		return &protocol.AuthorityAssociation{TransferId: claim.TransferId, ProcessId: claim.ProcessId, ProcessGeneration: report.Context.ProcessGeneration, ProcessPublicKey: claim.ProcessPublicKey}, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	currentGeneration := uint64(0)
	if hasCurrent {
		currentGeneration = uint64(current.Generation)
	}
	if currentGeneration != expected {
		return nil, ErrGeneration
	}
	if err = q.SaveGeneration(ctx, storage.SaveGenerationParams{AssetID: principal.AssetID, Generation: int64(candidate), ProcessID: claim.ProcessId.String(), PublicKey: claim.ProcessPublicKey}); err != nil {
		return nil, err
	}
	if err = q.PutTransfer(ctx, storage.PutTransferParams{TransferID: claim.TransferId.String(), AssetID: principal.AssetID, Generation: int64(candidate), Original: string(original)}); err != nil {
		return nil, err
	}
	c.Mutated = true
	return &protocol.AuthorityAssociation{TransferId: claim.TransferId, ProcessId: claim.ProcessId, ProcessGeneration: report.Context.ProcessGeneration, ProcessPublicKey: claim.ProcessPublicKey}, nil
}

// AcceptInside is the sole report acceptance gate. The accepted value cannot be
// constructed by collaborating modules; their effects share this transaction.
func (m *Module) AcceptInside(ctx context.Context, c *writecommit.Commit, principal identity.Principal, report Report, effect Effect) (value protocol.Asset, receipt protocol.ReportAcceptance, authority *protocol.AuthorityAssociation, err error) {
	if principal.Kind != "asset" || principal.AssetID != report.Context.AssetId.String() {
		err = identity.ErrForbidden
		return
	}
	if err = m.identity.Authorize(ctx, c, principal); err != nil {
		return
	}
	if report.Kind != "task_report" {
		target, e := uuid.Parse(report.TargetID)
		if e != nil || target != report.Context.AssetId {
			err = identity.ErrForbidden
			return
		}
	}
	if _, err = m.read(ctx, c, report.Context.AssetId.String()); err != nil {
		return
	}
	datasetFact := report.DatasetFact
	if datasetFact == "" {
		datasetFact = report.DatasetID
	}
	facts, e := ReportSigningFacts(report.Raw, report.Kind, datasetFact, report.ProtocolVersion, report.TargetID)
	if e != nil {
		err = e
		return
	}
	authority, err = m.generation(ctx, c, principal, report, facts)
	if err != nil {
		return
	}
	generation, e := parseCounter(report.Context.ProcessGeneration)
	if e != nil {
		err = e
		return
	}
	accepted, e := acceptedOrder(report.Context, generation)
	if e != nil {
		err = e
		return
	}
	original, e := originalReport(facts, report.Raw)
	if e != nil {
		err = e
		return
	}
	q := storage.New(c.SQL)
	key := storage.ReadReportParams{AssetID: report.Context.AssetId.String(), Generation: int64(generation), Sequence: report.Context.Sequence}
	previous, e := q.ReadReport(ctx, key)
	if e == nil {
		if previous.Original != string(original) {
			err = ErrReportConflict
			return
		}
		if err = json.Unmarshal([]byte(previous.Receipt), &receipt); err != nil {
			return
		}
		receipt.Disposition = "duplicate"
		receipt.ContactRefreshed = false
		receipt.AppliedFields = []string{}
		receipt.MovementSampleIds = []protocol.Identifier{}
		receipt.TaskEffect = "unchanged"
		if report.Kind != "task_report" {
			receipt.TaskEffect = "not_applicable"
		}
		value, err = m.ReadInside(ctx, c, report.Context.AssetId.String())
		return
	}
	if !errors.Is(e, sql.ErrNoRows) {
		err = e
		return
	}
	now := time.Now()
	receipt = protocol.ReportAcceptance{Disposition: "accepted", ReportId: protocol.ReportID{DatasetId: uuid.MustParse(c.Metadata.DatasetID), AssetId: report.Context.AssetId, ProcessGeneration: report.Context.ProcessGeneration, Sequence: report.Context.Sequence}, ReceivedAt: now.UTC(), AppliedFields: []string{}, MovementSampleIds: []protocol.Identifier{}, TaskEffect: "not_applicable"}
	if effect != nil {
		changed, e := effect(ctx, c, accepted)
		if e != nil {
			err = e
			return
		}
		receipt.TaskEffect = "unchanged"
		if changed {
			receipt.TaskEffect = "changed"
		}
	}
	value, err = m.read(ctx, c, report.Context.AssetId.String())
	if err != nil {
		return
	}
	changed := false
	if authority != nil {
		value.ProcessAuthority.Set(protocol.ProcessAuthority{ProcessGeneration: authority.ProcessGeneration, ProcessId: authority.ProcessId, ProcessPublicKey: authority.ProcessPublicKey})
		changed = true
	}
	if report.Components != nil || report.Manifest != nil {
		changed, e = m.applyComponents(ctx, c, &value, report, accepted, &receipt)
		if e != nil {
			err = e
			return
		}
		if authority != nil {
			changed = true
		}
	}
	if m.fresh(report, now) {
		value.Components.Heartbeat.LastSeen.Set(now.UTC())
		value.Components.Communications.State = "high_bandwidth"
		receipt.ContactRefreshed = true
		changed = true
	}
	if changed {
		if err = m.save(ctx, c, &value, true); err != nil {
			return
		}
	}
	encoded, e := json.Marshal(receipt)
	if e != nil {
		err = e
		return
	}
	err = q.PutReport(ctx, storage.PutReportParams{AssetID: key.AssetID, Generation: key.Generation, Sequence: key.Sequence, Original: string(original), Receipt: string(encoded)})
	c.Mutated = true
	return
}
func (m *Module) Report(ctx context.Context, principal identity.Principal, report Report) (value protocol.Asset, receipt protocol.ReportAcceptance, authority *protocol.AuthorityAssociation, cursor string, err error) {
	cursor, err = m.boundary.Apply(ctx, report.DatasetID, func(c *writecommit.Commit) error {
		var e error
		value, receipt, authority, e = m.AcceptInside(ctx, c, principal, report, nil)
		if e != nil {
			return e
		}
		if report.Kind == "status_report" {
			return c.CheckResponse(protocol.StatusReportResponse{DatasetId: uuid.MustParse(c.Metadata.DatasetID), Data: protocol.StatusReportResponseData{Entity: value, Status: value.Components.Status, Acceptance: receipt}, CommitCursor: c.Cursor()})
		}
		return c.CheckResponse(protocol.EntityReportResponse{DatasetId: uuid.MustParse(c.Metadata.DatasetID), Data: protocol.EntityReportResponseData{Entity: value, Acceptance: receipt, Authority: authority}, CommitCursor: c.Cursor()})
	})
	return
}
func newer(ctx context.Context, c *writecommit.Commit, id, unit string, accepted AcceptedReport) (bool, error) {
	if !accepted.known {
		return false, nil
	}
	q := storage.New(c.SQL)
	previous, err := q.ReadOrdering(ctx, storage.ReadOrderingParams{AssetID: id, Unit: unit})
	if err == nil {
		sequence, e := strconv.ParseUint(previous.Sequence, 10, 64)
		if e != nil {
			return false, e
		}
		if accepted.generation < uint64(previous.Generation) || accepted.generation == uint64(previous.Generation) && accepted.sequence <= sequence {
			return false, nil
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	return true, q.SaveOrdering(ctx, storage.SaveOrderingParams{AssetID: id, Unit: unit, Generation: int64(accepted.generation), Sequence: strconv.FormatUint(accepted.sequence, 10)})
}
func metadataFor(report Report, a AcceptedReport, received time.Time, observation *protocol.MovementObservationTime) protocol.ReportingMetadata {
	value := protocol.ReportingMetadata{ProcessGeneration: nullable.NewNullableWithValue(strconv.FormatUint(a.generation, 10)), Sequence: nullable.NewNullableWithValue(strconv.FormatUint(a.sequence, 10)), ReportedAt: report.Context.GeneratedAt, ReceivedAt: received, TimeQuality: "known"}
	if report.Context.GeneratedAt.IsNull() {
		value.TimeQuality = "unknown"
	}
	if observation != nil {
		value.ObservedAt = observation.ObservedAt
		value.ClockUncertaintyMs = observation.ClockUncertaintyMs
		if observation.ObservedAt.IsNull() {
			value.TimeQuality = "unknown"
		} else if observation.ClockUncertaintyMs.IsSpecified() && !observation.ClockUncertaintyMs.IsNull() {
			value.TimeQuality = "uncertain"
		}
	}
	return value
}
