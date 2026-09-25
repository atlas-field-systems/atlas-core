package plugins

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/atlas-field-systems/atlas-core/core/internal/plugins/internal/operationsdb"
	"github.com/atlas-field-systems/atlas-core/core/internal/plugins/internal/registrydb"
	"github.com/atlas-field-systems/atlas-core/core/internal/problem"
)

// The private lifecycle channel between local management and Core.
const (
	// ManagementSecretHeader carries local management's secret.
	ManagementSecretHeader = "X-Atlas-Management-Secret"

	// ActionStarted follows starting a Plugin container.
	ActionStarted = "started"
	// ActionStopping precedes a planned stop: close admission, quiesce and
	// drain finite work.
	ActionStopping = "stopping"
	// ActionStopFailed follows a container that did not stop.
	ActionStopFailed = "stop-failed"
	// ActionForceStopping precedes killing a container.
	ActionForceStopping = "force-stopping"
	// ActionForceStopped follows killing a container.
	ActionForceStopped = "force-stopped"
)

// drainTimeout bounds a planned stop. Finite work that runs longer needs an
// explicit force stop.
const drainTimeout = 15 * time.Second

// LifecycleResponseTimeout is how long a lifecycle action may take to
// answer, covering a full drain.
const LifecycleResponseTimeout = drainTimeout + 5*time.Second

// Faults recorded on a Plugin.
const (
	faultStopRefused    = "The Plugin did not stop cooperatively; use plugin-force-stop."
	faultContainerStuck = "The Plugin container did not stop; use plugin-force-stop."
	faultForceStopped   = "The Plugin was force stopped; unfinished Operation outcomes are unknown."
)

var (
	errUnknownAction = problem.Invalid("invalid_action", "The lifecycle action is not recognized.")
	errFaulted       = problem.Conflict("plugin_faulted", "The Plugin is faulted; use plugin-force-stop before stopping it.")
	errStopRefused   = problem.Conflict("plugin_stop_refused", faultStopRefused)
)

// LifecycleRequest is one coordination message from local management.
type LifecycleRequest struct {
	Action string `json:"action"`
}

// ApplyLifecycle records what local management is doing to a Plugin's
// container. Core owns the rules; management only reports its steps.
func (s *Service) ApplyLifecycle(ctx context.Context, id, action string) error {
	plugin, err := s.registry.plugin(ctx, id)
	if err != nil {
		return err
	}
	defer s.settled.Notify()
	switch action {
	case ActionStarted:
		return s.started(ctx, id)
	case ActionStopping:
		return s.stopping(ctx, plugin)
	case ActionStopFailed:
		return s.fault(ctx, id, faultContainerStuck)
	case ActionForceStopping:
		return s.fault(ctx, id, faultForceStopped)
	case ActionForceStopped:
		return s.interrupt(ctx, id, faultForceStopped)
	default:
		return errUnknownAction
	}
}

// started interrupts attempts the earlier container held, clears any fault
// and opens admission. Core never reruns an attempt.
func (s *Service) started(ctx context.Context, id string) error {
	return s.inTransaction(ctx, func(queries *operationsdb.Queries) error {
		if err := queries.InterruptUnfinishedOf(ctx, operationsdb.InterruptUnfinishedOfParams{Error: nullString(errRestarted), PluginID: id}); err != nil {
			return fmt.Errorf("interrupt earlier Operations of %s: %w", id, err)
		}
		return queries.SetRuntime(ctx, operationsdb.SetRuntimeParams{PluginID: id, AdmissionOpen: true})
	})
}

// stopping closes admission, then drains: dispatched work reaches the
// Plugin, the Plugin quiesces (refusing new work and pausing ingestion), and
// finite work finishes. A Plugin that does not cooperate is faulted.
func (s *Service) stopping(ctx context.Context, plugin registrydb.Plugin) error {
	runtime, err := s.runtime(ctx, s.queries, plugin.ID)
	if err != nil {
		return err
	}
	if runtime.Fault.Valid {
		return errFaulted
	}
	if err := s.queries.SetRuntime(ctx, operationsdb.SetRuntimeParams{PluginID: plugin.ID, AdmissionOpen: false}); err != nil {
		return fmt.Errorf("close admission of %s: %w", plugin.ID, err)
	}
	drainCtx, cancel := context.WithTimeout(ctx, drainTimeout)
	defer cancel()
	if err := s.drain(drainCtx, plugin); err != nil {
		return errors.Join(errStopRefused, s.fault(ctx, plugin.ID, faultStopRefused))
	}
	return nil
}

func (s *Service) drain(ctx context.Context, plugin registrydb.Plugin) error {
	if err := s.waitUntilNone(ctx, func(ctx context.Context) (int64, error) { return s.queries.CountPending(ctx, plugin.ID) }); err != nil {
		return err
	}
	if err := s.containers.quiesce(ctx, plugin); err != nil {
		return err
	}
	return s.waitUntilNone(ctx, func(ctx context.Context) (int64, error) { return s.queries.CountUnfinished(ctx, plugin.ID) })
}

// waitUntilNone waits, until ctx ends, for count to reach zero, waking on
// every recorded status change instead of polling.
func (s *Service) waitUntilNone(ctx context.Context, count func(context.Context) (int64, error)) error {
	for {
		changed := s.settled.Next()
		remaining, err := count(ctx)
		if err != nil || remaining == 0 {
			return err
		}
		select {
		case <-changed:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// fault closes admission and records why, keeping known outcomes: work that
// reports before the container stops is still recorded.
func (s *Service) fault(ctx context.Context, id, reason string) error {
	params := operationsdb.SetRuntimeParams{PluginID: id, AdmissionOpen: false, Fault: nullString(reason)}
	if err := s.queries.SetRuntime(ctx, params); err != nil {
		return fmt.Errorf("fault Plugin %s: %w", id, err)
	}
	return nil
}

// interrupt faults a stopped Plugin and records its unfinished attempts as
// interrupted, since their outcomes can no longer be established.
func (s *Service) interrupt(ctx context.Context, id, reason string) error {
	return s.inTransaction(ctx, func(queries *operationsdb.Queries) error {
		if err := queries.SetRuntime(ctx, operationsdb.SetRuntimeParams{PluginID: id, AdmissionOpen: false, Fault: nullString(reason)}); err != nil {
			return err
		}
		return queries.InterruptUnfinishedOf(ctx, operationsdb.InterruptUnfinishedOfParams{Error: nullString(reason), PluginID: id})
	})
}

func (s *Service) inTransaction(ctx context.Context, work func(*operationsdb.Queries) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := work(s.queries.WithTx(tx)); err != nil {
		return err
	}
	return tx.Commit()
}
