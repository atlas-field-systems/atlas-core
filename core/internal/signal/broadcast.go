// Package signal wakes in-process waiters when state changes, so they do not
// poll storage.
package signal

import "sync"

// Broadcast wakes every waiter at the next Notify by closing a channel.
type Broadcast struct {
	mu      sync.Mutex
	channel chan struct{}
}

func NewBroadcast() *Broadcast { return &Broadcast{channel: make(chan struct{})} }

// Next returns a channel closed at the next Notify. Take it before reading
// the state it guards, so a change between the read and the wait is not
// missed.
func (b *Broadcast) Next() <-chan struct{} {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.channel
}

// Notify wakes every current waiter.
func (b *Broadcast) Notify() {
	b.mu.Lock()
	defer b.mu.Unlock()
	close(b.channel)
	b.channel = make(chan struct{})
}
