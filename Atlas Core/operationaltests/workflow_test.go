package operationaltests_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/atlas-field-systems/atlas-core/corefacts"
	"github.com/atlas-field-systems/atlas-core/coremaintenance"
	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/identity"
	"github.com/atlas-field-systems/atlas-core/systemoperations"
	"github.com/google/uuid"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

type fixture struct {
	t                                 *testing.T
	core                              *systemoperations.Core
	server                            *httptest.Server
	client                            *http.Client
	dataset, installation, admin, run string
	enrollment                        ed25519.PrivateKey
	path                              string
}

func newFixture(t *testing.T, options systemoperations.Options) *fixture {
	return newConfiguredFixture(t, options, coremaintenance.DefaultConfig())
}
func newConfiguredFixture(t *testing.T, options systemoperations.Options, initialConfig coremaintenance.Config) *fixture {
	t.Helper()
	path := filepath.Join(t.TempDir(), "core.sqlite")
	run := uuid.NewString()
	options.DatabasePath = path
	options.RunID = run
	core, err := systemoperations.Open(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	install := uuid.NewString()
	admin := "independently-prepared-admin-credential-0001"
	setup, err := core.Maintain(context.Background(), coremaintenance.Request{ActionID: uuid.NewString(), RunID: run, Kind: "setup", Installation: &coremaintenance.Installation{InstallationID: install, AdminVerifier: coremaintenance.Verifier(admin), EnrollmentPublicKey: base64.RawURLEncoding.EncodeToString(pub), InitialConfig: initialConfig}})
	if err != nil {
		t.Fatal(err)
	}
	handler, err := core.Handler(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewTLSServer(handler)
	f := &fixture{t, core, server, server.Client(), setup.DatasetID, install, admin, run, key, path}
	t.Cleanup(func() {
		f.server.Close()
		if err := f.core.Close(); err != nil {
			t.Error(err)
		}
	})
	return f
}
func (f *fixture) request(method, path, secret string, body interface{}, want int) []byte {
	f.t.Helper()
	var encoded []byte
	var err error
	if body != nil {
		encoded, err = json.Marshal(body)
		if err != nil {
			f.t.Fatal(err)
		}
	}
	request, err := http.NewRequest(method, f.server.URL+path, bytes.NewReader(encoded))
	if err != nil {
		f.t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+secret)
	request.Header.Set("Atlas-Dataset-ID", f.dataset)
	request.Header.Set("Atlas-Protocol-Version", "0.1.0")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := f.client.Do(request)
	if err != nil {
		f.t.Fatal(err)
	}
	defer response.Body.Close()
	result, err := io.ReadAll(response.Body)
	if err != nil {
		f.t.Fatal(err)
	}
	if response.StatusCode != want {
		f.t.Fatalf("%s %s expected %d, got %d: %s", method, path, want, response.StatusCode, result)
	}
	if response.Header.Get("Atlas-Dataset-ID") != f.dataset || response.Header.Get("Atlas-Protocol-Version") != "0.1.0" {
		f.t.Fatal("missing response context")
	}
	return result
}
func decode[T interface{}](t *testing.T, body []byte) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(body, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

type asset struct {
	id, secret            string
	recovery, process     ed25519.PrivateKey
	generation, challenge string
}

func (f *fixture) prepareRegistration() (*asset, map[string]interface{}) {
	f.t.Helper()
	recoveryPub, recovery, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		f.t.Fatal(err)
	}
	_, process, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		f.t.Fatal(err)
	}
	a := &asset{id: uuid.NewString(), secret: uuid.NewString() + uuid.NewString(), recovery: recovery, process: process, generation: "1"}
	grant := map[string]interface{}{"installation_id": f.installation, "authorization_id": uuid.NewString(), "asset_id": a.id, "credential_id": uuid.NewString(), "credential_verifier": identity.AssetVerifier(a.secret), "recovery_public_key": base64.RawURLEncoding.EncodeToString(recoveryPub)}
	facts := map[string]interface{}{"kind": "enrollment"}
	for key, value := range grant {
		facts[key] = value
	}
	canonical, err := corefacts.Encode(facts)
	if err != nil {
		f.t.Fatal(err)
	}
	grant["proof"] = base64.RawURLEncoding.EncodeToString(ed25519.Sign(f.enrollment, canonical))
	request := map[string]interface{}{"id": a.id, "type": "asset", "registration_id": uuid.NewString(), "command_manifest": []interface{}{map[string]interface{}{"command": "move_to", "scheduling": []string{"queued"}, "cancellation": true, "progress": true}}, "enrollment": grant}
	return a, request
}

func (f *fixture) register() (*asset, protocol.RegistrationResponse) {
	a, request := f.prepareRegistration()
	body := f.request("POST", "/entities", a.secret, request, 201)
	return a, decode[protocol.RegistrationResponse](f.t, body)
}
func (f *fixture) reportBody(a *asset, kind, target, sequence string, payload map[string]interface{}, claim bool, evidenceKind string, origin interface{}, retained interface{}, generated interface{}) map[string]interface{} {
	f.t.Helper()
	context := map[string]interface{}{"asset_id": a.id, "process_generation": a.generation, "sequence": sequence, "generated_at": generated, "evidence_kind": evidenceKind, "evidence_origin": origin, "retained_evidence_id": retained, "contact_challenge": a.challenge}
	if a.challenge == "" {
		context["contact_challenge"] = nil
	}
	facts := map[string]interface{}{"kind": kind, "dataset_id": f.dataset, "protocol_version": "0.1.0", "target_id": target, "report_context": context, "payload": payload}
	canonical, err := corefacts.Encode(facts)
	if err != nil {
		f.t.Fatal(err)
	}
	proof := base64.RawURLEncoding.EncodeToString(ed25519.Sign(a.process, canonical))
	body := map[string]interface{}{}
	for key, value := range payload {
		body[key] = value
	}
	context["process_proof"] = proof
	body["report_context"] = context
	if claim {
		processPub := a.process.Public().(ed25519.PublicKey)
		transfer := uuid.NewString()
		processID := uuid.NewString()
		authority := map[string]interface{}{"transfer_id": transfer, "process_id": processID, "expected_generation": "0", "process_public_key": base64.RawURLEncoding.EncodeToString(processPub)}
		authorityFacts := map[string]interface{}{"kind": "authority_transfer", "dataset_id": f.dataset, "asset_id": a.id, "report_digest": corefacts.Digest(canonical)}
		for key, value := range authority {
			authorityFacts[key] = value
		}
		encoded, err := corefacts.Encode(authorityFacts)
		if err != nil {
			f.t.Fatal(err)
		}
		authority["recovery_proof"] = base64.RawURLEncoding.EncodeToString(ed25519.Sign(a.recovery, encoded))
		body["authority_claim"] = authority
	}
	return body
}
func (f *fixture) checkin(a *asset) protocol.EntityReportResponse {
	health := decode[protocol.HealthResponse](f.t, f.request("GET", "/health?asset_id="+a.id+"&process_generation=1", a.secret, nil, 200))
	a.challenge = health.Data.ContactChallenge.Token
	body := f.reportBody(a, "checkin", a.id, "1", map[string]interface{}{"components": map[string]interface{}{"status": map[string]interface{}{"value": "ready"}}}, true, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	return decode[protocol.EntityReportResponse](f.t, f.request("POST", "/entities/"+a.id+"/checkin", a.secret, body, 200))
}
func (f *fixture) create(a *asset) protocol.Task {
	request := map[string]interface{}{"asset_id": a.id, "idempotency_key": uuid.NewString(), "command": "move_to", "input": map[string]interface{}{"target": map[string]interface{}{"kind": "position", "position": map[string]float64{"latitude": 10, "longitude": 20}}}}
	response := decode[protocol.TaskMutationResponse](f.t, f.request("POST", "/tasks", f.admin, request, 201))
	return response.Data
}
func TestRealHTTPSQueuedMoveToRecordsIndependentAssetOutcomes(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, registered := f.register()
	if registered.Data.Entity.Components.Status.Value != "unknown" || registered.Data.Entity.Components.Communications.State != "offline" || !registered.Data.Entity.Components.Heartbeat.LastSeen.IsNull() || registered.Data.Entity.Components.Telemetry != nil || len(registered.Data.Entity.Reporting) != 0 || !registered.Data.Entity.ProcessAuthority.IsNull() {
		t.Fatal("registration invented report state")
	}
	first := f.create(a)
	second := f.create(a)
	assigned := decode[protocol.AssignedTaskPageResponse](t, f.request("GET", "/entities/"+a.id+"/tasks", a.secret, nil, 200))
	if len(assigned.Data.Items) != 2 || assigned.Data.Items[0].Id != first.Id || assigned.Data.Items[1].Id != second.Id || !assigned.Data.TaskQueue.ConfirmedRevision.IsNull() {
		t.Fatal("offline issuance or requested order incorrect")
	}
	ready := f.checkin(a)
	if !ready.Data.Acceptance.ContactRefreshed || ready.Data.Entity.Components.Status.Value != "ready" {
		t.Fatal("first current authority check-in failed")
	}
	execution := uuid.NewString()
	start := f.reportBody(a, "task_report", first.Id.String(), "2", map[string]interface{}{"kind": "report", "status": "in_progress", "execution_id": execution, "progress": map[string]float64{"distance_remaining_m": 5.1}}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	progress := decode[protocol.TaskReportResponse](t, f.request("PATCH", "/tasks/"+first.Id.String()+"/status", a.secret, start, 200))
	if progress.Data.Task.Status != "in_progress" {
		t.Fatal("Core inferred arrival from progress")
	}
	completion := f.reportBody(a, "task_report", first.Id.String(), "3", map[string]interface{}{"kind": "report", "status": "completed", "execution_id": execution, "progress": map[string]float64{"distance_remaining_m": 4.9}}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	finished := decode[protocol.TaskReportResponse](t, f.request("PATCH", "/tasks/"+first.Id.String()+"/status", a.secret, completion, 200))
	if finished.Data.Task.Status != "completed" || finished.Data.Acceptance.TaskEffect != "changed" {
		t.Fatal("valid Asset completion not recorded")
	}
	duplicate := decode[protocol.TaskReportResponse](t, f.request("PATCH", "/tasks/"+first.Id.String()+"/status", a.secret, completion, 200))
	if duplicate.Data.Acceptance.Disposition != "duplicate" || duplicate.Data.Acceptance.ContactRefreshed {
		t.Fatal("duplicate report repeated effect")
	}
}

func (f *fixture) restart(options systemoperations.Options) {
	f.t.Helper()
	f.server.Close()
	if err := f.core.Close(); err != nil {
		f.t.Fatal(err)
	}
	f.run = uuid.NewString()
	options.DatabasePath = f.path
	options.RunID = f.run
	core, err := systemoperations.Open(context.Background(), options)
	if err != nil {
		f.t.Fatal(err)
	}
	handler, err := core.Handler(context.Background())
	if err != nil {
		f.t.Fatal(err)
	}
	f.core = core
	f.server = httptest.NewTLSServer(handler)
	f.client = f.server.Client()
}

func TestSparseTelemetryOrderingHistoryAndImmutableOriginalTimes(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, _ := f.register()
	f.checkin(a)
	original := "2026-10-10T10:00:00.500+00:00"
	position := f.reportBody(a, "entity_report", a.id, "10", map[string]interface{}{"components": map[string]interface{}{"telemetry": map[string]interface{}{"position": map[string]float64{"latitude": 10, "longitude": 20}}}}, false, "historical", map[string]string{"process_generation": "1", "sequence": "10"}, nil, original)
	positionContext := position["report_context"].(map[string]interface{})
	positionContext["observation_times"] = map[string]interface{}{"position": map[string]interface{}{"observed_at": original}}
	delete(positionContext, "process_proof")
	facts, err := corefacts.Encode(map[string]interface{}{"kind": "entity_report", "dataset_id": f.dataset, "protocol_version": "0.1.0", "target_id": a.id, "report_context": positionContext, "payload": map[string]interface{}{"components": position["components"]}})
	if err != nil {
		t.Fatal(err)
	}
	positionContext["process_proof"] = base64.RawURLEncoding.EncodeToString(ed25519.Sign(a.process, facts))
	reported := decode[protocol.EntityReportResponse](t, f.request("PATCH", "/entities/"+a.id, a.secret, position, 200))
	if reported.Data.Acceptance.ContactRefreshed || len(reported.Data.Acceptance.MovementSampleIds) != 1 {
		t.Fatal("historical evidence Contact or sample mismatch")
	}
	heading := f.reportBody(a, "entity_report", a.id, "20", map[string]interface{}{"components": map[string]interface{}{"telemetry": map[string]float64{"heading_deg": 90}}}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	result := decode[protocol.EntityReportResponse](t, f.request("PATCH", "/entities/"+a.id, a.secret, heading, 200))
	metadata := result.Data.Entity.Reporting["telemetry.position"]
	if metadata.ObservedAt.GetOrEmpty() != original || metadata.Sequence.GetOrEmpty() != "10" || len(result.Data.Acceptance.MovementSampleIds) != 0 {
		t.Fatal("heading refreshed original position age or created sample")
	}
	history := decode[protocol.MovementPageResponse](t, f.request("GET", "/entities/"+a.id+"/movement-history?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z&time_basis=observed_at", f.admin, nil, 200))
	if len(history.Data.Items) != 1 || history.Data.Items[0].Quantities.Position.ObservedAt.GetOrEmpty() != original {
		t.Fatal("movement history lost original observation time")
	}
	duplicate := decode[protocol.EntityReportResponse](t, f.request("PATCH", "/entities/"+a.id, a.secret, position, 200))
	if duplicate.Data.Acceptance.Disposition != "duplicate" {
		t.Fatal("expected shared report duplicate")
	}
	f.restart(systemoperations.Options{})
	retry := decode[protocol.EntityReportResponse](t, f.request("PATCH", "/entities/"+a.id, a.secret, position, 200))
	if retry.Data.Acceptance.Disposition != "duplicate" || retry.Data.Acceptance.ContactRefreshed {
		t.Fatal("Restart lost accepted report identity")
	}
}

func TestCancellationRecordsIntentThenAssignedAssetConfirmation(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, _ := f.register()
	task := f.create(a)
	cancelID := uuid.NewString()
	request := map[string]interface{}{"kind": "cancellation_request", "request_id": cancelID, "reason": "operator requested withdrawal"}
	cancelled := decode[protocol.TaskMutationResponse](t, f.request("PATCH", "/tasks/"+task.Id.String()+"/status", f.admin, request, 200))
	if cancelled.Data.Status != "cancellation_requested" || cancelled.Data.ExecutionStatus != "pending" {
		t.Fatal("Core fabricated physical cancellation")
	}
	f.checkin(a)
	report := f.reportBody(a, "task_report", task.Id.String(), "2", map[string]interface{}{"kind": "report", "cancellation_response": map[string]interface{}{"request_id": cancelID, "outcome": "confirmed"}}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	confirmed := decode[protocol.TaskReportResponse](t, f.request("PATCH", "/tasks/"+task.Id.String()+"/status", a.secret, report, 200))
	if confirmed.Data.Task.Status != "cancelled" || confirmed.Data.Task.CancellationRequests[0].Outcome != "confirmed" {
		t.Fatal("assigned cancellation confirmation lost")
	}
	completion := f.reportBody(a, "task_report", task.Id.String(), "3", map[string]interface{}{"kind": "report", "status": "completed"}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	f.request("PATCH", "/tasks/"+task.Id.String()+"/status", a.secret, completion, 409)
	f.request("PATCH", "/tasks/"+task.Id.String()+"/status", f.admin, request, 200)
}

func TestPrecommitFailureLeavesReportDomainAndContactUnchanged(t *testing.T) {
	var fail atomic.Bool
	f := newFixture(t, systemoperations.Options{BeforeCommit: func(context.Context) error {
		if fail.Load() {
			return errors.New("injected before commit")
		}
		return nil
	}})
	a, _ := f.register()
	first := f.checkin(a)
	body := f.reportBody(a, "entity_report", a.id, "2", map[string]interface{}{"components": map[string]interface{}{"telemetry": map[string]interface{}{"position": map[string]float64{"latitude": 11, "longitude": 21}}}}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	before, err := f.core.InspectEvidence(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	fail.Store(true)
	f.request("PATCH", "/entities/"+a.id, a.secret, body, 500)
	fail.Store(false)
	after, err := f.core.InspectEvidence(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatalf("precommit failure changed atomic journals: before%#v after%#v", before, after)
	}
	unchanged := decode[protocol.AssetResponse](t, f.request("GET", "/entities/"+a.id, f.admin, nil, 200))
	if unchanged.Data.Components.Telemetry != nil || !unchanged.Data.Components.Heartbeat.LastSeen.GetOrEmpty().Equal(first.Data.Entity.Components.Heartbeat.LastSeen.GetOrEmpty()) {
		t.Fatal("failure before commit leaked effects")
	}
	accepted := decode[protocol.EntityReportResponse](t, f.request("PATCH", "/entities/"+a.id, a.secret, body, 200))
	if accepted.Data.Acceptance.Disposition != "accepted" || len(accepted.Data.Acceptance.MovementSampleIds) != 1 {
		t.Fatal("failed attempt consumed report or movement identity")
	}
	f.restart(systemoperations.Options{})
	duplicate := decode[protocol.EntityReportResponse](t, f.request("PATCH", "/entities/"+a.id, a.secret, body, 200))
	if duplicate.Data.Acceptance.Disposition != "duplicate" || duplicate.Data.Acceptance.ContactRefreshed {
		t.Fatal("retry after Restart repeated committed effects")
	}
}
