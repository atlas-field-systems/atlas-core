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
	"github.com/atlas-field-systems/atlas-core/systemoperations"
	"github.com/google/uuid"
	"io"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

type outcome struct {
	status  int
	body    []byte
	headers http.Header
	err     error
}

func (f *fixture) exchange(method, path, secret string, body interface{}) outcome {
	encoded, err := json.Marshal(body)
	if err != nil {
		return outcome{err: err}
	}
	if body == nil {
		encoded = nil
	}
	request, err := http.NewRequest(method, f.server.URL+path, bytes.NewReader(encoded))
	if err != nil {
		return outcome{err: err}
	}
	request.Header.Set("Authorization", "Bearer "+secret)
	request.Header.Set("Atlas-Dataset-ID", f.dataset)
	request.Header.Set("Atlas-Protocol-Version", "0.1.0")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := f.client.Do(request)
	if err != nil {
		return outcome{err: err}
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	return outcome{response.StatusCode, data, response.Header, err}
}

type loseSuccessfulReply struct {
	inner http.RoundTripper
	armed atomic.Bool
}

func (t *loseSuccessfulReply) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := t.inner.RoundTrip(request)
	if err != nil {
		return nil, err
	}
	if t.armed.Swap(false) && response.StatusCode >= 200 && response.StatusCode < 300 {
		_, readErr := io.Copy(io.Discard, response.Body)
		closeErr := response.Body.Close()
		return nil, errors.Join(errors.New("injected lost committed response"), readErr, closeErr)
	}
	return response, nil
}

func TestLostSuccessfulResponseReplaysAfterRetainedRestart(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, _ := f.register()
	f.checkin(a)
	body := f.reportBody(a, "entity_report", a.id, "2", map[string]interface{}{"components": map[string]interface{}{"telemetry": map[string]float64{"speed_mps": 7}}}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	transport := &loseSuccessfulReply{inner: f.client.Transport}
	transport.armed.Store(true)
	f.client.Transport = transport
	lost := f.exchange("PATCH", "/entities/"+a.id, a.secret, body)
	if lost.err == nil {
		t.Fatal("fault adapter did not lose committed response")
	}
	f.restart(systemoperations.Options{})
	replayed := decode[protocol.EntityReportResponse](t, f.request("PATCH", "/entities/"+a.id, a.secret, body, 200))
	if replayed.Data.Acceptance.Disposition != "duplicate" || replayed.Data.Acceptance.ContactRefreshed || replayed.Data.Entity.Components.Telemetry.SpeedMps.GetOrEmpty() != 7 {
		t.Fatal("uncertain successful write was not replayed once")
	}
	history := decode[protocol.MovementPageResponse](t, f.request("GET", "/entities/"+a.id+"/movement-history?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z", f.admin, nil, 200))
	if len(history.Data.Items) != 1 {
		t.Fatal("lost reply retry duplicated movement")
	}
}

func TestResetRejectsMutationPausedAfterInitialAuthentication(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var armed atomic.Bool
	f := newFixture(t, systemoperations.Options{BeforeDispatch: func(ctx context.Context, d systemoperations.Dispatch) error {
		if armed.Load() && d.Method == "PATCH" {
			close(entered)
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		return nil
	}})
	a, _ := f.register()
	f.checkin(a)
	body := f.reportBody(a, "entity_report", a.id, "2", map[string]interface{}{"components": map[string]interface{}{"telemetry": map[string]float64{"speed_mps": 8}}}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	armed.Store(true)
	result := make(chan outcome, 1)
	go func() { result <- f.exchange("PATCH", "/entities/"+a.id, a.secret, body) }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("dispatch barrier did not run")
	}
	old := f.dataset
	replacement, err := f.core.Maintain(context.Background(), coremaintenance.Request{ActionID: uuid.NewString(), RunID: f.run, Kind: "reset", ResetID: uuid.NewString(), ExpectedDatasetID: old})
	if err != nil {
		t.Fatal(err)
	}
	close(release)
	response := <-result
	if response.err != nil || response.status != 409 {
		t.Fatalf("obsolete mutation got %#v", response)
	}
	failure := decode[protocol.Error](t, response.body)
	if failure.Error.Code != "dataset_mismatch" || response.headers.Get("Atlas-Dataset-ID") != replacement.DatasetID {
		t.Fatal("commit did not return actual new Dataset boundary")
	}
	armed.Store(false)
	f.dataset = replacement.DatasetID
	entities := decode[protocol.AssetPageResponse](t, f.request("GET", "/entities", f.admin, nil, 200))
	if len(entities.Data.Items) != 0 {
		t.Fatal("old mutation resurrected state after Reset")
	}
	f.request("GET", "/health", a.secret, nil, 200)
}

func TestDeletionFencesAuthenticatedInflightReportAndAssignment(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var armed atomic.Bool
	f := newFixture(t, systemoperations.Options{BeforeDispatch: func(ctx context.Context, d systemoperations.Dispatch) error {
		if armed.Load() && d.Method == "PATCH" {
			close(entered)
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		return nil
	}})
	a, _ := f.register()
	f.checkin(a)
	body := f.reportBody(a, "entity_report", a.id, "2", map[string]interface{}{"components": map[string]interface{}{"telemetry": map[string]float64{"speed_mps": 8}}}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	armed.Store(true)
	result := make(chan outcome, 1)
	go func() { result <- f.exchange("PATCH", "/entities/"+a.id, a.secret, body) }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("dispatch barrier did not run")
	}
	f.request("DELETE", "/entities/"+a.id, f.admin, nil, 204)
	close(release)
	response := <-result
	if response.err != nil || response.status != 401 {
		t.Fatalf("revoked in-flight report got %#v", response)
	}
	armed.Store(false)
	f.request("GET", "/health", a.secret, nil, 401)
	history := decode[protocol.MovementPageResponse](t, f.request("GET", "/entities/"+a.id+"/movement-history?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z", f.admin, nil, 200))
	if !history.Data.EntityDeleted || len(history.Data.Items) != 0 {
		t.Fatal("deletion-first report recorded movement")
	}
	b, _ := f.register()
	task := f.create(b)
	f.request("DELETE", "/entities/"+b.id, f.admin, nil, 409)
	f.checkin(b)
	finish := f.reportBody(b, "task_report", task.Id.String(), "2", map[string]interface{}{"kind": "report", "status": "completed"}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	f.request("PATCH", "/tasks/"+task.Id.String()+"/status", b.secret, finish, 200)
	f.request("DELETE", "/entities/"+b.id, f.admin, nil, 204)
	saved := decode[protocol.TaskResponse](t, f.request("GET", "/tasks/"+task.Id.String(), f.admin, nil, 200))
	if saved.Data.Status != "completed" {
		t.Fatal("allowed deletion erased historical execution")
	}
}

func (f *fixture) replacementBody(a *asset, sequence, expected string) map[string]interface{} {
	body := f.reportBody(a, "checkin", a.id, sequence, map[string]interface{}{"components": map[string]interface{}{"status": map[string]string{"value": "ready"}}}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	contextFacts := body["report_context"].(map[string]interface{})
	proof := contextFacts["process_proof"]
	delete(contextFacts, "process_proof")
	facts, err := corefacts.Encode(map[string]interface{}{"kind": "checkin", "dataset_id": f.dataset, "protocol_version": "0.1.0", "target_id": a.id, "report_context": contextFacts, "payload": map[string]interface{}{"components": body["components"]}})
	if err != nil {
		f.t.Fatal(err)
	}
	contextFacts["process_proof"] = proof
	public := a.process.Public().(ed25519.PublicKey)
	claim := map[string]interface{}{"transfer_id": uuid.NewString(), "process_id": uuid.NewString(), "expected_generation": expected, "process_public_key": base64.RawURLEncoding.EncodeToString(public)}
	transferFacts := map[string]interface{}{"kind": "authority_transfer", "dataset_id": f.dataset, "asset_id": a.id, "report_digest": corefacts.Digest(facts)}
	for key, value := range claim {
		transferFacts[key] = value
	}
	canonical, err := corefacts.Encode(transferFacts)
	if err != nil {
		f.t.Fatal(err)
	}
	claim["recovery_proof"] = base64.RawURLEncoding.EncodeToString(ed25519.Sign(a.recovery, canonical))
	body["authority_claim"] = claim
	return body
}
func TestConcurrentProcessReplacementOneWinnerReplayAndHistoricalOutcome(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, _ := f.register()
	task := f.create(a)
	f.checkin(a)
	oldProcess := *a
	health := decode[protocol.HealthResponse](t, f.request("GET", "/health?asset_id="+a.id+"&process_generation=2", a.secret, nil, 200))
	a.generation = "2"
	a.challenge = health.Data.ContactChallenge.Token
	_, a.process, _ = ed25519.GenerateKey(rand.Reader)
	candidate1 := *a
	_, candidate1.process, _ = ed25519.GenerateKey(rand.Reader)
	first := f.replacementBody(a, "1", "1")
	second := f.replacementBody(&candidate1, "1", "1")
	results := make(chan outcome, 2)
	go func() { results <- f.exchange("POST", "/entities/"+a.id+"/checkin", a.secret, first) }()
	go func() { results <- f.exchange("POST", "/entities/"+a.id+"/checkin", a.secret, second) }()
	r1, r2 := <-results, <-results
	if r1.err != nil || r2.err != nil || !(r1.status == 200 && r2.status == 409 || r1.status == 409 && r2.status == 200) {
		t.Fatalf("expected one winner: %#v %#v", r1, r2)
	}
	winner := first
	accepted := r1
	if r1.status != 200 {
		accepted = r2
	}
	association := decode[protocol.EntityReportResponse](t, accepted.body).Data.Authority
	if association.ProcessPublicKey != base64.RawURLEncoding.EncodeToString(a.process.Public().(ed25519.PublicKey)) {
		winner = second
		a.process = candidate1.process
	}
	replayed := decode[protocol.EntityReportResponse](t, f.request("POST", "/entities/"+a.id+"/checkin", a.secret, winner, 200))
	if replayed.Data.Acceptance.Disposition != "duplicate" || replayed.Data.Entity.ProcessAuthority.GetOrEmpty().ProcessGeneration != "2" {
		t.Fatal("winning authority replay changed generation")
	}
	old := f.reportBody(&oldProcess, "task_report", task.Id.String(), "2", map[string]interface{}{"kind": "report", "status": "completed"}, false, "historical", map[string]string{"process_generation": "1", "sequence": "2"}, nil, "2026-01-01T00:00:00Z")
	f.request("PATCH", "/tasks/"+task.Id.String()+"/status", a.secret, old, 409)
	telemetry := f.reportBody(a, "entity_report", a.id, "20", map[string]interface{}{"components": map[string]interface{}{"telemetry": map[string]float64{"heading_deg": 90}}}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	fresh := decode[protocol.EntityReportResponse](t, f.request("PATCH", "/entities/"+a.id, a.secret, telemetry, 200))
	historical := f.reportBody(a, "task_report", task.Id.String(), "21", map[string]interface{}{"kind": "report", "status": "completed"}, false, "historical", map[string]string{"process_generation": "1", "sequence": "2"}, nil, "2026-01-01T00:00:00Z")
	completed := decode[protocol.TaskReportResponse](t, f.request("PATCH", "/tasks/"+task.Id.String()+"/status", a.secret, historical, 200))
	if completed.Data.Task.Status != "completed" || completed.Data.Acceptance.ContactRefreshed {
		t.Fatal("newer telemetry suppressed legitimate historical Task outcome")
	}
	current := decode[protocol.AssetResponse](t, f.request("GET", "/entities/"+a.id, f.admin, nil, 200))
	if !current.Data.Components.Heartbeat.LastSeen.GetOrEmpty().Equal(fresh.Data.Entity.Components.Heartbeat.LastSeen.GetOrEmpty()) {
		t.Fatal("historical outcome refreshed Contact")
	}
}

func TestLostRegistrationAndInitialAuthorityRepliesReplayAfterRestart(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, registration := f.prepareRegistration()
	transport := &loseSuccessfulReply{inner: f.client.Transport}
	transport.armed.Store(true)
	f.client.Transport = transport
	if lost := f.exchange("POST", "/entities", a.secret, registration); lost.err == nil {
		t.Fatal("registration reply fault did not run")
	}
	f.restart(systemoperations.Options{})
	recovered := decode[protocol.RegistrationResponse](t, f.request("POST", "/entities", a.secret, registration, 201))
	if recovered.Data.Entity.Id.String() != a.id || recovered.Data.Association.RegistrationId.String() != registration["registration_id"] {
		t.Fatal("lost registration did not retain caller association")
	}
	health := decode[protocol.HealthResponse](t, f.request("GET", "/health?asset_id="+a.id+"&process_generation=1", a.secret, nil, 200))
	a.challenge = health.Data.ContactChallenge.Token
	body := f.reportBody(a, "checkin", a.id, "1", map[string]interface{}{"components": map[string]interface{}{"status": map[string]string{"value": "ready"}}}, true, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	transport = &loseSuccessfulReply{inner: f.client.Transport}
	transport.armed.Store(true)
	f.client.Transport = transport
	if lost := f.exchange("POST", "/entities/"+a.id+"/checkin", a.secret, body); lost.err == nil {
		t.Fatal("authority reply fault did not run")
	}
	f.restart(systemoperations.Options{})
	accepted := decode[protocol.EntityReportResponse](t, f.request("POST", "/entities/"+a.id+"/checkin", a.secret, body, 200))
	if accepted.Data.Authority == nil || accepted.Data.Authority.ProcessGeneration != "1" || accepted.Data.Acceptance.Disposition != "duplicate" || accepted.Data.Acceptance.ContactRefreshed {
		t.Fatal("winning association was not replayable")
	}
	oldChallenge := f.reportBody(a, "checkin", a.id, "2", map[string]interface{}{"components": map[string]interface{}{"status": map[string]string{"value": "ready"}}}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	stale := decode[protocol.EntityReportResponse](t, f.request("POST", "/entities/"+a.id+"/checkin", a.secret, oldChallenge, 200))
	if stale.Data.Acceptance.ContactRefreshed {
		t.Fatal("pre-restart challenge established fresh Contact")
	}
	health = decode[protocol.HealthResponse](t, f.request("GET", "/health?asset_id="+a.id+"&process_generation=1", a.secret, nil, 200))
	a.challenge = health.Data.ContactChallenge.Token
	badTime := f.reportBody(a, "checkin", a.id, "3", map[string]interface{}{"components": map[string]interface{}{"status": map[string]string{"value": "ready"}}}, false, "current", nil, nil, time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano))
	stale = decode[protocol.EntityReportResponse](t, f.request("POST", "/entities/"+a.id+"/checkin", a.secret, badTime, 200))
	if stale.Data.Acceptance.ContactRefreshed {
		t.Fatal("source time outside challenge established Contact")
	}
	fresh := f.reportBody(a, "checkin", a.id, "4", map[string]interface{}{"components": map[string]interface{}{"status": map[string]string{"value": "ready"}}}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	current := decode[protocol.EntityReportResponse](t, f.request("POST", "/entities/"+a.id+"/checkin", a.secret, fresh, 200))
	if !current.Data.Acceptance.ContactRefreshed {
		t.Fatal("fresh accepted evidence did not establish Contact")
	}
}

func TestAssignmentAndDeletionRaceBothCommitOrders(t *testing.T) {
	for _, deletionWins := range []bool{true, false} {
		name := "assignment-first"
		if deletionWins {
			name = "deletion-first"
		}
		t.Run(name, func(t *testing.T) {
			entered, release := make(chan struct{}), make(chan struct{})
			var armed atomic.Bool
			f := newFixture(t, systemoperations.Options{BeforeDispatch: func(ctx context.Context, d systemoperations.Dispatch) error {
				if armed.Load() && (deletionWins && d.Method == "POST" && d.Path == "/tasks" || !deletionWins && d.Method == "DELETE") {
					close(entered)
					select {
					case <-release:
						return nil
					case <-ctx.Done():
						return ctx.Err()
					}
				}
				return nil
			}})
			a, _ := f.register()
			request := map[string]interface{}{"asset_id": a.id, "idempotency_key": uuid.NewString(), "command": "move_to", "input": map[string]interface{}{"target": map[string]interface{}{"kind": "position", "position": map[string]float64{"latitude": 10, "longitude": 20}}}}
			armed.Store(true)
			result := make(chan outcome, 1)
			if deletionWins {
				go func() { result <- f.exchange("POST", "/tasks", f.admin, request) }()
			} else {
				go func() { result <- f.exchange("DELETE", "/entities/"+a.id, f.admin, nil) }()
			}
			select {
			case <-entered:
			case <-time.After(5 * time.Second):
				t.Fatal("race barrier did not run")
			}
			if deletionWins {
				f.request("DELETE", "/entities/"+a.id, f.admin, nil, 204)
			} else {
				f.request("POST", "/tasks", f.admin, request, 201)
			}
			close(release)
			reply := <-result
			wanted := 409
			if deletionWins {
				wanted = 404
			}
			if reply.err != nil || reply.status != wanted {
				t.Fatalf("race response %#v", reply)
			}
			armed.Store(false)
			tasks := decode[protocol.TaskPageResponse](t, f.request("GET", "/tasks", f.admin, nil, 200))
			if deletionWins && len(tasks.Data.Items) != 0 || !deletionWins && len(tasks.Data.Items) != 1 {
				t.Fatal("race lost assignment/deletion boundary")
			}
		})
	}
}

func TestCommittedReportSurvivesDeletionWhileAuthenticatedDeletionWaits(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var armed atomic.Bool
	f := newFixture(t, systemoperations.Options{BeforeDispatch: func(ctx context.Context, d systemoperations.Dispatch) error {
		if armed.Load() && d.Method == "DELETE" {
			close(entered)
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		return nil
	}})
	a, _ := f.register()
	f.checkin(a)
	armed.Store(true)
	result := make(chan outcome, 1)
	go func() { result <- f.exchange("DELETE", "/entities/"+a.id, f.admin, nil) }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("deletion barrier did not run")
	}
	report := f.reportBody(a, "entity_report", a.id, "2", map[string]interface{}{"components": map[string]interface{}{"telemetry": map[string]float64{"speed_mps": 8}}}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	f.request("PATCH", "/entities/"+a.id, a.secret, report, 200)
	close(release)
	reply := <-result
	if reply.err != nil || reply.status != 204 {
		t.Fatalf("deletion after report %#v", reply)
	}
	armed.Store(false)
	history := decode[protocol.MovementPageResponse](t, f.request("GET", "/entities/"+a.id+"/movement-history?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z", f.admin, nil, 200))
	if !history.Data.EntityDeleted || len(history.Data.Items) != 1 || history.Data.Items[0].Quantities.SpeedMps.Value.GetOrEmpty() != 8 {
		t.Fatal("report-first deletion erased evidence")
	}
	f.request("PATCH", "/entities/"+a.id, a.secret, report, 401)
}

func TestPrecommitFailureAcrossEveryReportRouteRollsBackAndReplaysAfterRestart(t *testing.T) {
	for _, kind := range []string{"checkin", "entity_report", "status_report", "task_report"} {
		t.Run(kind, func(t *testing.T) {
			var armed atomic.Bool
			f := newFixture(t, systemoperations.Options{BeforeCommit: func(context.Context) error {
				if armed.Load() {
					return errors.New("injected precommit refusal")
				}
				return nil
			}})
			a, _ := f.register()
			task := f.create(a)
			first := f.checkin(a)
			method, path, target, payload := "PATCH", "/entities/"+a.id, a.id, map[string]interface{}{"components": map[string]interface{}{"status": map[string]string{"value": "busy"}}}
			switch kind {
			case "checkin":
				method, path = "POST", "/entities/"+a.id+"/checkin"
			case "entity_report":
				payload = map[string]interface{}{"components": map[string]interface{}{"telemetry": map[string]float64{"speed_mps": 3}}}
			case "status_report":
				path = "/entities/" + a.id + "/status"
				payload = map[string]interface{}{"status": map[string]string{"value": "busy"}}
			case "task_report":
				target = task.Id.String()
				path = "/tasks/" + target + "/status"
				payload = map[string]interface{}{"kind": "report", "status": "in_progress"}
			}
			body := f.reportBody(a, kind, target, "2", payload, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
			before, err := f.core.InspectEvidence(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			armed.Store(true)
			f.request(method, path, a.secret, body, 500)
			armed.Store(false)
			after, err := f.core.InspectEvidence(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if before != after {
				t.Fatal("precommit fault persisted acceptance/domain/journals")
			}
			entity := decode[protocol.AssetResponse](t, f.request("GET", "/entities/"+a.id, f.admin, nil, 200))
			taskAfter := decode[protocol.TaskResponse](t, f.request("GET", "/tasks/"+task.Id.String(), f.admin, nil, 200))
			if entity.Data.Version != first.Data.Entity.Version || entity.Data.Components.Status.Value != "ready" || entity.Data.Components.Telemetry != nil || !entity.Data.Components.Heartbeat.LastSeen.GetOrEmpty().Equal(first.Data.Entity.Components.Heartbeat.LastSeen.GetOrEmpty()) || taskAfter.Data.Status != "pending" {
				t.Fatal("precommit fault left a partial result")
			}
			f.restart(systemoperations.Options{})
			f.request(method, path, a.secret, body, 200)
			f.request(method, path, a.secret, body, 200)
			recovered, err := f.core.InspectEvidence(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if recovered.Reports != before.Reports+1 {
				t.Fatal("post-Restart retry did not commit one acceptance")
			}
			wantedMovement := before.Movement
			if kind == "entity_report" {
				wantedMovement++
			}
			if recovered.Movement != wantedMovement {
				t.Fatal("post-Restart retry duplicated or lost movement")
			}
		})
	}
}
