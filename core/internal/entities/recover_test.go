package entities

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/google/uuid"

	"github.com/atlas-field-systems/atlas-core/core/internal/api"
	"github.com/atlas-field-systems/atlas-core/core/internal/changes"
	"github.com/atlas-field-systems/atlas-core/core/internal/datasets"
	"github.com/atlas-field-systems/atlas-core/core/internal/identity"
	"github.com/atlas-field-systems/atlas-core/core/internal/storage"
)

// Core can exit after the Entity commits but before the Asset credential is
// activated in installation storage. Startup must finish the enrollment so the
// Asset can authenticate without retrying.
func TestEnrollmentInterruptedBeforeActivationCompletesAtStartup(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	installation, err := storage.Open(ctx, filepath.Join(dir, "installation.sqlite"), storage.Installation)
	if err != nil {
		t.Fatal(err)
	}
	operational, err := storage.Open(ctx, filepath.Join(dir, "operational.sqlite"), storage.Operational)
	if err != nil {
		t.Fatal(err)
	}
	dataset, err := datasets.Open(ctx, operational, "test")
	if err != nil {
		t.Fatal(err)
	}
	identities := identity.New(installation)
	log := changes.New(operational, dataset.Current().ID, changes.DefaultRetention)
	service := New(operational, identities, dataset, log)
	credential, err := identity.NewCredential(identity.AssetPrefix)
	if err != nil {
		t.Fatal(err)
	}
	request := api.AssetEnrollmentRequest{DatasetId: dataset.Current().ID, Id: uuid.New(), RequestId: uuid.New(), Kind: api.AssetEnrollmentRequestKindAsset, Credential: credential}
	facts, err := factsDigest(request)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := identities.ReserveAsset(ctx, request.Id.String(), credential); err != nil {
		t.Fatal(err)
	}
	if err := service.createAsset(ctx, request, facts); err != nil {
		t.Fatal(err)
	}
	if _, err := identities.Authenticate(ctx, credential); err == nil {
		t.Fatal("an unactivated Asset credential authenticated")
	}

	if err := New(operational, identities, dataset, log).Recover(ctx); err != nil {
		t.Fatal(err)
	}
	caller, err := identities.Authenticate(ctx, credential)
	if err != nil {
		t.Fatal(err)
	}
	if caller.Kind != identity.Asset || caller.ID != request.Id.String() {
		t.Fatalf("recovered credential authenticated as %+v", caller)
	}
}
