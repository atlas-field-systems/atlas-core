package plugins_test

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/atlas-field-systems/atlas-core/plugindispatch"
	"github.com/atlas-field-systems/atlas-core/plugins"
)

type childEvent struct {
	Operation    *plugins.Operation
	Event, Error string
	Evidence     *plugindispatch.Evidence
	Duplicate    bool
}
type child struct {
	stderr         *lockedBuffer
	closing        chan struct{}
	closeOnce      sync.Once
	commandProcess *exec.Cmd
	input          io.WriteCloser
	events         chan childEvent
	done           chan struct{}
	mu             sync.Mutex
	result         error
	stopped        bool
	backlog        []childEvent
}

func (f *fixture) start(t *testing.T, mode string) *child { return f.startProcess(t, mode, false) }
func (f *fixture) startProcess(t *testing.T, mode string, coreMode bool) *child {
	t.Helper()
	config := struct {
		ContractPath, Socket, Work, Effects, Mode string
		Binding                                   plugindispatch.Binding
		Token                                     string
		Release                                   plugindispatch.Release
		Definition                                *plugindispatch.Capability
		Capacity, MaxFiles                        int
		MaxBytes                                  int64
	}{ContractPath: absolute(t, "../../Atlas Protocol/plugin-dispatch.json"), Socket: f.socket, Work: f.work, Effects: f.effects, Mode: mode, Binding: f.binding.Binding, Token: f.binding.Token, Release: f.binding.Release, Definition: f.definition, Capacity: f.binding.ReceiptCapacity, MaxFiles: f.maxFiles, MaxBytes: f.maxBytes}
	body, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(f.root, fmt.Sprintf("config-%s-%t.json", f.binding.Binding.RuntimeGeneration, coreMode))
	if err := os.WriteFile(configPath, body, 0o600); err != nil {
		t.Fatal(err)
	}
	c := &child{commandProcess: exec.Command(f.binary, "-config", configPath), events: make(chan childEvent, 128), done: make(chan struct{}), closing: make(chan struct{})}
	stdin, err := c.commandProcess.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	c.input = stdin
	stdout, err := c.commandProcess.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr lockedBuffer
	c.stderr = &stderr
	c.commandProcess.Stderr = &stderr
	if coreMode {
		c.commandProcess.Args = append(c.commandProcess.Args, "-core")
	}
	if err := c.commandProcess.Start(); err != nil {
		t.Fatal(err)
	}
	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 4096), 256*1024)
		var scanErr error
		for scanner.Scan() {
			var event childEvent
			if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
				scanErr = err
				break
			}
			select {
			case c.events <- event:
			case <-c.closing:
			}
		}
		scanErr = errors.Join(scanErr, scanner.Err())
		err := c.commandProcess.Wait()
		c.mu.Lock()
		c.result = errors.Join(scanErr, err)
		c.mu.Unlock()
		close(c.done)
	}()
	t.Cleanup(func() {
		if err := c.stop(); err != nil {
			t.Errorf("Plugin cleanup: %v; stderr: %s", err, stderr.String())
		}
	})
	f.children = append(f.children, c)
	return c
}
func absolute(t *testing.T, path string) string {
	t.Helper()
	result, err := filepath.Abs(path)
	if err != nil {
		t.Fatal(err)
	}
	return result
}
func (c *child) command(t *testing.T, value string) {
	t.Helper()
	if _, err := io.WriteString(c.input, value+"\n"); err != nil {
		t.Fatal(err)
	}
}
func (c *child) event(t *testing.T, name string) childEvent {
	t.Helper()
	for index, event := range c.backlog {
		if event.Event == name {
			c.backlog = append(c.backlog[:index], c.backlog[index+1:]...)
			return event
		}
	}
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case event := <-c.events:
			if event.Event == "error" || event.Event == "fault" {
				if name != event.Event {
					t.Fatalf("Plugin event while waiting %s: %+v", name, event)
				}
			}
			if event.Event == name {
				return event
			}
			c.backlog = append(c.backlog, event)
		case <-c.done:
			select {
			case event := <-c.events:
				if event.Event == name {
					return event
				}
			default:
			}
			c.mu.Lock()
			result := c.result
			c.mu.Unlock()
			t.Fatalf("Plugin exited before %s: %v", name, result)
		case <-timer.C:
			t.Fatalf("Plugin event %s timed out", name)
		}
	}
}
func (c *child) stop() error {
	c.mu.Lock()
	if c.stopped {
		c.mu.Unlock()
		return nil
	}
	c.stopped = true
	c.mu.Unlock()
	select {
	case <-c.done:
		return c.result
	default:
	}
	c.closeOnce.Do(func() { close(c.closing) })
	if err := c.commandProcess.Process.Signal(os.Interrupt); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	select {
	case <-c.done:
		return c.result
	case <-timer.C:
		killErr := c.commandProcess.Process.Kill()
		select {
		case <-c.done:
			return errors.Join(errors.New("Plugin graceful shutdown timed out"), killErr, c.result)
		case <-time.After(3 * time.Second):
			return errors.Join(errors.New("Plugin graceful shutdown and forced reap timed out"), killErr)
		}
	}
}
func (c *child) kill(t *testing.T) {
	t.Helper()
	c.closeOnce.Do(func() { close(c.closing) })
	if err := c.commandProcess.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-c.done:
	case <-time.After(3 * time.Second):
		t.Fatal("Plugin kill not reaped")
	}
	if strings.Contains(c.stderr.String(), "WARNING: DATA RACE") {
		t.Fatal("race detector reported a race in the intentionally killed fixture:", c.stderr.String())
	}
	c.mu.Lock()
	c.stopped = true
	c.mu.Unlock()
}

// exec owns stderr copying concurrently with test failure reporting.
type lockedBuffer struct {
	mu   sync.Mutex
	body []byte
}

func (b *lockedBuffer) Write(body []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.body = append(b.body, body...)
	return len(body), nil
}
func (b *lockedBuffer) String() string { b.mu.Lock(); defer b.mu.Unlock(); return string(b.body) }

func (c *child) expectFailure(t *testing.T) {
	t.Helper()
	select {
	case <-c.done:
	case <-time.After(3 * time.Second):
		t.Fatal("faulted Plugin did not exit")
	}
	if strings.Contains(c.stderr.String(), "WARNING: DATA RACE") {
		t.Fatal("race detector reported a race in the intentionally faulted fixture:", c.stderr.String())
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.result == nil {
		t.Fatal("faulted Plugin reported success")
	}
	c.stopped = true
}
