package plugins

import (
	"context"
	"sync"
)

// worker runs the module's background work and stops it on close.
type worker struct {
	ctx    context.Context
	cancel context.CancelFunc
	group  sync.WaitGroup
}

func newWorker() *worker {
	ctx, cancel := context.WithCancel(context.Background())
	return &worker{ctx: ctx, cancel: cancel}
}

// run starts task in the background with the worker's context.
func (w *worker) run(task func(ctx context.Context)) {
	w.group.Add(1)
	go func() {
		defer w.group.Done()
		task(w.ctx)
	}()
}

// close cancels every task and waits for them to return.
func (w *worker) close() {
	w.cancel()
	w.group.Wait()
}
