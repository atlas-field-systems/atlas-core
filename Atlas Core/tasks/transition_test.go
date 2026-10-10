package tasks_test

import (
	"errors"
	"testing"

	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/tasks"
	"github.com/google/uuid"
	"github.com/oapi-codegen/nullable"
)

func TestTransitionKeepsCancellationIntentSeparateFromExecution(t *testing.T) {
	requestID := uuid.New()
	current := protocol.Task{Status: "cancellation_requested", ExecutionStatus: "in_progress", ExecutionId: nullable.NewNullNullable[protocol.Identifier](), CancellationRequests: []protocol.CancellationRequest{{RequestId: requestID, Outcome: "pending"}}}
	desired := protocol.ExecutionStatus("in_progress")
	declined, changed, err := tasks.Transition(current, protocol.TaskReportRequest{Status: &desired, CancellationResponse: &protocol.CancellationResponse{RequestId: requestID, Outcome: "declined"}}, true)
	if err != nil || !changed || declined.Status != "in_progress" || declined.ExecutionStatus != "in_progress" || declined.CancellationRequests[0].Outcome != "declined" {
		t.Fatalf("decline lost execution: %#v %v", declined, err)
	}
	if current.CancellationRequests[0].Outcome != "pending" {
		t.Fatal("transition mutated caller facts")
	}
	completed := protocol.ExecutionStatus("completed")
	finished, changed, err := tasks.Transition(current, protocol.TaskReportRequest{Status: &completed}, true)
	if err != nil || !changed || finished.Status != "completed" || finished.CancellationRequests[0].Outcome != "superseded" {
		t.Fatalf("completion did not win: %#v %v", finished, err)
	}
	cancelled := protocol.ExecutionStatus("cancelled")
	_, _, err = tasks.Transition(finished, protocol.TaskReportRequest{Status: &cancelled, CancellationResponse: &protocol.CancellationResponse{RequestId: requestID, Outcome: "confirmed"}}, true)
	if !errors.Is(err, tasks.ErrTerminal) {
		t.Fatalf("late cancellation changed terminal outcome: %v", err)
	}
}

func TestTransitionRequiresAssetOutcomeAndRespectsEvidenceOrder(t *testing.T) {
	current := protocol.Task{Status: "in_progress", ExecutionStatus: "in_progress", ExecutionId: nullable.NewNullNullable[protocol.Identifier](), Progress: nullable.NewNullNullable[protocol.MoveToProgress](), CancellationRequests: []protocol.CancellationRequest{}}
	distance := 4.9
	event := protocol.TaskReportRequest{Progress: nullable.NewNullableWithValue(protocol.MoveToProgress{DistanceRemainingM: &distance})}
	next, changed, err := tasks.Transition(current, event, true)
	if err != nil || !changed || next.Status != "in_progress" {
		t.Fatalf("progress inferred arrival: %#v %v", next, err)
	}
	completed := protocol.ExecutionStatus("completed")
	old, changed, err := tasks.Transition(current, protocol.TaskReportRequest{Status: &completed}, false)
	if err != nil || changed || old.Status != "in_progress" {
		t.Fatal("old Task evidence replaced current lifecycle")
	}
	regressed := protocol.ExecutionStatus("acknowledged")
	_, _, err = tasks.Transition(current, protocol.TaskReportRequest{Status: &regressed}, true)
	if !errors.Is(err, tasks.ErrTransition) {
		t.Fatalf("execution regressed: %v", err)
	}
	failed := protocol.ExecutionStatus("failed")
	_, _, err = tasks.Transition(current, protocol.TaskReportRequest{Status: &failed}, true)
	if !errors.Is(err, tasks.ErrTransition) {
		t.Fatal("untyped failure accepted")
	}
}
