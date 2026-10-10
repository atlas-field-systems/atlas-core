package operationaltests_test

import (
	"context"
	"net/url"
	"testing"
	"time"

	"github.com/atlas-field-systems/atlas-core/coremaintenance"
	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/systemoperations"
	"github.com/google/uuid"
)

func TestEveryReportRouteSharesReplayAndIdentityConflictBoundary(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, _ := f.register()
	f.checkin(a)
	task := f.create(a)
	cases := []struct {
		kind, target, path, sequence string
		payload, conflict            map[string]interface{}
	}{
		{"checkin", a.id, "/entities/" + a.id + "/checkin", "2", map[string]interface{}{"components": map[string]interface{}{"status": map[string]string{"value": "ready"}}}, map[string]interface{}{"components": map[string]interface{}{"status": map[string]string{"value": "busy"}}}},
		{"entity_report", a.id, "/entities/" + a.id, "3", map[string]interface{}{"components": map[string]interface{}{"telemetry": map[string]float64{"speed_mps": 1}}}, map[string]interface{}{"components": map[string]interface{}{"telemetry": map[string]float64{"speed_mps": 2}}}},
		{"status_report", a.id, "/entities/" + a.id + "/status", "4", map[string]interface{}{"status": map[string]string{"value": "ready"}}, map[string]interface{}{"status": map[string]string{"value": "busy"}}},
		{"task_report", task.Id.String(), "/tasks/" + task.Id.String() + "/status", "5", map[string]interface{}{"kind": "report", "status": "acknowledged"}, map[string]interface{}{"kind": "report", "status": "completed"}},
	}
	for _, test := range cases {
		t.Run(test.kind, func(t *testing.T) {
			generated := time.Now().UTC().Format(time.RFC3339Nano)
			body := f.reportBody(a, test.kind, test.target, test.sequence, test.payload, false, "current", nil, nil, generated)
			method := "PATCH"
			if test.kind == "checkin" {
				method = "POST"
			}
			f.request(method, test.path, a.secret, body, 200)
			before, err := f.core.InspectEvidence(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			duplicate := f.request(method, test.path, a.secret, body, 200)
			var disposition string
			if test.kind == "task_report" {
				reply := decode[protocol.TaskReportResponse](t, duplicate)
				disposition = string(reply.Data.Acceptance.Disposition)
				if reply.Data.Acceptance.ContactRefreshed {
					t.Fatal("duplicate refreshed Contact")
				}
			} else if test.kind == "status_report" {
				reply := decode[protocol.StatusReportResponse](t, duplicate)
				disposition = string(reply.Data.Acceptance.Disposition)
				if reply.Data.Acceptance.ContactRefreshed {
					t.Fatal("duplicate refreshed Contact")
				}
			} else {
				reply := decode[protocol.EntityReportResponse](t, duplicate)
				disposition = string(reply.Data.Acceptance.Disposition)
				if reply.Data.Acceptance.ContactRefreshed {
					t.Fatal("duplicate refreshed Contact")
				}
			}
			if disposition != "duplicate" {
				t.Fatal("report route did not replay")
			}
			different := f.reportBody(a, test.kind, test.target, test.sequence, test.conflict, false, "current", nil, nil, generated)
			f.request(method, test.path, a.secret, different, 409)
			after, err := f.core.InspectEvidence(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if before != after {
				t.Fatal("duplicate/conflict created committed effects")
			}
		})
	}
}

func TestCancellationDeclineRestoresRequestedOrderAndCompletionWinsPendingIntent(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, _ := f.register()
	first := f.create(a)
	second := f.create(a)
	f.checkin(a)
	cancel := func(task protocol.Task) uuid.UUID {
		requestID := uuid.New()
		f.request("PATCH", "/tasks/"+task.Id.String()+"/status", f.admin, map[string]string{"kind": "cancellation_request", "request_id": requestID.String()}, 200)
		return requestID
	}
	requestID := cancel(first)
	removed := decode[protocol.AssignedTaskPageResponse](t, f.request("GET", "/entities/"+a.id+"/tasks", a.secret, nil, 200))
	if len(removed.Data.TaskQueue.RequestedTaskIds) != 1 || removed.Data.TaskQueue.RequestedTaskIds[0] != second.Id {
		t.Fatal("cancellation intent did not remove pending requested slot")
	}
	decline := f.reportBody(a, "task_report", first.Id.String(), "2", map[string]interface{}{"kind": "report", "cancellation_response": map[string]string{"request_id": requestID.String(), "outcome": "declined"}}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	declined := decode[protocol.TaskReportResponse](t, f.request("PATCH", "/tasks/"+first.Id.String()+"/status", a.secret, decline, 200))
	if declined.Data.Task.Status != "pending" || declined.Data.Task.ExecutionStatus != "pending" {
		t.Fatal("decline changed execution")
	}
	restored := decode[protocol.AssignedTaskPageResponse](t, f.request("GET", "/entities/"+a.id+"/tasks", a.secret, nil, 200))
	if len(restored.Data.TaskQueue.RequestedTaskIds) != 2 || restored.Data.TaskQueue.RequestedTaskIds[0] != first.Id {
		t.Fatal("decline did not restore original submission slot")
	}
	requestID = cancel(first)
	completed := f.reportBody(a, "task_report", first.Id.String(), "3", map[string]interface{}{"kind": "report", "status": "completed"}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	outcome := decode[protocol.TaskReportResponse](t, f.request("PATCH", "/tasks/"+first.Id.String()+"/status", a.secret, completed, 200))
	if outcome.Data.Task.Status != "completed" || outcome.Data.Task.CancellationRequests[1].Outcome != "superseded" {
		t.Fatal("completion failed to supersede pending cancellation")
	}
	late := f.reportBody(a, "task_report", first.Id.String(), "4", map[string]interface{}{"kind": "report", "status": "cancelled", "cancellation_response": map[string]string{"request_id": requestID.String(), "outcome": "confirmed"}}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	f.request("PATCH", "/tasks/"+first.Id.String()+"/status", a.secret, late, 409)
}

func TestContinuationsRefuseChangedAssignedViewAndDifferentOptions(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, _ := f.register()
	f.create(a)
	f.create(a)
	path := "/entities/" + a.id + "/tasks?limit=1"
	first := decode[protocol.AssignedTaskPageResponse](t, f.request("GET", path, a.secret, nil, 200))
	cursor := url.QueryEscape(first.Data.NextCursor.GetOrEmpty())
	f.request("GET", path+"&status=pending&cursor="+cursor, a.secret, nil, 400)
	f.create(a)
	reply := decode[protocol.Error](t, f.request("GET", path+"&cursor="+cursor, a.secret, nil, 409))
	if reply.Error.Code != "page_changed" {
		t.Fatalf("changed queue continuation %s", reply.Error.Code)
	}
}

func TestTaskRequestIdentityConcurrentReplayReturnsCurrentTask(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, _ := f.register()
	request := map[string]interface{}{"asset_id": a.id, "idempotency_key": uuid.NewString(), "command": "move_to", "input": map[string]interface{}{"target": map[string]interface{}{"kind": "position", "position": map[string]float64{"latitude": 10, "longitude": 20}}}}
	replies := make(chan outcome, 2)
	for range 2 {
		go func() { replies <- f.exchange("POST", "/tasks", f.admin, request) }()
	}
	one, two := <-replies, <-replies
	if one.err != nil || two.err != nil || one.status != 201 || two.status != 201 {
		t.Fatalf("concurrent Task creation %#v %#v", one, two)
	}
	first := decode[protocol.TaskMutationResponse](t, one.body)
	second := decode[protocol.TaskMutationResponse](t, two.body)
	if first.Data.Id != second.Data.Id || first.Data.SubmissionSequence != "1" {
		t.Fatal("retry created multiple submission slots")
	}
	request["scheduling"] = "queued"
	f.request("POST", "/tasks", f.admin, request, 409)
	delete(request, "scheduling")
	f.checkin(a)
	completed := f.reportBody(a, "task_report", first.Data.Id.String(), "2", map[string]interface{}{"kind": "report", "status": "completed"}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	f.request("PATCH", "/tasks/"+first.Data.Id.String()+"/status", a.secret, completed, 200)
	replayed := decode[protocol.TaskMutationResponse](t, f.request("POST", "/tasks", f.admin, request, 201))
	if replayed.Data.Id != first.Data.Id || replayed.Data.Status != "completed" {
		t.Fatal("Task replay reset current outcome")
	}
}

func TestSparseClearUsesOriginalOrderAndRetainsMovementEvidence(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, _ := f.register()
	f.checkin(a)
	latest := f.reportBody(a, "entity_report", a.id, "10", map[string]interface{}{"components": map[string]interface{}{"telemetry": map[string]float64{"speed_mps": 5}}}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	f.request("PATCH", "/entities/"+a.id, a.secret, latest, 200)
	oldClear := f.reportBody(a, "entity_report", a.id, "11", map[string]interface{}{"components": map[string]interface{}{"telemetry": nil}}, false, "historical", map[string]string{"process_generation": "1", "sequence": "2"}, nil, "2026-01-01T00:00:00Z")
	mixed := decode[protocol.EntityReportResponse](t, f.request("PATCH", "/entities/"+a.id, a.secret, oldClear, 200))
	if mixed.Data.Entity.Components.Telemetry == nil || mixed.Data.Entity.Components.Telemetry.SpeedMps.GetOrEmpty() != 5 || mixed.Data.Entity.Components.Telemetry.Position.IsSpecified() {
		t.Fatal("whole clear erased a newer unrelated unit")
	}
	explicit := f.reportBody(a, "entity_report", a.id, "12", map[string]interface{}{"components": map[string]interface{}{"telemetry": map[string]interface{}{"speed_mps": nil}}}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	cleared := decode[protocol.EntityReportResponse](t, f.request("PATCH", "/entities/"+a.id, a.secret, explicit, 200))
	if cleared.Data.Entity.Components.Telemetry == nil || !cleared.Data.Entity.Components.Telemetry.SpeedMps.IsNull() {
		t.Fatal("explicit unit clear did not retain null")
	}
	old := f.reportBody(a, "entity_report", a.id, "13", map[string]interface{}{"components": map[string]interface{}{"telemetry": map[string]float64{"speed_mps": 6}}}, false, "historical", map[string]string{"process_generation": "1", "sequence": "9"}, nil, "2026-01-01T00:00:00Z")
	retained := decode[protocol.EntityReportResponse](t, f.request("PATCH", "/entities/"+a.id, a.secret, old, 200))
	if !retained.Data.Entity.Components.Telemetry.SpeedMps.IsNull() || len(retained.Data.Acceptance.MovementSampleIds) != 1 {
		t.Fatal("older evidence revived cleared current speed or lost historical movement")
	}
}

func TestCrossAssetReportsAreDeniedAcrossEveryReportRoute(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, _ := f.register()
	other, _ := f.register()
	f.checkin(a)
	task := f.create(a)
	cases := []struct {
		method, path, kind, target string
		payload                    map[string]interface{}
	}{
		{"POST", "/entities/" + a.id + "/checkin", "checkin", a.id, map[string]interface{}{"components": map[string]interface{}{"status": map[string]string{"value": "ready"}}}},
		{"PATCH", "/entities/" + a.id, "entity_report", a.id, map[string]interface{}{"components": map[string]interface{}{"telemetry": map[string]float64{"speed_mps": 3}}}},
		{"PATCH", "/entities/" + a.id + "/status", "status_report", a.id, map[string]interface{}{"status": map[string]string{"value": "ready"}}},
		{"PATCH", "/tasks/" + task.Id.String() + "/status", "task_report", task.Id.String(), map[string]interface{}{"kind": "report", "status": "completed"}},
	}
	before, err := f.core.InspectEvidence(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range cases {
		body := f.reportBody(a, test.kind, test.target, "2", test.payload, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
		f.request(test.method, test.path, other.secret, body, 403)
	}
	f.request("GET", "/health?asset_id="+a.id+"&process_generation=1", other.secret, nil, 403)
	after, err := f.core.InspectEvidence(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatal("foreign reporting created committed effects")
	}
}

func TestRevokedAssetCannotReenrollAfterReset(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, registration := f.prepareRegistration()
	f.request("POST", "/entities", a.secret, registration, 201)
	f.request("DELETE", "/entities/"+a.id, f.admin, nil, 204)
	result, err := f.core.Maintain(context.Background(), coremaintenance.Request{ActionID: uuid.NewString(), RunID: f.run, Kind: "reset", ResetID: uuid.NewString(), ExpectedDatasetID: f.dataset})
	if err != nil {
		t.Fatal(err)
	}
	f.dataset = result.DatasetID
	f.request("POST", "/entities", a.secret, registration, 401)
	f.request("GET", "/health", a.secret, nil, 401)
	remaining := decode[protocol.AssetPageResponse](t, f.request("GET", "/entities", f.admin, nil, 200))
	if len(remaining.Data.Items) != 0 {
		t.Fatal("Reset revived revoked enrollment")
	}
}

func TestMixedAndDerivedEntityFieldsHaveTypedPathsWithoutEffects(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, _ := f.register()
	f.checkin(a)
	before, err := f.core.InspectEvidence(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	mixed := f.reportBody(a, "entity_report", a.id, "2", map[string]interface{}{"components": map[string]interface{}{"telemetry": map[string]float64{"speed_mps": 2}}, "alias": "mixed"}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	reply := decode[protocol.Error](t, f.request("PATCH", "/entities/"+a.id, a.secret, mixed, 400))
	if reply.Error.Code != "mixed_mutation_classes" || reply.Error.Details == nil {
		t.Fatal("mixed mutation lost field diagnostics")
	}
	derived := f.reportBody(a, "entity_report", a.id, "2", map[string]interface{}{"components": map[string]interface{}{"heartbeat": map[string]string{"last_seen": "2026-01-01T00:00:00Z"}}}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	reply = decode[protocol.Error](t, f.request("PATCH", "/entities/"+a.id, a.secret, derived, 403))
	if reply.Error.Code != "forbidden_field" || reply.Error.Details == nil {
		t.Fatal("Derived mutation lost field diagnostics")
	}
	f.request("PATCH", "/entities/"+a.id, f.admin, []interface{}{}, 400)
	after, err := f.core.InspectEvidence(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatal("invalid mutation classes committed effects")
	}
}

func TestInvalidMergedComponentsReturnTypedPathsWithoutAcceptance(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, _ := f.register()
	f.checkin(a)
	before, err := f.core.InspectEvidence(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, components := range []map[string]interface{}{
		{"status": nil},
		{"telemetry": map[string]interface{}{"position": map[string]float64{"latitude": 20}}},
		{"telemetry": map[string]interface{}{"heading_deg": 360}},
	} {
		body := f.reportBody(a, "entity_report", a.id, "2", map[string]interface{}{"components": components}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
		reply := decode[protocol.Error](t, f.request("PATCH", "/entities/"+a.id, a.secret, body, 422))
		if reply.Error.Code != "invalid_component" || reply.Error.Details == nil {
			t.Fatal("invalid component lacks typed paths")
		}
	}
	after, err := f.core.InspectEvidence(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatal("invalid merged component stored acceptance")
	}
}
