// Package identity owns authenticated principals, credential verifiers, Asset
// identity bindings and deployment enrollment authority. These facts are
// installation setup: Restart and ordinary Reset retain them, and revocation
// lasts until Hard Reset.
package identity

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/atlas-field-systems/atlas-core/canonical"
	"github.com/atlas-field-systems/atlas-core/coreerr"
	"github.com/atlas-field-systems/atlas-core/httpcontract"
	"github.com/atlas-field-systems/atlas-core/identity/generated/storage"
	"github.com/atlas-field-systems/atlas-core/system"
	"github.com/google/uuid"
)

//go:embed sql/installation.sql
var installationSchema string

//go:embed sql/dataset.sql
var datasetSchema string

// Kind is a principal kind. S1 implements operator clients and direct IP
// Assets; managed Plugin and gateway principals belong to later slices.
type Kind string

const (
	Operator Kind = "operator"
	Asset    Kind = "asset"
)

// Principal is an authenticated caller. AssetID is set for Asset principals.
type Principal struct {
	ID      string
	Kind    Kind
	AssetID string
}

// Actor is the activity attribution for this principal.
func (p Principal) Actor() system.Actor {
	return system.Actor{Kind: string(p.Kind), ID: p.ID, Display: string(p.Kind) + " " + p.ID}
}

// Module is the Identity and access module.
type Module struct {
	store *system.Store
}

// New constructs the module over Core's store.
func New(store *system.Store) *Module { return &Module{store: store} }

func (m *Module) Name() string                                { return "identity" }
func (m *Module) InstallationSchema() string                  { return installationSchema }
func (m *Module) DatasetSchema() string                       { return datasetSchema }
func (m *Module) DatasetTables() []string                     { return nil }
func (m *Module) OpenRetained(context.Context, *sql.Tx) error { return nil }

// Verifier is the stored verifier of a caller-prepared secret. Secrets carry
// at least 256 random bits, so a fast digest is a sufficient verifier.
func Verifier(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return canonical.Encode(sum[:])
}

// Setup records the first administrator credential and the deployment
// enrollment authority inside the installation setup transaction. A repeated
// setup with the same facts changes nothing; different facts conflict.
type Setup struct {
	AdminKeyName        string
	AdminSecret         string
	EnrollmentPublicKey string
}

// ErrSetupConflict reports retained setup facts that differ from the request.
var ErrSetupConflict = errors.New("setup_conflict")

// SetUp applies installation setup facts.
func SetUp(ctx context.Context, tx *sql.Tx, now string, setup Setup) error {
	if _, err := canonical.PublicKey(setup.EnrollmentPublicKey); err != nil {
		return fmt.Errorf("enrollment authority: %w", err)
	}
	queries := storage.New(tx)
	verifier := Verifier(setup.AdminSecret)
	existing, err := queries.OperatorCredentialByName(ctx, setup.AdminKeyName)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		principal := uuid.NewString()
		if err := queries.InsertPrincipal(ctx, storage.InsertPrincipalParams{PrincipalID: principal, Kind: string(Operator), Provenance: "local_setup", CreatedAt: now}); err != nil {
			return fmt.Errorf("record administrator principal: %w", err)
		}
		if err := queries.InsertCredential(ctx, storage.InsertCredentialParams{CredentialID: uuid.NewString(), PrincipalID: principal, Verifier: verifier, Name: setup.AdminKeyName, CreatedAt: now}); err != nil {
			return fmt.Errorf("record administrator credential verifier: %w", err)
		}
	case err != nil:
		return fmt.Errorf("read administrator credential: %w", err)
	case existing.Verifier != verifier:
		return fmt.Errorf("%w: administrator key %q already has a different secret", ErrSetupConflict, setup.AdminKeyName)
	}
	authority, err := queries.GetEnrollmentAuthority(ctx)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		if err := queries.InsertEnrollmentAuthority(ctx, storage.InsertEnrollmentAuthorityParams{PublicKey: setup.EnrollmentPublicKey, ConfiguredAt: now}); err != nil {
			return fmt.Errorf("record enrollment authority: %w", err)
		}
	case err != nil:
		return fmt.Errorf("read enrollment authority: %w", err)
	case authority.PublicKey != setup.EnrollmentPublicKey:
		return fmt.Errorf("%w: a different enrollment authority is configured", ErrSetupConflict)
	}
	return nil
}

var (
	errUnauthenticated = coreerr.Unauthenticated("unauthenticated", "A valid credential is required")
	errRevoked         = coreerr.Unauthenticated("credential_revoked", "The credential is revoked; replacement authority is required")
)

// Authenticate resolves a presented secret to its principal. Unknown and
// revoked credentials reveal nothing else.
func (m *Module) Authenticate(ctx context.Context, secret string) (Principal, error) {
	var principal Principal
	err := m.store.InstallationRead(ctx, func(tx *sql.Tx) error {
		var err error
		principal, err = resolve(ctx, tx, secret)
		return err
	})
	return principal, err
}

func resolve(ctx context.Context, tx *sql.Tx, secret string) (Principal, error) {
	row, err := storage.New(tx).CredentialByVerifier(ctx, Verifier(secret))
	if errors.Is(err, sql.ErrNoRows) {
		return Principal{}, errUnauthenticated
	}
	if err != nil {
		return Principal{}, fmt.Errorf("resolve credential: %w", err)
	}
	if row.RevokedAt.Valid || row.DeniedAt.Valid {
		return Principal{}, errRevoked
	}
	return Principal{ID: row.PrincipalID, Kind: Kind(row.Kind), AssetID: row.AssetID.String}, nil
}

// CheckActive rechecks a principal inside a write commit, serializing request
// authorization with revocation, deletion and denial.
func CheckActive(ctx context.Context, tx *sql.Tx, principal Principal) error {
	queries := storage.New(tx)
	count, err := queries.ActiveCredentialCount(ctx, principal.ID)
	if err != nil {
		return fmt.Errorf("recheck credential: %w", err)
	}
	if count == 0 {
		return errRevoked
	}
	if principal.Kind == Asset {
		binding, err := queries.BindingByPrincipal(ctx, principal.ID)
		if err != nil {
			return fmt.Errorf("recheck Asset binding: %w", err)
		}
		if binding.DeniedAt.Valid {
			return errRevoked
		}
	}
	return nil
}

// Binding is an installation-scoped Asset identity binding.
type Binding struct {
	AssetID           string
	PrincipalID       string
	RecoveryPublicKey string
	Denied            bool
}

// AssetBinding reads the binding for an Asset ID, if any.
func AssetBinding(ctx context.Context, tx *sql.Tx, assetID string) (Binding, bool, error) {
	row, err := storage.New(tx).GetBinding(ctx, system.CanonicalIdentifier(assetID))
	if errors.Is(err, sql.ErrNoRows) {
		return Binding{}, false, nil
	}
	if err != nil {
		return Binding{}, false, fmt.Errorf("read Asset binding: %w", err)
	}
	return Binding{AssetID: row.AssetID, PrincipalID: row.PrincipalID, RecoveryPublicKey: row.RecoveryPublicKey, Denied: row.DeniedAt.Valid}, true, nil
}

// Enrollment is verified deployment authorization for first Enrollment of
// one Asset ID with its recovery public key.
type Enrollment struct {
	AssetID           string
	RecoveryPublicKey string
}

type enrollmentAuthorization struct {
	InstallationID    string `json:"installation_id"`
	AssetID           string `json:"asset_id"`
	RecoveryPublicKey string `json:"recovery_public_key"`
	Signature         string `json:"signature"`
}

var errEnrollment = coreerr.Unauthenticated("enrollment_unauthorized", "Enrollment authorization is not valid for this installation")

// VerifyEnrollment authenticates an Atlas-Enrollment token: unpadded
// base64url of the canonical authorization, signed by the configured
// enrollment authority and naming this installation.
func (m *Module) VerifyEnrollment(ctx context.Context, token string) (Enrollment, error) {
	document, err := canonical.Decode(token)
	if err != nil || len(document) > 4096 || httpcontract.CheckJSONDocument(document) != nil {
		return Enrollment{}, errEnrollment
	}
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.DisallowUnknownFields()
	var authorization enrollmentAuthorization
	if err := decoder.Decode(&authorization); err != nil {
		return Enrollment{}, errEnrollment
	}
	if _, err := uuid.Parse(authorization.AssetID); err != nil || !system.SameIdentifier(authorization.InstallationID, m.store.InstallationID()) {
		return Enrollment{}, errEnrollment
	}
	if _, err := canonical.PublicKey(authorization.RecoveryPublicKey); err != nil {
		return Enrollment{}, errEnrollment
	}
	members, err := canonical.Members(document)
	if err != nil {
		return Enrollment{}, errEnrollment
	}
	facts := canonical.Without(members, "signature")
	facts["atlas_signature"] = canonical.String(canonical.EnrollmentSignature)
	signed, err := canonical.Object(facts)
	if err != nil {
		return Enrollment{}, errEnrollment
	}
	var authority string
	if err := m.store.InstallationRead(ctx, func(tx *sql.Tx) error {
		row, err := storage.New(tx).GetEnrollmentAuthority(ctx)
		authority = row.PublicKey
		return err
	}); err != nil {
		return Enrollment{}, fmt.Errorf("read enrollment authority: %w", err)
	}
	key, err := canonical.PublicKey(authority)
	if err != nil {
		return Enrollment{}, fmt.Errorf("retained enrollment authority: %w", err)
	}
	if !canonical.Verify(key, signed, authorization.Signature) {
		return Enrollment{}, errEnrollment
	}
	return Enrollment{AssetID: system.CanonicalIdentifier(authorization.AssetID), RecoveryPublicKey: authorization.RecoveryPublicKey}, nil
}

// Enroll provisions first Enrollment, or recognizes a retry by the same
// enrolled identity, inside the registration commit. It returns the bound
// principal and its recovery public key.
func Enroll(ctx context.Context, tx *sql.Tx, now string, enrollment Enrollment, credential string) (Principal, string, error) {
	queries := storage.New(tx)
	binding, exists, err := AssetBinding(ctx, tx, enrollment.AssetID)
	if err != nil {
		return Principal{}, "", err
	}
	if exists {
		// A matching retry presents the same recovery binding and a usable
		// credential of the bound principal; the request ID alone is not proof.
		if binding.Denied {
			return Principal{}, "", errRevoked
		}
		principal, err := resolve(ctx, tx, credential)
		if err != nil || binding.RecoveryPublicKey != enrollment.RecoveryPublicKey || principal.ID != binding.PrincipalID {
			return Principal{}, "", coreerr.Conflict("identity_conflict", "The Asset ID is bound to another enrolled identity")
		}
		return principal, binding.RecoveryPublicKey, nil
	}
	if _, err := queries.CredentialByVerifier(ctx, Verifier(credential)); err == nil {
		return Principal{}, "", coreerr.Conflict("credential_conflict", "The prepared credential is already in use")
	} else if !errors.Is(err, sql.ErrNoRows) {
		return Principal{}, "", fmt.Errorf("check prepared credential: %w", err)
	}
	principal := Principal{ID: uuid.NewString(), Kind: Asset, AssetID: enrollment.AssetID}
	if err := queries.InsertPrincipal(ctx, storage.InsertPrincipalParams{PrincipalID: principal.ID, Kind: string(Asset), Provenance: "deployment_enrollment", CreatedAt: now}); err != nil {
		return Principal{}, "", fmt.Errorf("record Asset principal: %w", err)
	}
	if err := queries.InsertBinding(ctx, storage.InsertBindingParams{AssetID: enrollment.AssetID, PrincipalID: principal.ID, RecoveryPublicKey: enrollment.RecoveryPublicKey, BoundAt: now}); err != nil {
		return Principal{}, "", fmt.Errorf("record Asset binding: %w", err)
	}
	if err := queries.InsertCredential(ctx, storage.InsertCredentialParams{CredentialID: uuid.NewString(), PrincipalID: principal.ID, Verifier: Verifier(credential), Name: "asset", CreatedAt: now}); err != nil {
		return Principal{}, "", fmt.Errorf("record Asset credential verifier: %w", err)
	}
	return principal, enrollment.RecoveryPublicKey, nil
}

// RevokeAsset revokes every credential bound to an Asset and denies its
// retained binding until Hard Reset. It runs inside the caller's commit.
func RevokeAsset(ctx context.Context, tx *sql.Tx, now, assetID, reason string) error {
	queries := storage.New(tx)
	binding, exists, err := AssetBinding(ctx, tx, assetID)
	if err != nil || !exists {
		return err
	}
	if _, err := queries.RevokePrincipalCredentials(ctx, storage.RevokePrincipalCredentialsParams{
		RevokedAt: sql.NullString{String: now, Valid: true}, RevocationReason: sql.NullString{String: reason, Valid: true}, PrincipalID: binding.PrincipalID,
	}); err != nil {
		return fmt.Errorf("revoke Asset credentials: %w", err)
	}
	if err := queries.DenyBinding(ctx, storage.DenyBindingParams{
		DeniedAt: sql.NullString{String: now, Valid: true}, DenialReason: sql.NullString{String: reason, Valid: true}, AssetID: binding.AssetID,
	}); err != nil {
		return fmt.Errorf("deny Asset binding: %w", err)
	}
	return nil
}
