// Package tasks owns Task admission, requested order and reported outcomes.
package tasks

import (
	"encoding/json"
	"errors"
	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"slices"
)

var ErrTransition = errors.New("invalid_task_transition")
var ErrTerminal = errors.New("terminal_task")
var ErrUnsupported = errors.New("unsupported_command")

func Terminal(status protocol.TaskStatus) bool {
	return status == "completed" || status == "failed" || status == "cancelled"
}

// Transition records assigned-Asset evidence. It never chooses arrival or
// execution permission, and cancellation intent remains separate from execution.
func Transition(current protocol.Task, event protocol.TaskReportRequest, newer bool) (protocol.Task, bool, error) {
	next := current
	next.CancellationRequests = slices.Clone(current.CancellationRequests)
	hasFacts := event.Status != nil || event.Progress.IsSpecified() || event.Failure.IsSpecified() || event.ExecutionId != nil || event.AcknowledgedAt.IsSpecified() || event.StartedAt.IsSpecified() || event.FinishedAt.IsSpecified() || event.CancellationResponse != nil
	if !hasFacts {
		return current, false, ErrTransition
	}
	if event.Status != nil && *event.Status == "failed" && (event.Failure.IsNull() || !event.Failure.IsSpecified()) {
		return current, false, ErrTransition
	}
	if event.Failure.IsSpecified() && !event.Failure.IsNull() && (event.Status == nil || *event.Status != "failed") {
		return current, false, ErrTransition
	}
	if event.Status != nil && *event.Status == "cancelled" && event.CancellationResponse == nil {
		return current, false, ErrTransition
	}
	if event.ExecutionId != nil && !current.ExecutionId.IsNull() && current.ExecutionId.GetOrEmpty() != *event.ExecutionId {
		return current, false, ErrTransition
	}
	if Terminal(current.Status) {
		if event.Status != nil && protocol.TaskStatus(*event.Status) != current.Status {
			return current, false, ErrTerminal
		}
		if event.CancellationResponse != nil && event.CancellationResponse.Outcome == "declined" {
			return current, false, ErrTerminal
		}
		if event.Failure.IsSpecified() {
			before, _ := json.Marshal(current.Failure)
			after, _ := json.Marshal(event.Failure)
			if string(before) != string(after) {
				return current, false, ErrTerminal
			}
		}
		if event.FinishedAt.IsSpecified() && event.FinishedAt.GetOrEmpty() != current.FinishedAt.GetOrEmpty() {
			return current, false, ErrTerminal
		}
		return current, false, nil
	}
	if !newer {
		return current, false, nil
	}
	if event.Status != nil {
		desired := *event.Status
		previous := current.ExecutionStatus
		rank := func(status protocol.ExecutionStatus) int {
			switch status {
			case "pending":
				return 0
			case "acknowledged":
				return 1
			case "in_progress", "paused":
				return 2
			case "completed", "failed", "cancelled":
				return 3
			}
			return -1
		}
		if rank(desired) < 0 || rank(desired) < rank(previous) {
			return current, false, ErrTransition
		}
		if desired == "cancelled" {
			if current.Status != "cancellation_requested" || event.CancellationResponse.Outcome != "confirmed" {
				return current, false, ErrTransition
			}
		}
		next.ExecutionStatus = desired
		if current.Status != "cancellation_requested" || rank(desired) == 3 {
			next.Status = protocol.TaskStatus(desired)
		}
	}
	if event.Progress.IsSpecified() {
		next.Progress = event.Progress
	}
	if event.Failure.IsSpecified() {
		next.Failure = event.Failure
	}
	if event.ExecutionId != nil {
		next.ExecutionId.Set(*event.ExecutionId)
	}
	if event.AcknowledgedAt.IsSpecified() {
		next.AcknowledgedAt = event.AcknowledgedAt
	}
	if event.StartedAt.IsSpecified() {
		next.StartedAt = event.StartedAt
	}
	if event.FinishedAt.IsSpecified() {
		next.FinishedAt = event.FinishedAt
	}
	if event.CancellationResponse != nil {
		response := event.CancellationResponse
		index := -1
		for i, request := range next.CancellationRequests {
			if request.RequestId == response.RequestId {
				index = i
				break
			}
		}
		if index < 0 || next.CancellationRequests[index].Outcome != "pending" {
			return current, false, ErrTransition
		}
		if response.Outcome == "confirmed" {
			if event.Status != nil && *event.Status != "cancelled" {
				return current, false, ErrTransition
			}
			next.Status = "cancelled"
			next.ExecutionStatus = "cancelled"
			next.CancellationRequests[index].Outcome = "confirmed"
		} else {
			next.Status = protocol.TaskStatus(next.ExecutionStatus)
			next.CancellationRequests[index].Outcome = "declined"
		}
	}
	if Terminal(next.Status) {
		for i, request := range next.CancellationRequests {
			if request.Outcome == "pending" {
				next.CancellationRequests[i].Outcome = "superseded"
			}
		}
	}
	before, err := json.Marshal(current)
	if err != nil {
		return current, false, err
	}
	after, err := json.Marshal(next)
	if err != nil {
		return current, false, err
	}
	return next, string(before) != string(after), nil
}
