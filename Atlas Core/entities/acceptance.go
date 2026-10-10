package entities

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/atlas-field-systems/atlas-core/canonical"
	"github.com/atlas-field-systems/atlas-core/coreerr"
	"github.com/atlas-field-systems/atlas-core/entities/generated/storage"
	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/identity"
	"github.com/atlas-field-systems/atlas-core/system"
	"github.com/oapi-codegen/nullable"
)

// Report operations name the route kind in signed and compared facts.
const (
	OpCheckIn      = "checkin"
	OpEntityPatch  = "entity_patch"
	OpStatusReport = "status_report"
	OpTaskStatus   = "task_status"
)

// Envelope is one Asset-originated report as received. Raw is the original
// decompressed body, so signed facts keep accepted spellings.
type Envelope struct {
	Operation       string
	TargetID        string
	ProtocolVersion string
	Raw             []byte
	Context         protocol.ReportContext
	Claim           *protocol.AuthorityClaim
	ReceivedAt      time.Time
}

// Token orders reported facts within one affected state.
type Token struct{ Generation, Sequence int64 }

// After reports whether t is strictly newer than other.
func (t Token) After(other Token) bool {
	return t.Generation > other.Generation || (t.Generation == other.Generation && t.Sequence > other.Sequence)
}

// Acceptance is an accepted report value. Entities and Tasks apply an
// Asset-reported effect only when given this value.
type Acceptance struct {
	AssetID      string
	ID           Token
	Ordering     *Token
	EvidenceKey  string
	GeneratedAt  *time.Time
	ReceivedAt   time.Time
	Current      bool
	ContactFresh bool
	Context      protocol.ReportContext
	// Payload members and observation times are original JSON fragments.
	Payload          map[string]json.RawMessage
	ObservationTimes map[string]json.RawMessage
	UncertaintyMS    *float64

	entity        record
	entityChanged bool
	facts         []byte
	authority     *protocol.ProcessAuthority
}

// Duplicate is a matching retry of an accepted report.
type Duplicate struct {
	Result protocol.ReportResult
	Cursor string
}

var (
	errNotAsset         = coreerr.Forbidden("forbidden", "Only the bound Asset can submit its reports")
	errWrongPrincipal   = coreerr.Forbidden("forbidden", "The authenticated principal is not bound to the reported Asset")
	errAuthorityMissing = coreerr.Conflict("process_authority_required", "The Asset has no current process authority; establish it with an authority claim")
	errObsolete         = coreerr.Conflict("obsolete_process", "The report's process generation is no longer current")
	errProof            = coreerr.Forbidden("invalid_process_proof", "The process proof does not verify for the current process")
	errIdentityConflict = coreerr.Conflict("report_identity_conflict", "The report identity was already used with different facts")
)

func invalidEvidence(message, path string) *coreerr.Error {
	return coreerr.Invalid("invalid_evidence", message).Paths(path)
}

func invalidReport(message, path string) *coreerr.Error {
	return coreerr.Invalid("invalid_report", message).Paths(path)
}

func parseCounter(value, path string) (int64, error) {
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed <= 0 {
		return 0, invalidReport("Counter is outside the supported range", path)
	}
	return parsed, nil
}

// facts derives the signed and compared fact documents from original bytes.
type reportFacts struct {
	signed, compared []byte
	payload          map[string]json.RawMessage
	context          map[string]json.RawMessage
}

func buildFacts(env Envelope, datasetID string) (reportFacts, error) {
	members, err := canonical.Members(env.Raw)
	if err != nil {
		return reportFacts{}, err
	}
	contextMembers, err := canonical.Members(members["report_context"])
	if err != nil {
		return reportFacts{}, err
	}
	withoutProof, err := json.Marshal(canonical.Without(contextMembers, "process_proof"))
	if err != nil {
		return reportFacts{}, fmt.Errorf("encode report context facts: %w", err)
	}
	payload := canonical.Without(members, "report_context", "authority_claim")
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return reportFacts{}, fmt.Errorf("encode report payload facts: %w", err)
	}
	target := canonical.String(system.CanonicalIdentifier(env.TargetID))
	signed, err := canonical.Object(map[string]json.RawMessage{
		"atlas_signature":  canonical.String(canonical.ReportSignature),
		"dataset_id":       canonical.String(system.CanonicalIdentifier(datasetID)),
		"protocol_version": canonical.String(env.ProtocolVersion),
		"operation":        canonical.String(env.Operation),
		"target_id":        target,
		"report_context":   withoutProof,
		"payload":          payloadJSON,
	})
	if err != nil {
		return reportFacts{}, err
	}
	compared, err := canonical.Object(map[string]json.RawMessage{
		"operation": canonical.String(env.Operation), "target_id": target,
		"report_context": withoutProof, "payload": payloadJSON,
	})
	return reportFacts{signed: signed, compared: compared, payload: payload, context: contextMembers}, err
}

// Accept applies shared Asset report acceptance inside the route's commit:
// principal binding, process authority, proof, report identity, evidence and
// contact freshness. It returns either an Acceptance for new effects or a
// Duplicate. Rejections leave no acceptance identity or effects.
func (m *Module) Accept(ctx context.Context, tx *system.Tx, principal identity.Principal, env Envelope) (*Acceptance, *Duplicate, error) {
	if principal.Kind != identity.Asset {
		return nil, nil, errNotAsset
	}
	if err := identity.CheckActive(ctx, tx.SQL(), principal); err != nil {
		return nil, nil, err
	}
	assetID := system.CanonicalIdentifier(env.Context.AssetId.String())
	if assetID != system.CanonicalIdentifier(principal.AssetID) {
		return nil, nil, errWrongPrincipal
	}
	entity, err := live(ctx, tx.SQL(), assetID)
	if err != nil {
		return nil, nil, err
	}
	generation, err := parseCounter(env.Context.ProcessGeneration, "/report_context/process_generation")
	if err != nil {
		return nil, nil, err
	}
	sequence, err := parseCounter(env.Context.Sequence, "/report_context/sequence")
	if err != nil {
		return nil, nil, err
	}
	facts, err := buildFacts(env, tx.DatasetID())
	if err != nil {
		return nil, nil, err
	}
	queries := storage.New(tx.SQL())
	current, err := queries.CurrentGeneration(ctx, assetID)
	if err != nil {
		return nil, nil, fmt.Errorf("read current process generation: %w", err)
	}
	acceptance := &Acceptance{AssetID: assetID, ID: Token{generation, sequence}, ReceivedAt: env.ReceivedAt, Context: env.Context, Payload: facts.payload, entity: entity, facts: facts.compared}
	var processKey string
	if env.Claim != nil {
		key, authority, replay, err := m.claim(ctx, tx, assetID, current, generation, env, facts)
		if err != nil {
			return nil, nil, err
		}
		processKey, acceptance.authority = key, authority
		if !replay {
			current = generation
		}
	}
	if processKey == "" {
		switch {
		case current == 0:
			return nil, nil, errAuthorityMissing
		case generation < current:
			return nil, nil, errObsolete
		case generation > current:
			return nil, nil, invalidReport("The process generation was not issued", "/report_context/process_generation")
		}
		row, err := queries.GetGeneration(ctx, storage.GetGenerationParams{AssetID: assetID, Generation: current})
		if err != nil {
			return nil, nil, fmt.Errorf("read process authority: %w", err)
		}
		processKey = row.ProcessPublicKey
	}
	key, err := canonical.PublicKey(processKey)
	if err != nil {
		return nil, nil, fmt.Errorf("retained process key: %w", err)
	}
	if !canonical.Verify(key, facts.signed, env.Context.ProcessProof) {
		return nil, nil, errProof
	}
	existing, err := queries.GetAcceptedReport(ctx, storage.GetAcceptedReportParams{AssetID: assetID, Generation: generation, Sequence: sequence})
	switch {
	case err == nil:
		if !bytes.Equal([]byte(existing.Facts), facts.compared) {
			return nil, nil, errIdentityConflict
		}
		var result protocol.ReportResult
		if err := json.Unmarshal([]byte(existing.Result), &result); err != nil {
			return nil, nil, fmt.Errorf("decode retained acceptance receipt: %w", err)
		}
		result.Disposition = "duplicate"
		return nil, &Duplicate{Result: result, Cursor: existing.CommitCursor}, nil
	case !errors.Is(err, sql.ErrNoRows):
		return nil, nil, fmt.Errorf("read report identity: %w", err)
	}
	if err := m.evidence(ctx, tx.SQL(), acceptance, current, facts); err != nil {
		return nil, nil, err
	}
	if acceptance.Current && env.Context.ContactChallenge.IsSpecified() && !env.Context.ContactChallenge.IsNull() && acceptance.GeneratedAt != nil {
		challenge := env.Context.ContactChallenge.MustGet()
		acceptance.ContactFresh = m.challenges.fresh(challenge, tx.DatasetID(), assetID, generation, *acceptance.GeneratedAt, env.ReceivedAt)
	}
	return acceptance, nil, nil
}

// evidence validates the context's evidence identity and decides ordering.
func (m *Module) evidence(ctx context.Context, tx *sql.Tx, acceptance *Acceptance, current int64, facts reportFacts) error {
	context := acceptance.Context
	if context.GeneratedAt.IsSpecified() && !context.GeneratedAt.IsNull() {
		generated := context.GeneratedAt.MustGet()
		acceptance.GeneratedAt = &generated
	}
	if context.ClockUncertaintyMs.IsSpecified() && !context.ClockUncertaintyMs.IsNull() {
		uncertainty := context.ClockUncertaintyMs.MustGet()
		acceptance.UncertaintyMS = &uncertainty
	}
	if raw, ok := facts.context["observation_times"]; ok {
		if err := json.Unmarshal(raw, &acceptance.ObservationTimes); err != nil {
			return fmt.Errorf("decode validated observation times: %w", err)
		}
	}
	hasOrigin := context.EvidenceOrigin.IsSpecified() && !context.EvidenceOrigin.IsNull()
	hasRetained := context.RetainedEvidenceId.IsSpecified() && !context.RetainedEvidenceId.IsNull()
	switch context.EvidenceKind {
	case protocol.Current:
		if hasOrigin || hasRetained {
			return invalidEvidence("Current evidence has no original or retained identity", "/report_context/evidence_kind")
		}
		acceptance.Current = true
		ordering := acceptance.ID
		acceptance.Ordering = &ordering
		acceptance.EvidenceKey = fmt.Sprintf("g:%d:%d", ordering.Generation, ordering.Sequence)
	case protocol.Historical:
		switch {
		case hasOrigin == hasRetained:
			return invalidEvidence("Historical evidence carries exactly one of evidence_origin or retained_evidence_id", "/report_context/evidence_origin")
		case hasOrigin:
			origin := context.EvidenceOrigin.MustGet()
			generation, err := parseCounter(origin.ProcessGeneration, "/report_context/evidence_origin/process_generation")
			if err != nil {
				return err
			}
			sequence, err := parseCounter(origin.Sequence, "/report_context/evidence_origin/sequence")
			if err != nil {
				return err
			}
			if generation > current {
				return invalidEvidence("The original generation was not issued", "/report_context/evidence_origin/process_generation")
			}
			if _, err := storage.New(tx).GetGeneration(ctx, storage.GetGenerationParams{AssetID: acceptance.AssetID, Generation: generation}); err != nil {
				if errors.Is(err, sql.ErrNoRows) {
					return invalidEvidence("The original generation was not issued to this Asset in this Dataset", "/report_context/evidence_origin/process_generation")
				}
				return fmt.Errorf("read original process generation: %w", err)
			}
			ordering := Token{generation, sequence}
			acceptance.Ordering = &ordering
			acceptance.EvidenceKey = fmt.Sprintf("g:%d:%d", generation, sequence)
		default:
			acceptance.EvidenceKey = "r:" + system.CanonicalIdentifier(context.RetainedEvidenceId.MustGet().String())
		}
	default:
		return invalidEvidence("Unknown evidence kind", "/report_context/evidence_kind")
	}
	return nil
}

// claim handles a check-in's process-authority claim. A new claim must expect
// the current generation and is established atomically with the report; an
// identical retry of the current generation's winning claim replays.
func (m *Module) claim(ctx context.Context, tx *system.Tx, assetID string, current, generation int64, env Envelope, facts reportFacts) (string, *protocol.ProcessAuthority, bool, error) {
	if env.Operation != OpCheckIn {
		return "", nil, false, invalidReport("Authority claims travel only with check-in", "/authority_claim")
	}
	members, err := canonical.Members(env.Raw)
	if err != nil {
		return "", nil, false, err
	}
	claimRaw := members["authority_claim"]
	claimFacts, err := canonical.Transform(claimRaw)
	if err != nil {
		return "", nil, false, err
	}
	claim := env.Claim
	queries := storage.New(tx.SQL())
	authority := &protocol.ProcessAuthority{TransferId: claim.TransferId, ProcessId: claim.ProcessId}
	existing, err := queries.GenerationByTransfer(ctx, system.CanonicalIdentifier(claim.TransferId.String()))
	switch {
	case err == nil:
		if existing.AssetID != assetID || !bytes.Equal([]byte(existing.ClaimFacts), claimFacts) {
			return "", nil, false, coreerr.Conflict("transfer_identity_conflict", "The authority transfer identity was already used with different facts")
		}
		if existing.Generation != current {
			return "", nil, false, errObsolete
		}
		if generation != existing.Generation {
			return "", nil, false, invalidReport("A replayed claim's report uses its established generation", "/report_context/process_generation")
		}
		authority.ProcessGeneration = strconv.FormatInt(existing.Generation, 10)
		return existing.ProcessPublicKey, authority, true, nil
	case !errors.Is(err, sql.ErrNoRows):
		return "", nil, false, fmt.Errorf("read authority transfer: %w", err)
	}
	expected, err := strconv.ParseInt(claim.ExpectedGeneration, 10, 64)
	if err != nil {
		return "", nil, false, invalidReport("Expected generation is outside the supported range", "/authority_claim/expected_generation")
	}
	if expected != current {
		return "", nil, false, coreerr.Conflict("generation_conflict", "Another process authority is current; inspect the Asset and prepare a fresh claim").With("current_generation", strconv.FormatInt(current, 10))
	}
	if generation != expected+1 {
		return "", nil, false, invalidReport("A claim's first report uses the next generation", "/report_context/process_generation")
	}
	binding, exists, err := identity.AssetBinding(ctx, tx.SQL(), assetID)
	if err != nil {
		return "", nil, false, err
	}
	if !exists || binding.Denied {
		return "", nil, false, errWrongPrincipal
	}
	recoveryKey, err := canonical.PublicKey(binding.RecoveryPublicKey)
	if err != nil {
		return "", nil, false, fmt.Errorf("retained recovery key: %w", err)
	}
	claimMembers, err := canonical.Members(claimRaw)
	if err != nil {
		return "", nil, false, err
	}
	withoutProof, err := json.Marshal(canonical.Without(claimMembers, "recovery_proof"))
	if err != nil {
		return "", nil, false, fmt.Errorf("encode claim facts: %w", err)
	}
	recoveryFacts, err := canonical.Object(map[string]json.RawMessage{
		"atlas_signature": canonical.String(canonical.AuthorityClaimSignature),
		"dataset_id":      canonical.String(system.CanonicalIdentifier(tx.DatasetID())),
		"asset_id":        canonical.String(assetID),
		"claim":           withoutProof,
		"report_digest":   canonical.String(canonical.Digest(facts.signed)),
	})
	if err != nil {
		return "", nil, false, err
	}
	if !canonical.Verify(recoveryKey, recoveryFacts, claim.RecoveryProof) {
		return "", nil, false, coreerr.Forbidden("invalid_recovery_proof", "The authority claim is not authorized by the Asset's recovery authority")
	}
	if _, err := canonical.PublicKey(claim.ProcessPublicKey); err != nil {
		return "", nil, false, invalidReport("Process public key is not an Ed25519 key", "/authority_claim/process_public_key")
	}
	if err := queries.InsertGeneration(ctx, storage.InsertGenerationParams{
		AssetID: assetID, Generation: generation, TransferID: system.CanonicalIdentifier(claim.TransferId.String()),
		ProcessID: system.CanonicalIdentifier(claim.ProcessId.String()), ProcessPublicKey: claim.ProcessPublicKey,
		ClaimFacts: string(claimFacts), EstablishedAt: system.FormatTime(tx.Now()),
	}); err != nil {
		return "", nil, false, fmt.Errorf("establish process generation: %w", err)
	}
	authority.ProcessGeneration = strconv.FormatInt(generation, 10)
	return claim.ProcessPublicKey, authority, false, nil
}

// Effects are a route's applied facts for the acceptance receipt.
type Effects struct {
	AppliedFields     []string
	TaskEffect        string
	MovementSampleIDs []string
}

// Finish records the accepted report identity and its receipt, refreshes
// Contact only for fresh current evidence, and publishes the Entity change
// when its state changed, all in the route's commit.
func (m *Module) Finish(ctx context.Context, tx *system.Tx, acceptance *Acceptance, effects Effects) (protocol.ReportResult, protocol.Entity, string, error) {
	if acceptance.ContactFresh {
		acceptance.entity.row.LastSeen = storedTime(&acceptance.ReceivedAt)
		acceptance.entity.row.CommunicationState = string(protocol.HighBandwidth)
		acceptance.entityChanged = true
	}
	var entity protocol.Entity
	var err error
	if acceptance.entityChanged {
		entity, err = m.save(ctx, tx, &acceptance.entity)
	} else {
		entity, err = m.image(ctx, tx.SQL(), acceptance.entity)
	}
	if err != nil {
		return protocol.ReportResult{}, entity, "", err
	}
	seq, err := tx.Seq()
	if err != nil {
		return protocol.ReportResult{}, entity, "", err
	}
	cursor := system.Cursor(seq)
	if effects.AppliedFields == nil {
		effects.AppliedFields = []string{}
	}
	sampleIDs := make([]protocol.Identifier, 0, len(effects.MovementSampleIDs))
	for _, id := range effects.MovementSampleIDs {
		sampleIDs = append(sampleIDs, mustIdentifier(id))
	}
	result := protocol.ReportResult{
		Disposition: "accepted",
		ReportId: protocol.ReportID{
			DatasetId: mustIdentifier(tx.DatasetID()), AssetId: mustIdentifier(acceptance.AssetID),
			ProcessGeneration: strconv.FormatInt(acceptance.ID.Generation, 10), Sequence: strconv.FormatInt(acceptance.ID.Sequence, 10),
		},
		ReceivedAt:        acceptance.ReceivedAt.UTC(),
		AppliedFields:     effects.AppliedFields,
		TaskEffect:        protocol.ReportResultTaskEffect(effects.TaskEffect),
		MovementSampleIds: sampleIDs,
		ContactRefreshed:  acceptance.ContactFresh,
		Authority:         acceptance.authority,
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return result, entity, "", fmt.Errorf("encode acceptance receipt: %w", err)
	}
	if err := storage.New(tx.SQL()).InsertAcceptedReport(ctx, storage.InsertAcceptedReportParams{
		AssetID: acceptance.AssetID, Generation: acceptance.ID.Generation, Sequence: acceptance.ID.Sequence,
		Facts: string(acceptance.facts), Result: string(encoded), CommitCursor: cursor,
	}); err != nil {
		return result, entity, "", fmt.Errorf("record report identity: %w", err)
	}
	return result, entity, cursor, nil
}

// CurrentEntity returns the current image for a duplicate's response.
func (m *Module) CurrentEntity(ctx context.Context, tx *sql.Tx, assetID string) (protocol.Entity, error) {
	rec, err := live(ctx, tx, assetID)
	if err != nil {
		return protocol.Entity{}, err
	}
	return m.image(ctx, tx, rec)
}

// reportingUnit builds the Core-owned metadata for an applied unit.
func reportingUnit(acceptance *Acceptance, observation json.RawMessage, movement bool) protocol.ReportingUnit {
	unit := protocol.ReportingUnit{
		ProcessGeneration: strconv.FormatInt(acceptance.Ordering.Generation, 10),
		Sequence:          strconv.FormatInt(acceptance.Ordering.Sequence, 10),
		ReportedAt:        nullable.NewNullNullable[time.Time](),
		ReceivedAt:        acceptance.ReceivedAt.UTC(),
		TimeQuality:       protocol.TimeQualityKnown,
	}
	if acceptance.GeneratedAt != nil {
		unit.ReportedAt = nullable.NewNullableWithValue(*acceptance.GeneratedAt)
	}
	uncertainty := acceptance.UncertaintyMS
	relevantKnown := acceptance.GeneratedAt != nil
	if movement {
		unit.ObservedAt = nullable.NewNullNullable[time.Time]()
		relevantKnown = false
		uncertainty = nil
		if observation != nil {
			var timing protocol.MovementObservationTime
			if err := json.Unmarshal(observation, &timing); err == nil {
				if timing.ObservedAt.IsSpecified() && !timing.ObservedAt.IsNull() {
					unit.ObservedAt = nullable.NewNullableWithValue(timing.ObservedAt.MustGet())
					relevantKnown = true
				}
				if timing.ClockUncertaintyMs.IsSpecified() {
					unit.ClockUncertaintyMs = timing.ClockUncertaintyMs
					if !timing.ClockUncertaintyMs.IsNull() {
						value := timing.ClockUncertaintyMs.MustGet()
						uncertainty = &value
					}
				}
			}
		}
	} else if acceptance.UncertaintyMS != nil {
		unit.ClockUncertaintyMs = nullable.NewNullableWithValue(*acceptance.UncertaintyMS)
	}
	switch {
	case !relevantKnown:
		unit.TimeQuality = protocol.TimeQualityUnknown
	case uncertainty != nil && *uncertainty > 0:
		unit.TimeQuality = protocol.TimeQualityUncertain
	}
	return unit
}

// boundaryAdvance applies per-unit ordering: a fact applies only when its
// ordering token is newer than the unit's boundary, including removal
// tombstones. Unknown original ordering never replaces current values.
func boundaryAdvance(ctx context.Context, tx *sql.Tx, acceptance *Acceptance, unit string) (bool, error) {
	if acceptance.Ordering == nil {
		return false, nil
	}
	queries := storage.New(tx)
	boundary, err := queries.GetBoundary(ctx, storage.GetBoundaryParams{AssetID: acceptance.AssetID, Unit: unit})
	switch {
	case err == nil:
		if !acceptance.Ordering.After(Token{boundary.Generation, boundary.Sequence}) {
			return false, nil
		}
	case !errors.Is(err, sql.ErrNoRows):
		return false, fmt.Errorf("read %s ordering boundary: %w", unit, err)
	}
	if err := queries.PutBoundary(ctx, storage.PutBoundaryParams{AssetID: acceptance.AssetID, Unit: unit, Generation: acceptance.Ordering.Generation, Sequence: acceptance.Ordering.Sequence}); err != nil {
		return false, fmt.Errorf("advance %s ordering boundary: %w", unit, err)
	}
	return true, nil
}
