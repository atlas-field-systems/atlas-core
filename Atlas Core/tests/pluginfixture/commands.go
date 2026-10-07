package main

import (
	"bufio"
	"context"
	"os"
)

// A nil result preserves clean stdin EOF; scanner errors remain primary errors.
// Commands are unbuffered so this fixture cannot queue unbounded test work.
func readCommands(ctx context.Context) (<-chan string, <-chan error) {
	commands := make(chan string)
	errors := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			select {
			case commands <- scanner.Text():
			case <-ctx.Done():
				return
			}
		}
		errors <- scanner.Err()
	}()
	return commands, errors
}
