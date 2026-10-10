package entities

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/atlas-field-systems/atlas-core/canonical"
	"github.com/atlas-field-systems/atlas-core/coreerr"
	"github.com/atlas-field-systems/atlas-core/entities/generated/storage"
	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/identity"
	"github.com/atlas-field-systems/atlas-core/system"
)

// RegistrationClaim is the retry identity kind for Asset registration.
const RegistrationClaim = "asset_registration"

// Registration is the result of Register.
type Registration struct {
	Data    protocol.RegistrationData
	Cursor  string
	Created bool
}

// registrationFacts are the canonical original registration facts compared on
// retry: Asset ID/type, principal association, Descriptive inputs, initial
// Command support after declared defaults, recovery key binding and the
// prepared credential verifier for first Enrollment.
type registrationFacts struct {
	AssetID            string                   `json:"asset_id"`
	Type               string                   `json:"type"`
	PrincipalID        string                   `json:"principal_id"`
	RecoveryPublicKey  string                   `json:"recovery_public_key"`
	CredentialVerifier string                   `json:"credential_verifier"`
	Alias              *string                  `json:"alias"`
	Subtype            *string                  `json:"subtype"`
	CommandManifest    protocol.CommandManifest `json:"command_manifest"`
}

// Register creates an Asset's Entity under its enrolled identity. First
// Enrollment, its provisioned credential and the Entity commit together; a
// matching retry returns the original association and current Entity.
// principal is nil when the caller presents enrollment authorization instead
// of a credential.
func (m *Module) Register(ctx context.Context, principal *identity.Principal, enrollment *identity.Enrollment, datasetID string, raw []byte, body protocol.EntityCreate) (Registration, error) {
	members, err := canonical.Members(raw)
	if err != nil {
		return Registration{}, err
	}
	if err := checkDerived(members, forbiddenDerived); err != nil {
		return Registration{}, err
	}
	if _, ok := members["components"]; ok {
		// Registration carries no Reported or Derived component; the first
		// check-in reports Operational status and telemetry.
		return Registration{}, forbiddenField("/components")
	}
	if (principal == nil) == (enrollment == nil) || (enrollment == nil) != (body.Enrollment == nil) {
		return Registration{}, coreerr.Unauthenticated("unauthenticated", "Registration presents either enrollment authorization with a prepared credential or the Asset's credential")
	}
	if enrollment != nil && enrollment.AssetID != system.CanonicalIdentifier(body.Id.String()) {
		return Registration{}, coreerr.Forbidden("enrollment_unauthorized", "The enrollment authorization names another Asset ID").Paths("/id")
	}
	if principal != nil && principal.Kind != identity.Asset {
		return Registration{}, coreerr.Forbidden("forbidden", "Only an enrolled Asset identity registers an Asset")
	}
	manifest := protocol.CommandManifest{}
	if body.CommandManifest != nil {
		manifest = *body.CommandManifest
	}
	if err := (reported{manifest: &manifest}).validate(&Acceptance{}); err != nil {
		return Registration{}, err
	}
	var result Registration
	cursor, err := m.store.Commit(ctx, datasetID, "entity.register", func(tx *system.Tx) error {
		now := system.FormatTime(tx.Now())
		assetID := system.CanonicalIdentifier(body.Id.String())
		var bound identity.Principal
		var recoveryKey, verifier string
		if principal == nil {
			var err error
			bound, recoveryKey, err = identity.Enroll(ctx, tx.SQL(), now, *enrollment, body.Enrollment.Credential)
			if err != nil {
				return err
			}
			verifier = identity.Verifier(body.Enrollment.Credential)
		} else {
			if err := identity.CheckActive(ctx, tx.SQL(), *principal); err != nil {
				return err
			}
			if principal.AssetID != assetID {
				return coreerr.Forbidden("forbidden", "The credential is bound to another Asset ID")
			}
			binding, exists, err := identity.AssetBinding(ctx, tx.SQL(), assetID)
			if err != nil {
				return err
			}
			if !exists || binding.Denied {
				return coreerr.Unauthenticated("credential_revoked", "The Asset identity is revoked")
			}
			bound, recoveryKey = *principal, binding.RecoveryPublicKey
		}
		facts := registrationFacts{AssetID: assetID, Type: string(body.Type), PrincipalID: bound.ID, RecoveryPublicKey: recoveryKey, CredentialVerifier: verifier, CommandManifest: manifest}
		if body.Alias.IsSpecified() && !body.Alias.IsNull() {
			alias := body.Alias.MustGet()
			facts.Alias = &alias
		}
		if body.Subtype.IsSpecified() && !body.Subtype.IsNull() {
			subtype := body.Subtype.MustGet()
			facts.Subtype = &subtype
		}
		encodedFacts, err := json.Marshal(facts)
		if err != nil {
			return fmt.Errorf("encode registration facts: %w", err)
		}
		canonicalFacts, err := canonical.Transform(encodedFacts)
		if err != nil {
			return err
		}
		claim, err := tx.Claim(RegistrationClaim, body.RegistrationId.String(), canonicalFacts)
		if err != nil {
			return err
		}
		switch claim.Outcome {
		case system.Conflict:
			return coreerr.Conflict("request_conflict", "The registration identity was already used with different facts")
		case system.Ended:
			return coreerr.Gone("entity_deleted", "The registered Asset was deleted; a replacement requires a new Asset ID")
		case system.Replay:
			var association protocol.Registration
			if err := json.Unmarshal(claim.Result, &association); err != nil {
				return fmt.Errorf("decode retained registration: %w", err)
			}
			entity, err := m.CurrentEntity(ctx, tx.SQL(), assetID)
			if err != nil {
				return err
			}
			result = Registration{Data: protocol.RegistrationData{Registration: association, Entity: entity}, Cursor: claim.Cursor}
			return nil
		}
		existing, exists, err := load(ctx, tx.SQL(), assetID)
		if err != nil {
			return err
		}
		if exists {
			if existing.row.DeletedAt.Valid {
				return coreerr.Gone("entity_deleted", "The Asset ID was deleted in this Dataset; a replacement requires a new Asset ID")
			}
			return coreerr.Conflict("entity_exists", "The Asset is already registered in this Dataset under another registration identity")
		}
		if facts.Alias != nil {
			if err := m.checkAlias(ctx, tx.SQL(), assetID, *facts.Alias); err != nil {
				return err
			}
		}
		seq, err := tx.Seq()
		if err != nil {
			return err
		}
		row := storage.InsertEntityParams{
			EntityID: assetID, EntityType: string(body.Type), Version: seq, EditRevision: 1, CreatedAt: now, UpdatedAt: now,
			CommandManifest: "[]", StatusValue: string(protocol.AssetStatusValueUnknown), CommunicationState: string(protocol.Offline), Reporting: "{}",
		}
		if facts.Alias != nil {
			row.Alias = sql.NullString{String: *facts.Alias, Valid: true}
			row.AliasKey = sql.NullString{String: aliasKey(*facts.Alias), Valid: true}
		}
		if facts.Subtype != nil {
			row.Subtype = sql.NullString{String: *facts.Subtype, Valid: true}
		}
		encodedManifest, err := json.Marshal(manifest)
		if err != nil {
			return fmt.Errorf("encode Command support: %w", err)
		}
		row.CommandManifest = string(encodedManifest)
		if err := storage.New(tx.SQL()).InsertEntity(ctx, row); err != nil {
			return fmt.Errorf("create Asset Entity: %w", err)
		}
		rec, err := m.mustLoad(ctx, tx.SQL(), assetID)
		if err != nil {
			return err
		}
		entity, err := m.image(ctx, tx.SQL(), rec)
		if err != nil {
			return err
		}
		if err := tx.Publish(ResourceKind, assetID, seq, entity); err != nil {
			return err
		}
		association := protocol.Registration{RegistrationId: body.RegistrationId, AssetId: body.Id, PrincipalId: mustIdentifier(bound.ID), RegisteredAt: tx.Now()}
		encodedAssociation, err := json.Marshal(association)
		if err != nil {
			return fmt.Errorf("encode registration association: %w", err)
		}
		if err := tx.Complete(RegistrationClaim, body.RegistrationId.String(), canonicalFacts, encodedAssociation, assetID); err != nil {
			return err
		}
		result = Registration{Data: protocol.RegistrationData{Registration: association, Entity: entity}, Created: true}
		return nil
	})
	if err == nil && cursor != "" {
		result.Cursor = cursor
	}
	return result, err
}

func (m *Module) mustLoad(ctx context.Context, tx *sql.Tx, id string) (record, error) {
	rec, exists, err := load(ctx, tx, id)
	if err == nil && !exists {
		err = fmt.Errorf("Entity %s vanished inside its commit", id)
	}
	return rec, err
}

// Delete removes an Entity when permitted. An Asset with nonterminal Tasks is
// not deleted; allowed Asset deletion revokes every bound credential, denies
// the retained binding and ends registration claims in the same commit.
func (m *Module) Delete(ctx context.Context, principal identity.Principal, datasetID, id string) (string, error) {
	return m.store.Commit(ctx, datasetID, "entity.delete", func(tx *system.Tx) error {
		if err := identity.CheckActive(ctx, tx.SQL(), principal); err != nil {
			return err
		}
		if principal.Kind != identity.Operator {
			return coreerr.Forbidden("forbidden", "Only operator clients delete Entities")
		}
		rec, err := live(ctx, tx.SQL(), id)
		if err != nil {
			return err
		}
		blocking, err := m.tasks.NonterminalTaskIDs(ctx, tx.SQL(), rec.row.EntityID)
		if err != nil {
			return err
		}
		if len(blocking) > 0 {
			return coreerr.Conflict("nonterminal_tasks", "The Asset has nonterminal Tasks; retirement remains available").With("task_ids", blocking)
		}
		seq, err := tx.Seq()
		if err != nil {
			return err
		}
		now := system.FormatTime(tx.Now())
		if err := storage.New(tx.SQL()).MarkEntityDeleted(ctx, storage.MarkEntityDeletedParams{
			DeletedAt: sql.NullString{String: now, Valid: true}, Version: seq, UpdatedAt: now, EntityID: rec.row.EntityID,
		}); err != nil {
			return fmt.Errorf("delete Entity: %w", err)
		}
		if err := identity.RevokeAsset(ctx, tx.SQL(), now, rec.row.EntityID, "asset_deleted"); err != nil {
			return err
		}
		if err := tx.EndClaims(RegistrationClaim, rec.row.EntityID); err != nil {
			return err
		}
		tx.PublishDeletion(ResourceKind, rec.row.EntityID, seq)
		return nil
	})
}
