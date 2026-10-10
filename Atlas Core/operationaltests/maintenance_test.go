package operationaltests_test

import (
	"context"
	"github.com/atlas-field-systems/atlas-core/coremaintenance"
	"github.com/atlas-field-systems/atlas-core/systemoperations"
	"github.com/google/uuid"
	"path/filepath"
	"testing"
)

func TestSetupRetainedOpeningAndResetEstablishment(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "core.sqlite")
	run := uuid.NewString()
	core, err := systemoperations.Open(ctx, systemoperations.Options{DatabasePath: path, RunID: run})
	if err != nil {
		t.Fatal(err)
	}
	setup := coremaintenance.Request{RunID: run, ActionID: uuid.NewString(), Kind: "setup", Installation: &coremaintenance.Installation{InstallationID: uuid.NewString(), AdminVerifier: coremaintenance.Verifier("prepared-admin-secret-with-enough-entropy"), EnrollmentVerifier: coremaintenance.Verifier("enrollment-secret-with-enough-entropy"), InitialConfig: coremaintenance.DefaultConfig()}}
	first, err := core.Maintain(ctx, setup)
	if err != nil {
		t.Fatal(err)
	}
	if first.DatasetID == "" || first.InstallationID != setup.Installation.InstallationID {
		t.Fatalf("invalid setup result %#v", first)
	}
	reset := coremaintenance.Request{RunID: run, ActionID: uuid.NewString(), Kind: "reset", ResetID: uuid.NewString(), ExpectedDatasetID: first.DatasetID}
	replacement, err := core.Maintain(ctx, reset)
	if err != nil {
		t.Fatal(err)
	}
	if replacement.DatasetID == first.DatasetID || replacement.LastEstablishedResetID != reset.ResetID {
		t.Fatal("Reset did not establish one replacement Dataset")
	}
	replay, err := core.Maintain(ctx, reset)
	if err != nil {
		t.Fatal(err)
	}
	if replay.DatasetID != replacement.DatasetID || !replay.AlreadyApplied {
		t.Fatal("uncertain Reset replay cleared another Dataset")
	}
	if err = core.Close(); err != nil {
		t.Fatal(err)
	}
	run2 := uuid.NewString()
	core, err = systemoperations.Open(ctx, systemoperations.Options{DatabasePath: path, RunID: run2})
	if err != nil {
		t.Fatal(err)
	}
	defer core.Close()
	retained, err := core.Maintain(ctx, coremaintenance.Request{RunID: run2, ActionID: uuid.NewString(), Kind: "inspect"})
	if err != nil {
		t.Fatal(err)
	}
	if retained.DatasetID != replacement.DatasetID || retained.LastEstablishedResetID != reset.ResetID || retained.InstallationID != first.InstallationID {
		t.Fatal("retained open lost setup or Reset establishment")
	}
}

func TestSetupReplayVerifiesInstalledMaterial(t *testing.T) {
	ctx := context.Background()
	runID := uuid.NewString()
	core, err := systemoperations.Open(ctx, systemoperations.Options{DatabasePath: filepath.Join(t.TempDir(), "core.sqlite"), RunID: runID})
	if err != nil {
		t.Fatal(err)
	}
	defer core.Close()
	request := coremaintenance.Request{RunID: runID, ActionID: uuid.NewString(), Kind: "setup", Installation: &coremaintenance.Installation{InstallationID: uuid.NewString(), AdminVerifier: coremaintenance.Verifier("prepared-first-administrator"), EnrollmentVerifier: coremaintenance.Verifier("retained-enrollment-verifier"), InitialConfig: coremaintenance.DefaultConfig()}}
	first, err := core.Maintain(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := core.Maintain(ctx, request)
	if err != nil || !replay.AlreadyApplied || replay.DatasetID != first.DatasetID {
		t.Fatalf("retained setup replay %#v %v", replay, err)
	}
	request.Installation.AdminVerifier = coremaintenance.Verifier("differently-prepared-administrator")
	if _, err = core.Maintain(ctx, request); err == nil {
		t.Fatal("setup replay accepted a credential that was never installed")
	}
	request.Installation.AdminVerifier = coremaintenance.Verifier("prepared-first-administrator")
	request.Installation.InitialConfig.MaxJSONBytes = 2 * 1024 * 1024
	if _, err = core.Maintain(ctx, request); err == nil {
		t.Fatal("setup replay silently replaced retained configuration")
	}
	inspected, err := core.Maintain(ctx, coremaintenance.Request{RunID: runID, ActionID: uuid.NewString(), Kind: "inspect"})
	if err != nil || inspected.DatasetID != first.DatasetID || inspected.Config.MaxJSONBytes != first.Config.MaxJSONBytes {
		t.Fatal("refused setup changed retained facts")
	}
}
