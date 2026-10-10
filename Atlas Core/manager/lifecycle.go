package manager

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/atlas-field-systems/atlas-core/corerun"
	"github.com/atlas-field-systems/atlas-core/system"
	"github.com/google/uuid"
)

func (i Installation) hello(ctx context.Context) (corerun.Reply, error) {
	callCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return corerun.Call(callCtx, i.socket(), corerun.Request{Action: corerun.ActionHello})
}

// call sends a private request to the current run after checking its
// installation identity, so controls never reach a stale or foreign run.
func (i Installation) call(ctx context.Context, request corerun.Request) (corerun.Reply, error) {
	hello, err := i.hello(ctx)
	if err != nil {
		return hello, err
	}
	record, err := i.record()
	if err != nil {
		return hello, err
	}
	if hello.InstallationID != record.InstallationID {
		return hello, errors.New("the private socket belongs to another installation")
	}
	request.RunID = hello.RunID
	callCtx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	return corerun.Call(callCtx, i.socket(), request)
}

// stopCore asks Core for an orderly stop, then verifies container exit. A
// Core that cannot be reached is stopped through Docker. Unverified exit is
// reported as an incomplete stop rather than success.
func (i Installation) stopCore(ctx context.Context) error {
	_, running, err := i.containerState(ctx)
	if err != nil {
		return err
	}
	var stopErr error
	if running {
		if _, err := i.call(ctx, corerun.Request{Action: corerun.ActionStop}); err != nil && !errors.Is(err, corerun.ErrUnreachable) {
			stopErr = fmt.Errorf("Core reported an incomplete stop: %w", err)
		}
	}
	if err := i.stopContainer(ctx); err != nil {
		return errors.Join(stopErr, fmt.Errorf("stop incomplete: %w", err))
	}
	return stopErr
}

// Status is the local inspection result.
type Status struct {
	InstallationID string                 `json:"installation_id"`
	Running        bool                   `json:"running"`
	CoreState      string                 `json:"core_state,omitempty"`
	CoreRelease    string                 `json:"core_release,omitempty"`
	Establishment  *corerun.Establishment `json:"establishment,omitempty"`
	Pending        []ActionRecord         `json:"pending_actions"`
	LastReset      *ActionRecord          `json:"last_reset,omitempty"`
}

// Inspect reports runtime, establishment and retained action state without
// performing lifecycle work.
func Inspect(ctx context.Context, installation Installation) (Status, error) {
	record, err := installation.record()
	if err != nil {
		return Status{}, err
	}
	status := Status{InstallationID: record.InstallationID, Pending: []ActionRecord{}}
	_, status.Running, err = installation.containerState(ctx)
	if err != nil {
		return status, err
	}
	if status.Running {
		if reply, err := installation.call(ctx, corerun.Request{Action: corerun.ActionInspect}); err == nil {
			status.CoreState, status.CoreRelease, status.Establishment = reply.State, reply.CoreRelease, reply.Establishment
		}
	}
	actions, err := installation.actions(record.InstallationID)
	if err != nil {
		return status, err
	}
	for _, action := range actions {
		action := action
		switch {
		case !action.Terminal():
			status.Pending = append(status.Pending, action)
		case action.Kind == KindReset:
			status.LastReset = &action
		}
	}
	return status, nil
}

// Result reports one lifecycle action's outcome.
type Result struct {
	ActionID  string `json:"action_id"`
	Kind      string `json:"kind"`
	Outcome   string `json:"outcome"`
	DatasetID string `json:"dataset_id,omitempty"`
	ResetID   string `json:"reset_id,omitempty"`
	// Replayed: an identical retry returned the retained completed result
	// without performing lifecycle work.
	Replayed bool `json:"replayed"`
}

// Start opens Core with its retained Dataset, first resuming any pending
// Reset or incomplete stop so serving never starts over partial state.
func Start(ctx context.Context, installation Installation) (Result, error) {
	record, err := installation.record()
	if err != nil {
		return Result{}, err
	}
	lock, err := installation.acquire("")
	if err != nil {
		return Result{}, err
	}
	defer func() { _ = lock.release() }()
	pending, err := installation.pendingReset(record.InstallationID)
	if err != nil {
		return Result{}, err
	}
	if pending != nil {
		return installation.resumeReset(ctx, record, pending)
	}
	actionID := uuid.NewString()
	reply, err := installation.startAndOpen(ctx, "")
	if err != nil {
		return Result{ActionID: actionID, Kind: KindStart, Outcome: "failed"}, err
	}
	installation.recordServing(ctx, newActivity("core.start", "installation", record.InstallationID, "serving", map[string]any{"dataset_id": reply.Establishment.DatasetID}))
	return Result{ActionID: actionID, Kind: KindStart, Outcome: "serving", DatasetID: reply.Establishment.DatasetID}, nil
}

// startAndOpen starts the Core container if needed and asks it to open. A
// failed opening keeps serving disabled and leaves data untouched.
func (i Installation) startAndOpen(ctx context.Context, resetID string) (corerun.Reply, error) {
	_, running, err := i.containerState(ctx)
	if err != nil {
		return corerun.Reply{}, err
	}
	if running {
		if hello, err := i.hello(ctx); err == nil && hello.State == corerun.StateServing {
			reply, err := i.call(ctx, corerun.Request{Action: corerun.ActionInspect})
			if err != nil {
				return reply, err
			}
			if resetID == "" || reply.Establishment.ResetID == resetID {
				return reply, nil
			}
			if err := i.stopCore(ctx); err != nil {
				return reply, err
			}
		}
	}
	if err := i.startContainer(ctx); err != nil {
		return corerun.Reply{}, err
	}
	if err := i.waitForPrivate(ctx, 30*time.Second); err != nil {
		return corerun.Reply{}, err
	}
	reply, err := i.call(ctx, corerun.Request{Action: corerun.ActionOpen, ResetID: resetID})
	if err != nil {
		// Serving stays disabled; stop the maintenance run so no writer is
		// left behind, and report the refusal.
		return reply, errors.Join(fmt.Errorf("Core refused to open: %w", err), i.stopCore(ctx))
	}
	return reply, nil
}

// recordServing records local activity through Core while it serves. A
// recording failure is reported in the diagnostic output only.
func (i Installation) recordServing(ctx context.Context, entry system.JournalEntry) {
	if _, err := i.call(ctx, corerun.Request{Action: corerun.ActionRecordActivity, Activity: &entry}); err != nil {
		fmt.Fprintf(os.Stderr, "warning: local activity %s was not recorded: %v\n", entry.Action, err)
	}
}

// Stop stops Core after it joins every writer. Unverified exit is reported as
// incomplete and blocks nothing it did not claim.
func Stop(ctx context.Context, installation Installation) (Result, error) {
	record, err := installation.record()
	if err != nil {
		return Result{}, err
	}
	lock, err := installation.acquire("")
	if err != nil {
		return Result{}, err
	}
	defer func() { _ = lock.release() }()
	return installation.stop(ctx, record)
}

func (i Installation) stop(ctx context.Context, record Record) (Result, error) {
	actionID := uuid.NewString()
	_, running, err := i.containerState(ctx)
	if err != nil {
		return Result{}, err
	}
	if running {
		if hello, err := i.hello(ctx); err == nil && hello.State == corerun.StateServing {
			i.recordServing(ctx, newActivity("core.stop", "installation", record.InstallationID, "accepted", nil))
		}
	}
	if err := i.stopCore(ctx); err != nil {
		incomplete := ActionRecord{ActionID: actionID, Kind: KindStop, InstallationID: record.InstallationID, Phase: PhaseIncomplete, Image: record.Image, Error: err.Error()}
		return Result{ActionID: actionID, Kind: KindStop, Outcome: "stop_incomplete"}, errors.Join(err, i.saveAction(&incomplete))
	}
	if err := i.clearIncompleteStops(record.InstallationID); err != nil {
		return Result{}, err
	}
	if !running {
		return Result{ActionID: actionID, Kind: KindStop, Outcome: "already_stopped"}, nil
	}
	return Result{ActionID: actionID, Kind: KindStop, Outcome: "stopped"}, nil
}

// clearIncompleteStops completes earlier incomplete stops once exit is
// verified.
func (i Installation) clearIncompleteStops(installationID string) error {
	actions, err := i.actions(installationID)
	if err != nil {
		return err
	}
	for _, action := range actions {
		if action.Kind == KindStop && action.Phase == PhaseIncomplete {
			action.Phase, action.Outcome = PhaseCompleted, "stopped"
			if err := i.saveAction(&action); err != nil {
				return err
			}
		}
	}
	return nil
}

// Restart stops and starts Core, retaining its Dataset and setup.
func Restart(ctx context.Context, installation Installation) (Result, error) {
	record, err := installation.record()
	if err != nil {
		return Result{}, err
	}
	lock, err := installation.acquire("")
	if err != nil {
		return Result{}, err
	}
	defer func() { _ = lock.release() }()
	if _, err := installation.stop(ctx, record); err != nil {
		return Result{}, err
	}
	pending, err := installation.pendingReset(record.InstallationID)
	if err != nil {
		return Result{}, err
	}
	if pending != nil {
		return installation.resumeReset(ctx, record, pending)
	}
	reply, err := installation.startAndOpen(ctx, "")
	if err != nil {
		return Result{Kind: KindRestart, Outcome: "failed"}, err
	}
	installation.recordServing(ctx, newActivity("core.restart", "installation", record.InstallationID, "serving", map[string]any{"dataset_id": reply.Establishment.DatasetID}))
	return Result{ActionID: uuid.NewString(), Kind: KindRestart, Outcome: "serving", DatasetID: reply.Establishment.DatasetID}, nil
}

// ErrResultNotRetained reports a Reset action whose completed result is no
// longer retained; nothing was executed.
var ErrResultNotRetained = errors.New("result_no_longer_retained")

func (i Installation) pendingReset(installationID string) (*ActionRecord, error) {
	actions, err := i.actions(installationID)
	if err != nil {
		return nil, err
	}
	for _, action := range actions {
		if action.Kind == KindReset && !action.Terminal() {
			return &action, nil
		}
	}
	return nil, nil
}

// Reset clears the operational Dataset and Atlas-managed logs and starts Core
// with a new Dataset, retaining installation setup. actionID identifies the
// request: retrying a completed action returns its retained result without
// lifecycle effects, and a pending action resumes without repeating
// destructive work after establishment.
func Reset(ctx context.Context, installation Installation, actionID string) (Result, error) {
	record, err := installation.record()
	if err != nil {
		return Result{}, err
	}
	if actionID == "" {
		actionID = uuid.NewString()
	}
	if _, err := uuid.Parse(actionID); err != nil {
		return Result{}, fmt.Errorf("action identity must be a UUID: %w", err)
	}
	lock, err := installation.acquire(actionID)
	if err != nil {
		return Result{}, err
	}
	defer func() { _ = lock.release() }()
	existing, loadErr := installation.loadAction(actionID)
	switch {
	case loadErr == nil && existing.Kind != KindReset:
		return Result{}, fmt.Errorf("action %s is not a Reset", actionID)
	case loadErr == nil && existing.Terminal():
		return Result{ActionID: actionID, Kind: KindReset, Outcome: existing.Outcome, DatasetID: existing.DatasetID, ResetID: existing.ResetID, Replayed: true}, nil
	case loadErr == nil:
		return installation.resumeReset(ctx, record, &existing)
	case !errors.Is(loadErr, os.ErrNotExist):
		return Result{}, loadErr
	}
	if pending, err := installation.pendingReset(record.InstallationID); err != nil {
		return Result{}, err
	} else if pending != nil {
		return Result{}, &ErrBusy{ActiveAction: pending.ActionID}
	}
	if installation.wasRetained(actionID) {
		return Result{ActionID: actionID, Kind: KindReset}, ErrResultNotRetained
	}
	// Accepting a new Reset durably replaces the previous completed result
	// with this pending directive before anything stops.
	action := ActionRecord{ActionID: actionID, Kind: KindReset, InstallationID: record.InstallationID, Phase: PhasePending, Image: record.Image, ResetID: uuid.NewString()}
	if err := installation.saveAction(&action); err != nil {
		return Result{}, err
	}
	if err := installation.retireCompletedResets(record.InstallationID, actionID); err != nil {
		return Result{}, err
	}
	return installation.resumeReset(ctx, record, &action)
}

// wasRetained reports whether an action identity was used before and its
// result has since been replaced.
func (i Installation) wasRetained(actionID string) bool {
	_, err := os.Stat(filepath.Join(i.actionsDir(), "replaced", actionID))
	return err == nil
}

func (i Installation) retireCompletedResets(installationID, keep string) error {
	actions, err := i.actions(installationID)
	if err != nil {
		return err
	}
	replaced := filepath.Join(i.actionsDir(), "replaced")
	if err := os.MkdirAll(replaced, 0o700); err != nil {
		return fmt.Errorf("create replaced-action markers: %w", err)
	}
	for _, action := range actions {
		if action.Kind != KindReset || action.ActionID == keep || !action.Terminal() {
			continue
		}
		if err := writeDurable(filepath.Join(replaced, action.ActionID), nil, 0o600); err != nil {
			return err
		}
		if err := os.Remove(i.actionPath(action.ActionID)); err != nil {
			return fmt.Errorf("replace completed Reset result: %w", err)
		}
	}
	return syncDirectory(i.actionsDir())
}

// resumeReset drives a pending Reset to completion. Core's recorded Reset
// identity is the establishment proof: before it, stopped-writer cleanup is
// safe to repeat; after it, Core opens retained and new work is preserved.
func (i Installation) resumeReset(ctx context.Context, record Record, action *ActionRecord) (Result, error) {
	result := Result{ActionID: action.ActionID, Kind: KindReset, ResetID: action.ResetID}
	if err := i.stopCore(ctx); err != nil {
		return result, fmt.Errorf("Reset remains pending: %w", err)
	}
	established, err := i.established(ctx, action.ResetID)
	if err != nil {
		return result, fmt.Errorf("Reset establishment is unknown; it remains pending: %w", err)
	}
	if !established {
		// With every writer stopped, clear Atlas-managed logs (including
		// Docker's, by removing the stopped container) and the pending local
		// activity journal before Core can record the new Reset identity.
		if err := i.removeContainer(ctx); err != nil {
			return result, fmt.Errorf("Reset cleanup incomplete: %w", err)
		}
		action.CompletedTargets = appendOnce(action.CompletedTargets, "docker_logs")
		for _, target := range []string{"logs", "journal"} {
			if err := clearDirectory(filepath.Join(i.Root, target)); err != nil {
				action.Error = err.Error()
				return result, errors.Join(fmt.Errorf("Reset cleanup incomplete: %w", err), i.saveAction(action))
			}
			action.CompletedTargets = appendOnce(action.CompletedTargets, target)
		}
		action.Phase = PhaseCleaned
		if err := i.saveAction(action); err != nil {
			return result, err
		}
	}
	reply, err := i.startAndOpen(ctx, action.ResetID)
	if err != nil {
		action.Error = err.Error()
		return result, errors.Join(fmt.Errorf("Reset remains pending: %w", err), i.saveAction(action))
	}
	if reply.Establishment.ResetID != action.ResetID {
		return result, errors.New("Core did not establish the Reset identity; Reset remains pending")
	}
	action.Phase, action.DatasetID = PhaseEstablished, reply.Establishment.DatasetID
	if err := i.saveAction(action); err != nil {
		return result, err
	}
	// S1 has no managed Plugins; every compatible enabled Plugin's startup
	// outcome is therefore accounted for once Core serves.
	// The activity shares the Reset action's identity, so resuming after an
	// interruption records it once.
	activity := newActivity("core.reset", "installation", record.InstallationID, "completed", map[string]any{"dataset_id": action.DatasetID})
	activity.ActionID = action.ActionID
	i.recordServing(ctx, activity)
	action.Phase, action.Outcome, action.Error = PhaseCompleted, "completed", ""
	if err := i.saveAction(action); err != nil {
		return result, err
	}
	result.Outcome, result.DatasetID = action.Outcome, action.DatasetID
	return result, nil
}

// established asks Core, in maintenance if necessary, whether the Reset
// identity is recorded. A missing answer is never proof of nonestablishment.
func (i Installation) established(ctx context.Context, resetID string) (bool, error) {
	if err := i.startContainer(ctx); err != nil {
		return false, err
	}
	if err := i.waitForPrivate(ctx, 30*time.Second); err != nil {
		return false, err
	}
	reply, err := i.call(ctx, corerun.Request{Action: corerun.ActionInspect})
	stopErr := i.stopCore(ctx)
	if err != nil {
		return false, errors.Join(err, stopErr)
	}
	if stopErr != nil {
		return false, stopErr
	}
	return reply.Establishment != nil && reply.Establishment.ResetID == resetID, nil
}

func appendOnce(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

// clearDirectory removes an owned directory's contents, refusing symlinks
// that could escape the installation root, and syncs the result.
func clearDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("inspect owned directory: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("owned target %s is not a directory", path)
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return fmt.Errorf("list owned directory: %w", err)
	}
	for _, entry := range entries {
		if err := os.RemoveAll(filepath.Join(path, entry.Name())); err != nil {
			return fmt.Errorf("remove owned content: %w", err)
		}
	}
	remaining, err := os.ReadDir(path)
	if err != nil || len(remaining) != 0 {
		return fmt.Errorf("owned directory %s is not empty after cleanup", path)
	}
	return syncDirectory(path)
}

// Activity lists the current Dataset's activity through Core.
func Activity(ctx context.Context, installation Installation) ([]system.ActivityRecord, error) {
	reply, err := installation.call(ctx, corerun.Request{Action: corerun.ActionActivity})
	return reply.Activity, err
}

// ArmFault arms a private test fault in a Core run started with test faults.
func ArmFault(ctx context.Context, installation Installation, operation string, count int) error {
	_, err := installation.call(ctx, corerun.Request{Action: corerun.ActionArmFault, Operation: operation, Count: count})
	return err
}
