package plugins

import (
	"context"
	"time"

	"github.com/atlas-field-systems/atlas-core/core/internal/plugins/internal/registrydb"
)

// Availability probing. Plugins are separate processes, so Core learns of a
// lost container only by probing it.
const (
	probeInterval = 500 * time.Millisecond
	// lossThreshold consecutive failed probes of a Plugin that answered
	// earlier in this run mean Core lost it.
	lossThreshold = 2
)

const faultLost = "Core lost contact with the Plugin; unfinished Operation outcomes are unknown."

type reachability struct {
	reachable bool
	answered  bool
	misses    int
}

func (s *Service) isReachable(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.reachable[id]
	return state != nil && state.reachable
}

// watch probes every installed Plugin until Core stops.
func (s *Service) watch(ctx context.Context) {
	ticker := time.NewTicker(probeInterval)
	defer ticker.Stop()
	for {
		s.probeAll(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Service) probeAll(ctx context.Context) {
	installed, err := s.registry.Installed(ctx)
	if err != nil {
		s.log.Error("list Plugins to probe", "error", err)
		return
	}
	for _, plugin := range installed {
		if s.recordProbe(plugin.ID, s.containers.healthy(ctx, plugin)) {
			s.recordLoss(ctx, plugin)
		}
	}
}

// recordProbe notes one probe and reports whether it confirms a loss.
func (s *Service) recordProbe(id string, healthy bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.reachable[id]
	if state == nil {
		state = &reachability{}
		s.reachable[id] = state
	}
	state.reachable = healthy
	if healthy {
		state.answered, state.misses = true, 0
		return false
	}
	state.misses++
	return state.answered && state.misses == lossThreshold
}

// recordLoss faults a Plugin that should be running and interrupts its
// unfinished attempts. A Plugin closed for a planned stop is not lost.
func (s *Service) recordLoss(ctx context.Context, plugin registrydb.Plugin) {
	if err := s.faultIfAdmitting(ctx, plugin.ID, faultLost); err != nil {
		s.log.Error("record Plugin loss", "plugin", plugin.ID, "error", err)
	}
}

func (s *Service) faultIfAdmitting(ctx context.Context, id, fault string) error {
	runtime, err := s.runtime(ctx, s.queries, id)
	if err != nil || !runtime.AdmissionOpen || runtime.Fault.Valid {
		return err
	}
	defer s.settled.Notify()
	return s.interrupt(ctx, id, fault)
}
