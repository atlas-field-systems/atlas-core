// Package identity owns installation-retained principals, enrollment and revocation.
package identity

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/atlas-field-systems/atlas-core/corefacts"
	"github.com/atlas-field-systems/atlas-core/coremaintenance"
	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	storage "github.com/atlas-field-systems/atlas-core/identity/generated/storage"
	"github.com/atlas-field-systems/atlas-core/writecommit"
	"github.com/google/uuid"
	"strings"
)

//go:embed sql/schema.sql
var files embed.FS

func Schema() string { body, _ := files.ReadFile("sql/schema.sql"); return string(body) }

var ErrUnauthorized = errors.New("unauthorized")
var ErrForbidden = errors.New("forbidden_field")
var ErrRevoked = errors.New("credential_revoked")
var ErrEnrollment = errors.New("enrollment_refused")

type Principal struct{ ID, Kind, AssetID string }
type Binding struct {
	Principal         Principal
	RecoveryPublicKey string
	CredentialID      string
	OpenEnrollment    bool
}
type Module struct{}

func New() *Module { return &Module{} }
func (m *Module) Setup(ctx context.Context, c *writecommit.Commit, installation coremaintenance.Installation) error {
	q := storage.New(c.SQL)
	if err := q.PutCredential(ctx, storage.PutCredentialParams{Verifier: installation.AdminVerifier, PrincipalID: uuid.NewString(), Kind: "operator"}); err != nil {
		return err
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return err
	}
	return q.PutEnrollment(ctx, storage.PutEnrollmentParams{Verifier: installation.EnrollmentVerifier, PublicKey: installation.EnrollmentPublicKey, PageKey: base64.RawURLEncoding.EncodeToString(key)})
}

// CheckSetup confirms uncertain setup against retained verifier facts rather
// than accepting a newly prepared credential that was never installed.
func (m *Module) CheckSetup(ctx context.Context, c *writecommit.Commit, value coremaintenance.Installation) error {
	q := storage.New(c.SQL)
	credential, err := q.ReadCredential(ctx, value.AdminVerifier)
	if err != nil {
		return ErrEnrollment
	}
	if credential.Kind != "operator" || credential.Revoked != 0 {
		return ErrEnrollment
	}
	enrollment, err := q.ReadEnrollment(ctx)
	if err != nil {
		return err
	}
	if enrollment.PublicKey != value.EnrollmentPublicKey || enrollment.Verifier != value.EnrollmentVerifier {
		return ErrEnrollment
	}
	return nil
}

func AssetVerifier(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}
func (m *Module) Authenticate(ctx context.Context, c *writecommit.Commit, secret string) (Principal, error) {
	if secret == "" {
		return Principal{}, ErrUnauthorized
	}
	q := storage.New(c.SQL)
	value, err := q.ReadCredential(ctx, coremaintenance.Verifier(secret))
	if errors.Is(err, sql.ErrNoRows) {
		value, err = q.ReadCredential(ctx, AssetVerifier(secret))
	}
	if errors.Is(err, sql.ErrNoRows) {
		return Principal{}, ErrUnauthorized
	}
	if err != nil {
		return Principal{}, err
	}
	if value.Revoked != 0 {
		return Principal{}, ErrRevoked
	}
	return Principal{value.PrincipalID, value.Kind, value.AssetID}, nil
}
func (m *Module) Authorize(ctx context.Context, c *writecommit.Commit, principal Principal) error {
	q := storage.New(c.SQL)
	if principal.Kind == "asset" {
		value, err := q.ReadBinding(ctx, principal.AssetID)
		if err != nil {
			return ErrUnauthorized
		}
		if value.Revoked != 0 {
			return ErrRevoked
		}
		if value.PrincipalID != principal.ID {
			return ErrUnauthorized
		}
	}
	return nil
}

// Read authorizes the caller and captures the returned data's boundary in one
// SQLite transaction. Revocation cannot commit between these decisions.
func (m *Module) Read(ctx context.Context, boundary *writecommit.Boundary, dataset string, principal Principal, read func(*writecommit.Commit) error) (protocol.HTTPReadContext, error) {
	cursor, err := boundary.Apply(ctx, dataset, func(commit *writecommit.Commit) error {
		if err := m.Authorize(ctx, commit, principal); err != nil {
			return err
		}
		return read(commit)
	})
	if err != nil {
		return protocol.HTTPReadContext{}, err
	}
	return protocol.HTTPReadContext{Source: "http", CommitCursor: cursor}, nil
}
func (m *Module) Binding(ctx context.Context, c *writecommit.Commit, id string) (Binding, error) {
	value, err := storage.New(c.SQL).ReadBinding(ctx, id)
	if err != nil {
		return Binding{}, err
	}
	if value.Revoked != 0 {
		return Binding{}, ErrRevoked
	}
	return Binding{Principal{value.PrincipalID, "asset", value.AssetID}, value.RecoveryPublicKey, value.PrincipalID, value.OpenEnrollment != 0}, nil
}
func EnrollmentFacts(grant protocol.EnrollmentGrant) ([]byte, error) {
	return corefacts.Encode(struct {
		Kind               string `json:"kind"`
		InstallationID     string `json:"installation_id"`
		AuthorizationID    string `json:"authorization_id"`
		AssetID            string `json:"asset_id"`
		CredentialID       string `json:"credential_id"`
		CredentialVerifier string `json:"credential_verifier"`
		RecoveryPublicKey  string `json:"recovery_public_key"`
	}{"enrollment", grant.InstallationId.String(), grant.AuthorizationId.String(), grant.AssetId.String(), grant.CredentialId.String(), grant.CredentialVerifier, grant.RecoveryPublicKey})
}
func SignEnrollmentGrant(grant protocol.EnrollmentGrant, key ed25519.PrivateKey) (protocol.EnrollmentGrant, error) {
	facts, err := EnrollmentFacts(grant)
	if err != nil {
		return grant, err
	}
	grant.Proof = base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, facts))
	return grant, nil
}
func (m *Module) Enroll(ctx context.Context, c *writecommit.Commit, request protocol.RegisterAssetRequest, secret string, raw []byte, open bool) (Binding, error) {
	q := storage.New(c.SQL)
	id := request.Id.String()
	existing, err := q.ReadBinding(ctx, id)
	if err == nil {
		if existing.Revoked != 0 {
			return Binding{}, ErrRevoked
		}
		if existing.CredentialVerifier != AssetVerifier(secret) {
			return Binding{}, ErrUnauthorized
		}
		if request.Enrollment != nil {
			facts, err := OriginalEnrollmentFacts(raw)
			if err != nil {
				return Binding{}, err
			}
			if string(facts) != existing.Original {
				return Binding{}, ErrEnrollment
			}
		}
		return m.Binding(ctx, c, id)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Binding{}, err
	}
	grant := request.Enrollment
	if grant == nil || len(secret) < 24 || grant.AssetId != request.Id || grant.InstallationId.String() != c.Metadata.InstallationID || grant.CredentialVerifier != AssetVerifier(secret) {
		return Binding{}, ErrEnrollment
	}
	key, err := base64.RawURLEncoding.Strict().DecodeString(grant.RecoveryPublicKey)
	if err != nil || len(key) != ed25519.PublicKeySize {
		return Binding{}, ErrEnrollment
	}
	facts, err := OriginalEnrollmentFacts(raw)
	if err != nil {
		return Binding{}, err
	}
	enrollment, err := q.ReadEnrollment(ctx)
	if err != nil {
		return Binding{}, err
	}
	if !open {
		if enrollment.PublicKey == "" || corefacts.Verify(enrollment.PublicKey, grant.Proof, facts) != nil {
			return Binding{}, ErrEnrollment
		}
	}
	provenance := int64(0)
	if open {
		provenance = 1
	}
	principalID := grant.CredentialId.String()
	if err = q.PutBinding(ctx, storage.PutBindingParams{AssetID: id, PrincipalID: principalID, RecoveryPublicKey: grant.RecoveryPublicKey, CredentialVerifier: grant.CredentialVerifier, RegistrationID: request.RegistrationId.String(), Original: string(facts), OpenEnrollment: provenance}); err != nil {
		return Binding{}, err
	}
	if err = q.PutCredential(ctx, storage.PutCredentialParams{Verifier: grant.CredentialVerifier, PrincipalID: principalID, Kind: "asset", AssetID: id}); err != nil {
		return Binding{}, err
	}
	c.Mutated = true
	return m.Binding(ctx, c, id)
}
func (m *Module) Revoke(ctx context.Context, c *writecommit.Commit, id string) error {
	q := storage.New(c.SQL)
	if err := q.RevokeBinding(ctx, id); err != nil {
		return err
	}
	return q.RevokeCredentials(ctx, id)
}
func (m *Module) OpenCount(ctx context.Context, c *writecommit.Commit) (int64, error) {
	return storage.New(c.SQL).CountOpenIdentities(ctx)
}
func Secret(authorization, key string) string {
	if strings.HasPrefix(authorization, "Bearer ") {
		return strings.TrimPrefix(authorization, "Bearer ")
	}
	return key
}

func OriginalEnrollmentFacts(raw []byte) ([]byte, error) {
	var body struct {
		Enrollment map[string]json.RawMessage `json:"enrollment"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, err
	}
	delete(body.Enrollment, "proof")
	body.Enrollment["kind"] = json.RawMessage(`"enrollment"`)
	return corefacts.Encode(body.Enrollment)
}

// PageKey is installation-retained private cursor authority, never public credential material.
func (m *Module) PageKey(ctx context.Context, c *writecommit.Commit) ([]byte, error) {
	encoded, err := storage.New(c.SQL).ReadPageKey(ctx)
	if err != nil {
		return nil, err
	}
	key, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil || len(key) != 32 {
		return nil, writecommit.ErrIntegrity
	}
	return key, nil
}
