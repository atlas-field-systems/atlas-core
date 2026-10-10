package tasks

import (
	"fmt"
	"math/rand/v2"
	"slices"
	"testing"

	"github.com/atlas-field-systems/atlas-core/coreerr"
)

// This focused suite explores S1 Task transition sequences through the pure
// transition module, without SQLite, against an independently written
// reference model of the Task contract. It proves transition decisions only;
// the S1 workflows prove persistence, delivery, retries and recovery.

// model is the reference: execution progress never moves backward, terminal
// outcomes are immutable, cancellation is intent until the assigned Asset
// confirms or declines the pending request, and another outcome closes it.
type model struct {
	status    Status
	execution Status
	pending   string
	confirmed string
	declined  []string
}

func progress(status Status) int {
	return map[Status]int{Pending: 0, Acknowledged: 1, InProgress: 2}[status]
}

func terminal(status Status) bool {
	return status == Completed || status == Failed || status == Cancelled
}

// apply returns the rejection code, or "" when the event is accepted.
func (m *model) apply(event Event) string {
	switch event.Kind {
	case RequestCancellation:
		switch {
		case terminal(m.status):
			return "task_terminal"
		case m.pending != "":
			return "cancellation_already_requested"
		}
		m.pending, m.status = event.CancellationID, CancellationRequested
	case ReportAcknowledged, ReportStarted:
		next := Acknowledged
		if event.Kind == ReportStarted {
			next = InProgress
		}
		if terminal(m.execution) || progress(m.execution) >= progress(next) {
			return ""
		}
		m.execution = next
		if m.pending == "" {
			m.status = next
		}
	case ReportProgress:
	case ReportCompleted, ReportFailed:
		outcome := Completed
		if event.Kind == ReportFailed {
			outcome = Failed
		}
		if terminal(m.status) {
			if m.status == outcome {
				return ""
			}
			return "terminal_conflict"
		}
		m.status, m.execution, m.pending = outcome, outcome, ""
	case CancellationConfirmed:
		if m.status == Cancelled && m.confirmed == event.CancellationID {
			return ""
		}
		if terminal(m.status) {
			return "terminal_conflict"
		}
		if m.pending != event.CancellationID {
			return "cancellation_not_pending"
		}
		m.status, m.execution, m.confirmed, m.pending = Cancelled, Cancelled, event.CancellationID, ""
	case CancellationDeclined:
		if slices.Contains(m.declined, event.CancellationID) {
			return ""
		}
		if m.pending == "" || m.pending != event.CancellationID {
			return "cancellation_not_pending"
		}
		m.declined = append(m.declined, m.pending)
		m.pending, m.status = "", m.execution
	}
	return ""
}

func randomEvent(random *rand.Rand, requested []string) Event {
	kinds := []EventKind{RequestCancellation, ReportAcknowledged, ReportStarted, ReportProgress, ReportCompleted, ReportFailed, CancellationConfirmed, CancellationDeclined}
	kind := kinds[random.IntN(len(kinds))]
	switch kind {
	case RequestCancellation:
		return Event{Kind: kind, CancellationID: fmt.Sprintf("c%d", len(requested)+1)}
	case CancellationConfirmed, CancellationDeclined:
		// Mostly a request that exists; sometimes one that never did.
		if len(requested) > 0 && random.IntN(4) > 0 {
			return Event{Kind: kind, CancellationID: requested[random.IntN(len(requested))]}
		}
		return Event{Kind: kind, CancellationID: "unknown"}
	}
	return Event{Kind: kind}
}

func TestTransitionSequencesMatchReferenceModel(t *testing.T) {
	// Fixed seeds keep every failure reproducible; a failure names its seed
	// and step.
	for seed := uint64(1); seed <= 400; seed++ {
		random := rand.New(rand.NewPCG(seed, 2026))
		state := State{Status: Pending, Execution: Pending}
		reference := model{status: Pending, execution: Pending}
		var requested []string
		wasTerminal := false
		for index := 0; index < 24; index++ {
			event := randomEvent(random, requested)
			if event.Kind == RequestCancellation {
				requested = append(requested, event.CancellationID)
			}
			before := state
			decision, err := Apply(state, event)
			want := reference.apply(event)
			got := ""
			if err != nil {
				rejection, ok := coreerr.As(err)
				if !ok {
					t.Fatalf("seed %d step %d %+v: untyped error %v", seed, index, event, err)
				}
				got = rejection.Code
			}
			if got != want {
				t.Fatalf("seed %d step %d %+v from %+v: rejection %q, model %q", seed, index, event, before, got, want)
			}
			if err == nil {
				state = decision.Next
			}
			if state.Status != reference.status || state.Execution != reference.execution || state.PendingCancellation != reference.pending {
				t.Fatalf("seed %d step %d %+v: state %+v, model %+v", seed, index, event, state, reference)
			}
			if wasTerminal && state.Status != before.Status {
				t.Fatalf("seed %d step %d: terminal outcome %s changed to %s", seed, index, before.Status, state.Status)
			}
			if progress(state.Execution) < progress(before.Execution) && !terminal(state.Execution) {
				t.Fatalf("seed %d step %d: execution moved backward from %s to %s", seed, index, before.Execution, state.Execution)
			}
			if state.Status == Cancelled && before.Status != Cancelled && event.Kind != CancellationConfirmed {
				t.Fatalf("seed %d step %d: Task cancelled without the Asset's confirmation", seed, index)
			}
			wasTerminal = terminal(state.Status)
		}
	}
}

func TestTransitionDecisionFacts(t *testing.T) {
	cases := []struct {
		name  string
		state State
		event Event
		want  Decision
	}{
		{
			name:  "start leaves eligible order",
			state: State{Status: Acknowledged, Execution: Acknowledged},
			event: Event{Kind: ReportStarted},
			want:  Decision{Next: State{Status: InProgress, Execution: InProgress}, Changed: true, Started: true},
		},
		{
			name:  "decline restores unstarted work to its slot",
			state: State{Status: CancellationRequested, Execution: Acknowledged, PendingCancellation: "c1"},
			event: Event{Kind: CancellationDeclined, CancellationID: "c1"},
			want:  Decision{Next: State{Status: Acknowledged, Execution: Acknowledged, DeclinedCancellations: []string{"c1"}}, Changed: true, Resolution: Declined, Restored: true},
		},
		{
			name:  "decline keeps started work out of eligible order",
			state: State{Status: CancellationRequested, Execution: InProgress, PendingCancellation: "c1"},
			event: Event{Kind: CancellationDeclined, CancellationID: "c1"},
			want:  Decision{Next: State{Status: InProgress, Execution: InProgress, DeclinedCancellations: []string{"c1"}}, Changed: true, Resolution: Declined},
		},
		{
			name:  "completion before confirmation closes the request",
			state: State{Status: CancellationRequested, Execution: InProgress, PendingCancellation: "c1"},
			event: Event{Kind: ReportCompleted},
			want:  Decision{Next: State{Status: Completed, Execution: Completed}, Changed: true, Terminal: true, Resolution: Closed},
		},
		{
			name:  "acknowledgement while cancellation is pending keeps the request visible",
			state: State{Status: CancellationRequested, Execution: Pending, PendingCancellation: "c1"},
			event: Event{Kind: ReportAcknowledged},
			want:  Decision{Next: State{Status: CancellationRequested, Execution: Acknowledged, PendingCancellation: "c1"}, Changed: true},
		},
	}
	for _, test := range cases {
		got, err := Apply(test.state, test.event)
		if err != nil {
			t.Fatalf("%s: %v", test.name, err)
		}
		if fmt.Sprintf("%+v", got) != fmt.Sprintf("%+v", test.want) {
			t.Fatalf("%s: decision %+v, want %+v", test.name, got, test.want)
		}
	}
}
