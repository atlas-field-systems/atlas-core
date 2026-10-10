package tasks

import (
	"slices"

	"github.com/atlas-field-systems/atlas-core/coreerr"
)

// Status is a Task lifecycle status.
type Status string

const (
	Pending               Status = "pending"
	Acknowledged          Status = "acknowledged"
	InProgress            Status = "in_progress"
	Paused                Status = "paused"
	CancellationRequested Status = "cancellation_requested"
	Completed             Status = "completed"
	Failed                Status = "failed"
	Cancelled             Status = "cancelled"
)

// Terminal reports whether a status is a terminal outcome.
func (s Status) Terminal() bool { return s == Completed || s == Failed || s == Cancelled }

// unstarted reports whether execution has not started.
func (s Status) unstarted() bool { return s == Pending || s == Acknowledged }

// State is the transition module's view of one Task. Execution is the status
// established by accepted Asset reports; Status additionally carries
// unresolved cancellation intent.
type State struct {
	Status                Status
	Execution             Status
	PendingCancellation   string
	ConfirmedCancellation string
	DeclinedCancellations []string
}

// EventKind names an instruction or an accepted Asset report.
type EventKind string

const (
	RequestCancellation   EventKind = "request_cancellation"
	ReportAcknowledged    EventKind = "acknowledged"
	ReportStarted         EventKind = "started"
	ReportProgress        EventKind = "progress"
	ReportCompleted       EventKind = "completed"
	ReportFailed          EventKind = "failed"
	CancellationConfirmed EventKind = "cancellation_confirmed"
	CancellationDeclined  EventKind = "cancellation_declined"
)

// Event is one transition input. CancellationID identifies the request for
// cancellation instructions, confirmation and decline.
type Event struct {
	Kind           EventKind
	CancellationID string
}

// Resolution is the effect on a cancellation request.
type Resolution string

const (
	NoResolution Resolution = ""
	Requested    Resolution = "requested"
	Confirmed    Resolution = "confirmed"
	Declined     Resolution = "declined"
	Closed       Resolution = "closed"
)

// Decision is the next state and the facts the caller persists. The module
// never schedules execution or infers outcomes; it judges recorded evidence.
type Decision struct {
	Next       State
	Changed    bool
	Resolution Resolution
	// Started: execution started now, so the Task leaves eligible order.
	Started bool
	// Restored: a declined cancellation returns unstarted work to its slot.
	Restored bool
	// Terminal: the Task reached a terminal outcome now.
	Terminal bool
}

func reject(code, message string) *coreerr.Error { return coreerr.Conflict(code, message) }

// Apply decides one transition. Reports may skip intermediate states but never
// move execution backward; terminal outcomes are immutable; cancellation
// intent resolves only through confirmation, decline or another outcome.
func Apply(state State, event Event) (Decision, error) {
	decision := Decision{Next: state}
	next := &decision.Next
	switch event.Kind {
	case RequestCancellation:
		if state.Status.Terminal() {
			return decision, reject("task_terminal", "The Task already has a terminal outcome")
		}
		if state.Status == CancellationRequested {
			return decision, reject("cancellation_already_requested", "A cancellation request is already unresolved").With("cancellation_id", state.PendingCancellation)
		}
		next.Status, next.PendingCancellation = CancellationRequested, event.CancellationID
		decision.Changed, decision.Resolution = true, Requested
	case ReportAcknowledged, ReportStarted:
		target := Acknowledged
		if event.Kind == ReportStarted {
			target = InProgress
		}
		if state.Status.Terminal() || rank(state.Execution) >= rank(target) {
			return decision, nil
		}
		decision.Started = target == InProgress
		next.Execution = target
		if state.Status != CancellationRequested {
			next.Status = target
		}
		decision.Changed = true
	case ReportProgress:
		// Progress preserves status; its values follow the execution stream's
		// ordering, decided by the caller.
	case ReportCompleted, ReportFailed:
		outcome := Completed
		if event.Kind == ReportFailed {
			outcome = Failed
		}
		if state.Status.Terminal() {
			if state.Status == outcome {
				return decision, nil
			}
			return decision, reject("terminal_conflict", "A conflicting report cannot change the recorded terminal outcome")
		}
		next.Status, next.Execution = outcome, outcome
		if state.PendingCancellation != "" {
			decision.Resolution = Closed
			next.PendingCancellation = ""
		}
		decision.Changed, decision.Terminal = true, true
	case CancellationConfirmed:
		if state.Status == Cancelled && state.ConfirmedCancellation == event.CancellationID {
			return decision, nil
		}
		if state.Status.Terminal() {
			return decision, reject("terminal_conflict", "A conflicting report cannot change the recorded terminal outcome")
		}
		if state.Status != CancellationRequested || state.PendingCancellation != event.CancellationID {
			return decision, reject("cancellation_not_pending", "The identified cancellation request is not awaiting a decision")
		}
		next.Status, next.Execution = Cancelled, Cancelled
		next.PendingCancellation, next.ConfirmedCancellation = "", event.CancellationID
		decision.Changed, decision.Terminal, decision.Resolution = true, true, Confirmed
	case CancellationDeclined:
		if slices.Contains(state.DeclinedCancellations, event.CancellationID) {
			return decision, nil
		}
		if state.Status != CancellationRequested || state.PendingCancellation != event.CancellationID {
			return decision, reject("cancellation_not_pending", "The identified cancellation request is not awaiting a decision")
		}
		next.Status, next.PendingCancellation = state.Execution, ""
		next.DeclinedCancellations = append(slices.Clone(state.DeclinedCancellations), event.CancellationID)
		decision.Changed, decision.Resolution, decision.Restored = true, Declined, state.Execution.unstarted()
	default:
		return decision, coreerr.Invalid("invalid_report", "Unknown Task event")
	}
	return decision, nil
}

// rank orders execution progress; a report never moves execution backward.
func rank(status Status) int {
	switch status {
	case Pending:
		return 0
	case Acknowledged:
		return 1
	case InProgress, Paused:
		return 2
	default:
		return 3
	}
}
