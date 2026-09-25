package entities

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"github.com/atlas-field-systems/atlas-core/core/internal/api"
	"github.com/atlas-field-systems/atlas-core/core/internal/entities/internal/db"
	"github.com/atlas-field-systems/atlas-core/core/internal/identity"
	"github.com/atlas-field-systems/atlas-core/core/internal/problem"
	"github.com/atlas-field-systems/atlas-core/core/internal/storage"
)

var errRegistrationConflict = problem.Conflict("registration_conflict", "The registration identity or facts conflict.")

// Enrollment is the outcome of an enrollment request.
type Enrollment struct {
	Result api.AssetEnrollmentResult
	// Created is false when the request repeated an earlier enrollment.
	Created bool
}

// Enroll creates an Asset and binds its credential, or returns the current
// Asset for a retry with the same request ID and original facts.
//
// The binding and the Entity live in different databases, so enrollment runs
// in three idempotent steps: reserve the binding, commit the Entity, then
// activate the binding. A retry, or Recover at startup, completes an
// interrupted enrollment.
func (s *Service) Enroll(ctx context.Context, request api.AssetEnrollmentRequest) (Enrollment, error) {
	if err := s.datasets.RequireCurrent(request.DatasetId); err != nil {
		return Enrollment{}, err
	}
	if request.Components != nil {
		if err := checkPosition(request.Components.Telemetry); err != nil {
			return Enrollment{}, err
		}
	}
	facts, err := factsDigest(request)
	if err != nil {
		return Enrollment{}, err
	}
	if enrollment, found, err := s.retry(ctx, request, facts); found || err != nil {
		return enrollment, err
	}
	binding, err := s.identities.ReserveAsset(ctx, request.Id.String(), request.Credential)
	if err != nil {
		return Enrollment{}, err
	}
	err = s.createAsset(ctx, request, facts)
	if storage.IsConstraint(err) {
		return s.retryAfterConflict(ctx, request, facts)
	}
	if err != nil {
		return Enrollment{}, err
	}
	enrollment, err := s.activate(ctx, binding)
	enrollment.Created = true
	return enrollment, err
}

// retry completes an earlier enrollment with the same request ID, if any.
func (s *Service) retry(ctx context.Context, request api.AssetEnrollmentRequest, facts []byte) (Enrollment, bool, error) {
	registration, err := s.queries.GetRegistration(ctx, request.RequestId.String())
	if errors.Is(err, sql.ErrNoRows) {
		return Enrollment{}, false, nil
	}
	if err != nil {
		return Enrollment{}, true, fmt.Errorf("read registration %s: %w", request.RequestId, err)
	}
	if registration.AssetID != request.Id.String() || !bytes.Equal(registration.FactsDigest, facts) {
		return Enrollment{}, true, errRegistrationConflict
	}
	binding, err := s.identities.ReserveAsset(ctx, registration.AssetID, request.Credential)
	if err != nil {
		return Enrollment{}, true, err
	}
	enrollment, err := s.activate(ctx, binding)
	return enrollment, true, err
}

// retryAfterConflict resolves a constraint violation: either a concurrent
// identical request committed first, or the ID or alias is already taken.
func (s *Service) retryAfterConflict(ctx context.Context, request api.AssetEnrollmentRequest, facts []byte) (Enrollment, error) {
	enrollment, found, err := s.retry(ctx, request, facts)
	if !found && err == nil {
		return Enrollment{}, errRegistrationConflict
	}
	return enrollment, err
}

func (s *Service) activate(ctx context.Context, binding identity.AssetBinding) (Enrollment, error) {
	if err := s.identities.ActivateAsset(ctx, binding.AssetID); err != nil {
		return Enrollment{}, err
	}
	asset, err := s.Get(ctx, binding.AssetID)
	if err != nil {
		return Enrollment{}, err
	}
	principalID, err := uuid.Parse(binding.PrincipalID)
	if err != nil {
		return Enrollment{}, fmt.Errorf("stored principal ID: %w", err)
	}
	credentialID, err := uuid.Parse(binding.CredentialID)
	if err != nil {
		return Enrollment{}, fmt.Errorf("stored credential ID: %w", err)
	}
	return Enrollment{Result: api.AssetEnrollmentResult{Asset: asset, PrincipalId: principalID, CredentialId: credentialID}}, nil
}

func (s *Service) createAsset(ctx context.Context, request api.AssetEnrollmentRequest, facts []byte) error {
	params, err := newAssetParams(request)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	queries := s.queries.WithTx(tx)
	if err := queries.CreateAsset(ctx, params); err != nil {
		return fmt.Errorf("create Asset %s: %w", request.Id, err)
	}
	registration := db.CreateRegistrationParams{RequestID: request.RequestId.String(), AssetID: request.Id.String(), FactsDigest: facts}
	if err := queries.CreateRegistration(ctx, registration); err != nil {
		return fmt.Errorf("record registration %s: %w", request.RequestId, err)
	}
	return tx.Commit()
}

func newAssetParams(request api.AssetEnrollmentRequest) (db.CreateAssetParams, error) {
	manifest, err := json.Marshal(valueOr(request.CommandManifest, []api.CommandSupport{}))
	if err != nil {
		return db.CreateAssetParams{}, err
	}
	components := valueOr(request.Components, api.AssetInitialComponents{})
	telemetry := valueOr(components.Telemetry, api.AssetTelemetryComponent{})
	status := api.AssetStatusUnknown
	if components.Status != nil {
		status = components.Status.Value
	}
	return db.CreateAssetParams{
		ID:              request.Id.String(),
		Alias:           nullString(request.Alias),
		Subtype:         nullString(request.Subtype),
		Status:          string(status),
		Latitude:        nullFloat(telemetry.Latitude),
		Longitude:       nullFloat(telemetry.Longitude),
		AltitudeM:       nullFloat(telemetry.AltitudeM),
		SpeedMps:        nullFloat(telemetry.SpeedMps),
		HeadingDeg:      nullFloat(telemetry.HeadingDeg),
		BatteryPercent:  batteryPercent(components.Health),
		CommandManifest: string(manifest),
	}, nil
}

// factsDigest fingerprints the original enrollment facts. The credential is
// replaced by its verifier so the secret is never retained.
func factsDigest(request api.AssetEnrollmentRequest) ([]byte, error) {
	request.Credential = hex.EncodeToString(identity.Verifier(request.Credential))
	encoded, err := json.Marshal(request)
	if err != nil {
		return nil, fmt.Errorf("encode enrollment facts: %w", err)
	}
	digest := sha256.Sum256(encoded)
	return digest[:], nil
}
