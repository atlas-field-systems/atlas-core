package operationaltests_test

import (
	"context"
	"encoding/json"
	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/systemoperations"
	"github.com/google/uuid"
	"net/url"
	"testing"
	"time"
)

func TestConcurrentRegistrationDefaultsReplayAndCurrentState(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, request := f.prepareRegistration()
	delete(request, "command_manifest")
	results := make(chan outcome, 2)
	for range 2 {
		go func() { results <- f.exchange("POST", "/entities", a.secret, request) }()
	}
	first, second := <-results, <-results
	if first.err != nil || second.err != nil || first.status != 201 || second.status != 201 {
		t.Fatalf("registration concurrency %#v %#v", first, second)
	}
	one := decode[protocol.RegistrationResponse](t, first.body)
	two := decode[protocol.RegistrationResponse](t, second.body)
	if one.Data.Association != two.Data.Association || len(one.Data.Entity.CommandManifest) != 0 || one.Data.Entity.Components.Telemetry != nil || len(one.Data.Entity.Reporting) != 0 || one.Data.Entity.TaskQueue.Revision != "0" {
		t.Fatal("identical registration did not keep one default association")
	}
	before, err := f.core.InspectEvidence(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	request["alias"] = "changed-original"
	f.request("POST", "/entities", a.secret, request, 409)
	after, err := f.core.InspectEvidence(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatal("conflicting registration changed committed facts")
	}
	delete(request, "alias")
	ready := f.checkin(a)
	replayed := decode[protocol.RegistrationResponse](t, f.request("POST", "/entities", a.secret, request, 201))
	if replayed.Data.Entity.Components.Status.Value != "ready" || !replayed.Data.Entity.Components.Heartbeat.LastSeen.GetOrEmpty().Equal(ready.Data.Entity.Components.Heartbeat.LastSeen.GetOrEmpty()) {
		t.Fatal("registration replay reset current reporting")
	}
	other, _ := f.register()
	if other.id == a.id {
		t.Fatal("distinct Asset enrollment reused binding")
	}
	f.request("GET", "/entities/"+a.id, other.secret, nil, 200)
	wrong := f.reportBody(other, "entity_report", a.id, "1", map[string]interface{}{"components": map[string]interface{}{"status": map[string]string{"value": "busy"}}}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	f.request("PATCH", "/entities/"+a.id, other.secret, wrong, 403)
}

func TestTaskAdmissionRejectsUnsupportedInputsBeforeCreation(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, _ := f.register()
	valid := map[string]interface{}{"asset_id": a.id, "idempotency_key": uuid.NewString(), "command": "move_to", "input": map[string]interface{}{"target": map[string]interface{}{"kind": "position", "position": map[string]float64{"latitude": 10, "longitude": 20}}}}
	cases := []struct {
		name   string
		mutate func(map[string]interface{})
	}{
		{"immediate", func(v map[string]interface{}) { v["scheduling"] = "immediate" }},
		{"deadline", func(v map[string]interface{}) { v["deadline"] = "2026-01-01T00:00:00Z" }},
		{"half-position", func(v map[string]interface{}) {
			v["input"] = map[string]interface{}{"target": map[string]interface{}{"kind": "position", "position": map[string]float64{"latitude": 10}}}
		}},
		{"invalid-coordinate", func(v map[string]interface{}) {
			v["input"] = map[string]interface{}{"target": map[string]interface{}{"kind": "position", "position": map[string]float64{"latitude": 120, "longitude": 10}}}
		}},
		{"unsupported-target", func(v map[string]interface{}) {
			v["input"] = map[string]interface{}{"target": map[string]interface{}{"kind": "geofeature", "geofeature_id": uuid.NewString()}}
		}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			body, err := json.Marshal(valid)
			if err != nil {
				t.Fatal(err)
			}
			var v map[string]interface{}
			if err = json.Unmarshal(body, &v); err != nil {
				t.Fatal(err)
			}
			test.mutate(v)
			f.request("POST", "/tasks", f.admin, v, 400)
		})
	}
	list := decode[protocol.TaskPageResponse](t, f.request("GET", "/tasks", f.admin, nil, 200))
	if len(list.Data.Items) != 0 {
		t.Fatal("invalid admission created Tasks")
	}
	noSupport, request := f.prepareRegistration()
	delete(request, "command_manifest")
	f.request("POST", "/entities", noSupport.secret, request, 201)
	valid["asset_id"] = noSupport.id
	valid["idempotency_key"] = uuid.NewString()
	f.request("POST", "/tasks", f.admin, valid, 422)
	f.request("POST", "/tasks", a.secret, valid, 403)
}

func TestDroppedSupportAllowsHistoricalFailureAndStatusDoesNotInferOutcome(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, _ := f.register()
	task := f.create(a)
	f.checkin(a)
	drop := f.reportBody(a, "checkin", a.id, "2", map[string]interface{}{"command_manifest": []interface{}{}}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	f.request("POST", "/entities/"+a.id+"/checkin", a.secret, drop, 200)
	request := map[string]interface{}{"asset_id": a.id, "idempotency_key": uuid.NewString(), "command": "move_to", "input": map[string]interface{}{"target": map[string]interface{}{"kind": "position", "position": map[string]float64{"latitude": 10, "longitude": 20}}}}
	f.request("POST", "/tasks", f.admin, request, 422)
	errorStatus := f.reportBody(a, "status_report", a.id, "3", map[string]interface{}{"status": map[string]string{"value": "error", "reason": "independent Asset fault"}}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	f.request("PATCH", "/entities/"+a.id+"/status", a.secret, errorStatus, 200)
	pending := decode[protocol.TaskResponse](t, f.request("GET", "/tasks/"+task.Id.String(), f.admin, nil, 200))
	if pending.Data.Status != "pending" {
		t.Fatal("Operational error invented Task failure")
	}
	failed := f.reportBody(a, "task_report", task.Id.String(), "4", map[string]interface{}{"kind": "report", "status": "failed", "failure": map[string]string{"code": "unsupported", "message": "Move To no longer supported"}}, false, "historical", map[string]string{"process_generation": "1", "sequence": "4"}, nil, "2026-01-01T00:00:00Z")
	outcome := decode[protocol.TaskReportResponse](t, f.request("PATCH", "/tasks/"+task.Id.String()+"/status", a.secret, failed, 200))
	if outcome.Data.Task.Status != "failed" || outcome.Data.Task.Failure.GetOrEmpty().Code != "unsupported" || outcome.Data.Acceptance.ContactRefreshed {
		t.Fatal("typed historical generic failure lost")
	}
}

func TestStatusReaffirmationAndDescriptiveEditUseIndependentBoundaries(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, _ := f.register()
	first := f.checkin(a)
	generated := time.Now().UTC().Format(time.RFC3339Nano)
	status := f.reportBody(a, "status_report", a.id, "2", map[string]interface{}{"status": map[string]string{"value": "ready"}}, false, "current", nil, nil, generated)
	second := decode[protocol.StatusReportResponse](t, f.request("PATCH", "/entities/"+a.id+"/status", a.secret, status, 200))
	if second.Data.Status.ReportedAt.GetOrEmpty() != generated || !second.Data.Status.ChangedAt.GetOrEmpty().Equal(first.Data.Entity.Components.Status.ChangedAt.GetOrEmpty()) {
		t.Fatal("same status changed value age or lost original report time")
	}
	edit := map[string]string{"expected_edit_revision": "1", "alias": "vehicle-alpha"}
	edited := decode[protocol.AssetMutationResponse](t, f.request("PATCH", "/entities/"+a.id, f.admin, edit, 200))
	if edited.Data.EditRevision != "2" || edited.Data.Components.Status.ReportedAt.GetOrEmpty() != generated {
		t.Fatal("Contact report invalidated descriptive edit or edit overwrote report")
	}
	f.request("PATCH", "/entities/"+a.id, f.admin, edit, 409)
	f.request("PATCH", "/entities/"+a.id, a.secret, map[string]string{"expected_edit_revision": "2", "alias": "wrong"}, 403)
	byAlias := decode[protocol.AssetResponse](t, f.request("GET", "/entities/alias/VEHICLE-ALPHA", f.admin, nil, 200))
	if byAlias.Data.Id != edited.Data.Id {
		t.Fatal("Alias lookup is not case insensitive")
	}
}

func TestHistoryPaginationAndUnknownEvidenceIdentity(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, _ := f.register()
	f.checkin(a)
	evidence := uuid.NewString()
	body := f.reportBody(a, "entity_report", a.id, "2", map[string]interface{}{"components": map[string]interface{}{"telemetry": map[string]float64{"speed_mps": 2}}}, false, "historical", nil, evidence, nil)
	first := decode[protocol.EntityReportResponse](t, f.request("PATCH", "/entities/"+a.id, a.secret, body, 200))
	if first.Data.Entity.Components.Telemetry != nil || len(first.Data.Acceptance.MovementSampleIds) != 1 || first.Data.Acceptance.ContactRefreshed {
		t.Fatal("unknown original evidence replaced current components")
	}
	retry := f.reportBody(a, "entity_report", a.id, "3", map[string]interface{}{"components": map[string]interface{}{"telemetry": map[string]float64{"speed_mps": 2}}}, false, "historical", nil, evidence, nil)
	recovered := decode[protocol.EntityReportResponse](t, f.request("PATCH", "/entities/"+a.id, a.secret, retry, 200))
	if len(recovered.Data.Acceptance.MovementSampleIds) != 0 {
		t.Fatal("repackaged evidence duplicated movement")
	}
	conflict := f.reportBody(a, "entity_report", a.id, "4", map[string]interface{}{"components": map[string]interface{}{"telemetry": map[string]float64{"speed_mps": 3}}}, false, "historical", nil, evidence, nil)
	f.request("PATCH", "/entities/"+a.id, a.secret, conflict, 409)
	current := f.reportBody(a, "entity_report", a.id, "5", map[string]interface{}{"components": map[string]interface{}{"telemetry": map[string]float64{"speed_mps": 4}}}, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
	f.request("PATCH", "/entities/"+a.id, a.secret, current, 200)
	path := "/entities/" + a.id + "/movement-history?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z&limit=1"
	page1 := decode[protocol.MovementPageResponse](t, f.request("GET", path, f.admin, nil, 200))
	if len(page1.Data.Items) != 1 || page1.Data.NextCursor.IsNull() {
		t.Fatal("history did not return safe continuation")
	}
	page2 := decode[protocol.MovementPageResponse](t, f.request("GET", path+"&cursor="+url.QueryEscape(page1.Data.NextCursor.GetOrEmpty()), f.admin, nil, 200))
	if len(page2.Data.Items) != 1 || page1.Data.Items[0].Id == page2.Data.Items[0].Id || !page2.Data.NextCursor.IsNull() {
		t.Fatal("history pagination duplicated or skipped retained sample")
	}
	observed := decode[protocol.MovementPageResponse](t, f.request("GET", path+"&time_basis=observed_at", f.admin, nil, 200))
	if len(observed.Data.Items) != 0 {
		t.Fatal("unknown original observation time inherited receipt time")
	}
}
