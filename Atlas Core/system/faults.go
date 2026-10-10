package system

import (
	"errors"
	"fmt"
	"sync"
)

// Faults is a test-only fault injection seam for private fault adapters. It is
// nil, and therefore inert, unless Core was started with test faults enabled.
type Faults struct {
	mu    sync.Mutex
	armed map[string]int
}

// NewFaults enables test fault injection for one Core run.
func NewFaults() *Faults { return &Faults{armed: map[string]int{}} }

// ErrInjected is the failure produced by an armed fault.
var ErrInjected = errors.New("injected test fault")

// ArmBeforeCommit fails the next count commits of operation after module
// decisions and before the SQLite commit, so no effect persists.
func (f *Faults) ArmBeforeCommit(operation string, count int) error {
	if f == nil {
		return errors.New("test faults are not enabled for this Core run")
	}
	if count <= 0 {
		return errors.New("fault count must be positive")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.armed[operation] += count
	return nil
}

func (f *Faults) beforeCommit(operation string) error {
	if f == nil {
		return nil
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.armed[operation] == 0 {
		return nil
	}
	f.armed[operation]--
	return fmt.Errorf("%w before committing %s", ErrInjected, operation)
}
