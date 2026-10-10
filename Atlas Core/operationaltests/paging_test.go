package operationaltests_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"github.com/atlas-field-systems/atlas-core/corefacts"
	"net/url"
	"sync/atomic"
	"testing"
	"time"

	"github.com/atlas-field-systems/atlas-core/coremaintenance"
	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/systemoperations"
	"github.com/google/uuid"
)

func TestRegistrationEqualityAppliesOnlyDeclaredDefaults(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, request := f.prepareRegistration()
	delete(request, "command_manifest")
	first := decode[protocol.RegistrationResponse](t, f.request("POST", "/entities", a.secret, request, 201))
	request["alias"] = nil
	request["command_manifest"] = []interface{}{}
	equal := decode[protocol.RegistrationResponse](t, f.request("POST", "/entities", a.secret, request, 201))
	if equal.Data.Association != first.Data.Association || equal.Data.Entity.Version != first.Data.Entity.Version {
		t.Fatal("declared registration defaults changed retry facts")
	}
	request["subtype"] = nil
	f.request("POST", "/entities", a.secret, request, 409)
}

func TestOrdinaryResourceKeysetCursorsSurviveRetainedRestart(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, _ := f.register()
	f.register()
	f.create(a)
	f.create(a)
	entities := decode[protocol.AssetPageResponse](t, f.request("GET", "/entities?limit=1", f.admin, nil, 200))
	tasks := decode[protocol.TaskPageResponse](t, f.request("GET", "/tasks?limit=1", f.admin, nil, 200))
	assigned := decode[protocol.AssignedTaskPageResponse](t, f.request("GET", "/entities/"+a.id+"/tasks?limit=1", a.secret, nil, 200))
	f.restart(systemoperations.Options{})
	nextEntity := decode[protocol.AssetPageResponse](t, f.request("GET", "/entities?limit=1&cursor="+url.QueryEscape(entities.Data.NextCursor.GetOrEmpty()), f.admin, nil, 200))
	if len(nextEntity.Data.Items) != 1 || nextEntity.Data.Items[0].Id == entities.Data.Items[0].Id {
		t.Fatal("Entity keyset failed after Restart")
	}
	nextTask := decode[protocol.TaskPageResponse](t, f.request("GET", "/tasks?limit=1&cursor="+url.QueryEscape(tasks.Data.NextCursor.GetOrEmpty()), f.admin, nil, 200))
	if len(nextTask.Data.Items) != 1 || nextTask.Data.Items[0].Id == tasks.Data.Items[0].Id {
		t.Fatal("Task keyset failed after Restart")
	}
	nextAssigned := decode[protocol.AssignedTaskPageResponse](t, f.request("GET", "/entities/"+a.id+"/tasks?limit=1&cursor="+url.QueryEscape(assigned.Data.NextCursor.GetOrEmpty()), a.secret, nil, 200))
	if len(nextAssigned.Data.Items) != 1 || nextAssigned.Data.QueueRevision != assigned.Data.QueueRevision {
		t.Fatal("assigned queue cursor failed after Restart")
	}
}

func TestMovementTraversalPinsUpperBoundaryAndOrdersObservationTimes(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, _ := f.register()
	f.checkin(a)
	report := func(sequence, observed string) protocol.EntityReportResponse {
		body := f.reportBody(a, "entity_report", a.id, sequence, map[string]interface{}{"components": map[string]interface{}{"telemetry": map[string]float64{"speed_mps": 2}}}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
		context := body["report_context"].(map[string]interface{})
		context["observation_times"] = map[string]interface{}{"speed_mps": map[string]string{"observed_at": observed}}
		f.resign(a, "entity_report", a.id, body)
		return decode[protocol.EntityReportResponse](t, f.request("PATCH", "/entities/"+a.id, a.secret, body, 200))
	}
	first := report("2", "2026-01-01T12:00:00.500+00:00")
	second := report("3", "2026-01-01T10:00:00Z")
	path := "/entities/" + a.id + "/movement-history?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z&limit=1"
	received := decode[protocol.MovementPageResponse](t, f.request("GET", path, f.admin, nil, 200))
	observed := decode[protocol.MovementPageResponse](t, f.request("GET", path+"&time_basis=observed_at", f.admin, nil, 200))
	if received.Data.Items[0].Id != first.Data.Acceptance.MovementSampleIds[0] || observed.Data.Items[0].Id != second.Data.Acceptance.MovementSampleIds[0] {
		t.Fatal("history did not distinguish receipt/observation order")
	}
	report("4", "2026-01-01T11:00:00Z")
	f.restart(systemoperations.Options{})
	nextReceived := decode[protocol.MovementPageResponse](t, f.request("GET", path+"&cursor="+url.QueryEscape(received.Data.NextCursor.GetOrEmpty()), f.admin, nil, 200))
	nextObserved := decode[protocol.MovementPageResponse](t, f.request("GET", path+"&time_basis=observed_at&cursor="+url.QueryEscape(observed.Data.NextCursor.GetOrEmpty()), f.admin, nil, 200))
	if len(nextReceived.Data.Items) != 1 || !nextReceived.Data.NextCursor.IsNull() || nextReceived.Data.Items[0].Id != second.Data.Acceptance.MovementSampleIds[0] || len(nextObserved.Data.Items) != 1 || !nextObserved.Data.NextCursor.IsNull() || nextObserved.Data.Items[0].Id != first.Data.Acceptance.MovementSampleIds[0] {
		t.Fatal("append or Restart changed the pinned traversal")
	}
	if nextObserved.Data.Items[0].Quantities.SpeedMps.ObservedAt.GetOrEmpty() != "2026-01-01T12:00:00.500+00:00" {
		t.Fatal("SQL chronology normalized public source spelling")
	}
}

func TestAssignedContinuationUsesQueueChangesRatherThanTaskProgress(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, _ := f.register()
	first := f.create(a)
	second := f.create(a)
	f.checkin(a)
	start := f.reportBody(a, "task_report", first.Id.String(), "2", map[string]interface{}{"kind": "report", "status": "in_progress"}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	f.request("PATCH", "/tasks/"+first.Id.String()+"/status", a.secret, start, 200)
	path := "/entities/" + a.id + "/tasks?limit=1"
	page := decode[protocol.AssignedTaskPageResponse](t, f.request("GET", path, a.secret, nil, 200))
	progress := f.reportBody(a, "task_report", first.Id.String(), "3", map[string]interface{}{"kind": "report", "progress": map[string]float64{"distance_remaining_m": 9}}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	f.request("PATCH", "/tasks/"+first.Id.String()+"/status", a.secret, progress, 200)
	next := decode[protocol.AssignedTaskPageResponse](t, f.request("GET", path+"&cursor="+url.QueryEscape(page.Data.NextCursor.GetOrEmpty()), a.secret, nil, 200))
	if len(next.Data.Items) != 1 || next.Data.Items[0].Id != second.Id || next.Data.QueueRevision != page.Data.QueueRevision {
		t.Fatal("unrelated progress invalidated coherent assigned order")
	}
}

func TestDerivedCommunicationAgeCommitsVersionAndChangeWithoutContact(t *testing.T) {
	var now atomic.Int64
	now.Store(time.Now().UnixNano())
	f := newFixture(t, systemoperations.Options{CommunicationTime: func() time.Time { return time.Unix(0, now.Load()) }})
	a, _ := f.register()
	reported := f.checkin(a)
	lastSeen := reported.Data.Entity.Components.Heartbeat.LastSeen.GetOrEmpty()
	before, err := f.core.InspectEvidence(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	now.Store(lastSeen.Add(4 * time.Second).UnixNano())
	degraded := decode[protocol.AssetResponse](t, f.request("GET", "/entities/"+a.id, f.admin, nil, 200))
	after, err := f.core.InspectEvidence(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if degraded.Data.Components.Communications.State != "degraded" || degraded.Data.Version == reported.Data.Entity.Version || !degraded.Data.UpdatedAt.After(reported.Data.Entity.UpdatedAt) || !degraded.Data.Components.Heartbeat.LastSeen.GetOrEmpty().Equal(lastSeen) || after.Changes != before.Changes+1 || after.Reports != before.Reports || after.Movement != before.Movement || after.Activities != before.Activities {
		t.Fatal("Derived age changed only a response copy or invented evidence")
	}
	observedAfter := decode[protocol.HealthResponse](t, f.request("GET", "/health", f.admin, nil, 200))
	if degraded.ReadContext != observedAfter.ReadContext || degraded.ReadContext.Source != "http" || degraded.ReadContext.CommitCursor == reported.CommitCursor {
		t.Fatal("read boundary omitted the derived change committed by its own transaction")
	}
	same := decode[protocol.AssetResponse](t, f.request("GET", "/entities/"+a.id, f.admin, nil, 200))
	if same.Data.Version != degraded.Data.Version {
		t.Fatal("unchanged communication age created another version")
	}
	now.Store(lastSeen.Add(11 * time.Second).UnixNano())
	offline := decode[protocol.AssetResponse](t, f.request("GET", "/entities/"+a.id, f.admin, nil, 200))
	if offline.Data.Components.Communications.State != "offline" || offline.Data.Version == degraded.Data.Version {
		t.Fatal("offline age was not committed")
	}
}

func TestOutstandingTaskAdmissionPreservesRetryAndCancellationPaths(t *testing.T) {
	config := coremaintenance.DefaultConfig()
	config.MaxOutstandingTasksPerAsset = 2
	f := newConfiguredFixture(t, systemoperations.Options{}, config)
	a, _ := f.register()
	request := map[string]interface{}{"asset_id": a.id, "idempotency_key": uuid.NewString(), "command": "move_to", "input": map[string]interface{}{"target": map[string]interface{}{"kind": "position", "position": map[string]float64{"latitude": 10, "longitude": 20}}}}
	first := decode[protocol.TaskMutationResponse](t, f.request("POST", "/tasks", f.admin, request, 201))
	f.create(a)
	blocked := map[string]interface{}{}
	for key, value := range request {
		blocked[key] = value
	}
	blocked["idempotency_key"] = uuid.NewString()
	f.request("POST", "/tasks", f.admin, blocked, 429)
	f.request("POST", "/tasks", f.admin, request, 201)
	cancellation := uuid.NewString()
	f.request("PATCH", "/tasks/"+first.Data.Id.String()+"/status", f.admin, map[string]string{"kind": "cancellation_request", "request_id": cancellation}, 200)
	f.request("POST", "/tasks", f.admin, blocked, 429)
	f.checkin(a)
	confirm := f.reportBody(a, "task_report", first.Data.Id.String(), "2", map[string]interface{}{"kind": "report", "status": "cancelled", "cancellation_response": map[string]string{"request_id": cancellation, "outcome": "confirmed"}}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	f.request("PATCH", "/tasks/"+first.Data.Id.String()+"/status", a.secret, confirm, 200)
	accepted := decode[protocol.TaskMutationResponse](t, f.request("POST", "/tasks", f.admin, blocked, 201))
	if accepted.Data.SubmissionSequence != "3" {
		t.Fatal("refused admission consumed a submission slot")
	}
}

func (f *fixture) resign(a *asset, kind, target string, body map[string]interface{}) {
	f.t.Helper()
	context := body["report_context"].(map[string]interface{})
	delete(context, "process_proof")
	payload := map[string]interface{}{}
	for key, value := range body {
		if key != "report_context" && key != "authority_claim" {
			payload[key] = value
		}
	}
	facts, err := corefacts.Encode(map[string]interface{}{"kind": kind, "dataset_id": f.dataset, "protocol_version": "0.1.0", "target_id": target, "report_context": context, "payload": payload})
	if err != nil {
		f.t.Fatal(err)
	}
	context["process_proof"] = base64.RawURLEncoding.EncodeToString(ed25519.Sign(a.process, facts))
}

func TestSuspendedExecutionEvidenceIsAcceptedUnderReplacementAuthority(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, _ := f.register()
	task := f.create(a)
	f.checkin(a)
	start := f.reportBody(a, "task_report", task.Id.String(), "2", map[string]interface{}{"kind": "report", "status": "in_progress"}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	f.request("PATCH", "/tasks/"+task.Id.String()+"/status", a.secret, start, 200)
	health := decode[protocol.HealthResponse](t, f.request("GET", "/health?asset_id="+a.id+"&process_generation=2", a.secret, nil, 200))
	a.generation = "2"
	a.challenge = health.Data.ContactChallenge.Token
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	a.process = key
	f.request("POST", "/entities/"+a.id+"/checkin", a.secret, f.replacementBody(a, "1", "1"), 200)
	suspended := f.reportBody(a, "task_report", task.Id.String(), "2", map[string]interface{}{"kind": "report", "status": "paused"}, false, "historical", nil, uuid.NewString(), "2026-01-01T00:00:00Z")
	recorded := decode[protocol.TaskReportResponse](t, f.request("PATCH", "/tasks/"+task.Id.String()+"/status", a.secret, suspended, 200))
	if recorded.Data.Task.Status != "paused" || recorded.Data.Task.ExecutionStatus != "paused" || recorded.Data.Acceptance.ContactRefreshed {
		t.Fatal("retained suspension was rejected or treated as current reachability")
	}
	repeated := decode[protocol.TaskReportResponse](t, f.request("PATCH", "/tasks/"+task.Id.String()+"/status", a.secret, suspended, 200))
	if repeated.Data.Acceptance.Disposition != "duplicate" {
		t.Fatal("suspended recovery repeated its effect")
	}
}

func TestTaskActivityKeepsStableActionAndActorFacts(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, _ := f.register()
	requestID := uuid.NewString()
	request := map[string]interface{}{"asset_id": a.id, "idempotency_key": requestID, "command": "move_to", "input": map[string]interface{}{"target": map[string]interface{}{"kind": "position", "position": map[string]float64{"latitude": 10, "longitude": 20}}}}
	created := decode[protocol.TaskMutationResponse](t, f.request("POST", "/tasks", f.admin, request, 201))
	f.request("POST", "/tasks", f.admin, request, 201)
	cancellationID := uuid.NewString()
	cancel := map[string]string{"kind": "cancellation_request", "request_id": cancellationID}
	f.request("PATCH", "/tasks/"+created.Data.Id.String()+"/status", f.admin, cancel, 200)
	f.request("PATCH", "/tasks/"+created.Data.Id.String()+"/status", f.admin, cancel, 200)
	facts, err := f.core.InspectActivity(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	issued, cancelled := 0, 0
	actor := ""
	for _, fact := range facts {
		if fact.Action == "task_issued" || fact.Action == "task_cancellation_requested" {
			if fact.ActorType != "operator" || fact.Actor == "" || fact.Outcome != "confirmed" {
				t.Fatal("activity lost authenticated actor/outcome")
			}
			if actor != "" && actor != fact.Actor {
				t.Fatal("same credential invented distinct actors")
			}
			actor = fact.Actor
		}
		if fact.Action == "task_issued" {
			issued++
			if fact.ActionID != requestID {
				t.Fatal("issuance lost stable request identity")
			}
		}
		if fact.Action == "task_cancellation_requested" {
			cancelled++
			if fact.ActionID != cancellationID {
				t.Fatal("cancellation lost stable request identity")
			}
		}
	}
	if issued != 1 || cancelled != 1 {
		t.Fatal("retry duplicated logical activity")
	}
}

func TestDefaultAdmissionRefusesThe1001stOutstandingTask(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, _ := f.register()
	request := map[string]interface{}{"asset_id": a.id, "command": "move_to", "input": map[string]interface{}{"target": map[string]interface{}{"kind": "position", "position": map[string]float64{"latitude": 10, "longitude": 20}}}}
	for range 1000 {
		request["idempotency_key"] = uuid.NewString()
		reply := f.exchange("POST", "/tasks", f.admin, request)
		if reply.err != nil || reply.status != 201 {
			t.Fatalf("admission before1000: status%d error%v", reply.status, reply.err)
		}
	}
	request["idempotency_key"] = uuid.NewString()
	refused := decode[protocol.Error](t, f.request("POST", "/tasks", f.admin, request, 429))
	if refused.Error.Code != "resource_limit" {
		t.Fatal("outstanding-work limit did not return typed admission refusal")
	}
	page := decode[protocol.AssignedTaskPageResponse](t, f.request("GET", "/entities/"+a.id+"/tasks?limit=1000", a.secret, nil, 200))
	if len(page.Data.Items) != 1000 || len(page.Data.TaskQueue.RequestedTaskIds) != 1000 {
		t.Fatal("refused Task changed requested membership")
	}
}
