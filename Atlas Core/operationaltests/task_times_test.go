package operationaltests_test

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/systemoperations"
	"github.com/google/uuid"
)

func TestTaskReportsPreserveOriginalExecutionTimes(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, _ := f.register()
	f.checkin(a)
	task := f.create(a)
	path := "/tasks/" + task.Id.String() + "/status"
	execution := uuid.NewString()
	report := func(sequence string, fields map[string]interface{}, want int) []byte {
		t.Helper()
		fields["kind"] = "report"
		fields["execution_id"] = execution
		body := f.reportBody(a, "task_report", task.Id.String(), sequence, fields, false, "current", nil, nil, time.Now().UTC().Format(time.RFC3339Nano))
		return f.request("PATCH", path, a.secret, body, want)
	}
	started := decode[protocol.TaskReportResponse](t, report("2", map[string]interface{}{"status": "in_progress"}, 200))
	if !started.Data.Task.StartedAt.IsNull() || !started.Data.Task.AcknowledgedAt.IsNull() {
		t.Fatal("report arrival invented unknown execution times")
	}
	acknowledgedAt := "2026-10-10T10:59:00.5000+00:00"
	startedAt := "2026-10-10T11:00:00.5000+00:00"
	finishedAt := "2026-10-10T11:10:00.5000+00:00"
	known := decode[protocol.TaskReportResponse](t, report("3", map[string]interface{}{"acknowledged_at": acknowledgedAt, "started_at": startedAt}, 200))
	if known.Data.Task.AcknowledgedAt.GetOrEmpty() != acknowledgedAt || known.Data.Task.StartedAt.GetOrEmpty() != startedAt {
		t.Fatal("later original evidence did not fill unknown times losslessly")
	}
	assertRejected := func(sequence, field string, value interface{}, want int) {
		t.Helper()
		beforeTask := decode[protocol.TaskResponse](t, f.request("GET", "/tasks/"+task.Id.String(), f.admin, nil, 200)).Data
		before, err := f.core.InspectEvidence(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		report(sequence, map[string]interface{}{field: value, "progress": map[string]float64{"distance_remaining_m": 1}}, want)
		afterTask := decode[protocol.TaskResponse](t, f.request("GET", "/tasks/"+task.Id.String(), f.admin, nil, 200)).Data
		after, err := f.core.InspectEvidence(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if before != after || !reflect.DeepEqual(beforeTask, afterTask) {
			t.Fatalf("rejected change to %s committed report or Task effects", field)
		}
	}
	for _, field := range []string{"acknowledged_at", "started_at"} {
		assertRejected("4", field, "2026-10-10T12:00:00Z", 422)
		assertRejected("4", field, nil, 422)
	}
	// Rejection must not consume the sequence. A sparse progress report still
	// succeeds and retains the already accepted source timestamp spellings.
	sparse := decode[protocol.TaskReportResponse](t, report("4", map[string]interface{}{"progress": map[string]float64{"distance_remaining_m": 5.1}}, 200))
	if sparse.Data.Task.StartedAt.GetOrEmpty() != startedAt || sparse.Data.Task.AcknowledgedAt.GetOrEmpty() != acknowledgedAt || sparse.Data.Task.Progress.GetOrEmpty().DistanceRemainingM == nil || *sparse.Data.Task.Progress.GetOrEmpty().DistanceRemainingM != 5.1 {
		t.Fatal("sparse progress report changed original execution times or failed to advance")
	}
	finished := decode[protocol.TaskReportResponse](t, report("5", map[string]interface{}{"status": "completed", "finished_at": finishedAt, "started_at": startedAt, "acknowledged_at": acknowledgedAt}, 200))
	if finished.Data.Task.Status != "completed" || finished.Data.Task.FinishedAt.GetOrEmpty() != finishedAt {
		t.Fatal("matching execution facts prevented completion")
	}
	for _, field := range []string{"acknowledged_at", "started_at", "finished_at"} {
		assertRejected("6", field, "2026-10-10T12:00:00Z", 409)
		assertRejected("6", field, nil, 409)
	}
}
