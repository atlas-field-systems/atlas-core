package manager

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// Docker Compose and Engine control stay on the host. Core never receives the
// Docker socket.

func docker(ctx context.Context, arguments ...string) (string, error) {
	command := exec.CommandContext(ctx, "docker", arguments...)
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	if err := command.Run(); err != nil {
		return "", fmt.Errorf("docker %s: %w: %s", arguments[0], err, strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(stdout.String()), nil
}

func (i Installation) compose(ctx context.Context, arguments ...string) (string, error) {
	return docker(ctx, append([]string{"compose", "--file", i.composeFile()}, arguments...)...)
}

// composeDocument is written as JSON, which Compose reads as YAML.
type composeDocument struct {
	Name     string                    `json:"name"`
	Services map[string]composeService `json:"services"`
}

type composeService struct {
	Image      string            `json:"image"`
	PullPolicy string            `json:"pull_policy"`
	Restart    string            `json:"restart"`
	User       string            `json:"user"`
	ReadOnly   bool              `json:"read_only"`
	Command    []string          `json:"command"`
	Ports      []string          `json:"ports"`
	Volumes    []string          `json:"volumes"`
	Labels     map[string]string `json:"labels"`
	StopGrace  string            `json:"stop_grace_period"`
}

// ProjectName is the Compose project that groups one installation.
func ProjectName(installationID string) string { return "atlas-" + installationID }

func (i Installation) writeCompose(record Record) error {
	command := []string{"serve", "--root", "/atlas", "--listen", "0.0.0.0:8443"}
	if record.TestFaults {
		command = append(command, "--test-faults")
	}
	document := composeDocument{
		Name: ProjectName(record.InstallationID),
		Services: map[string]composeService{"core": {
			Image: record.Image, PullPolicy: "never", Restart: "no", ReadOnly: true, StopGrace: "10s",
			User:    fmt.Sprintf("%d:%d", record.OwnerUID, record.OwnerGID),
			Command: command,
			Ports:   []string{fmt.Sprintf("%s:%d:8443", record.ListenAddress, record.ListenPort)},
			Volumes: []string{
				i.coreDir() + ":/atlas/core",
				i.coreSetupDir() + ":/atlas/setup:ro",
				i.journalDir() + ":/atlas/journal",
				i.logsDir() + ":/atlas/logs",
				i.runDir() + ":/atlas/run",
			},
			Labels: map[string]string{"com.atlas.installation": record.InstallationID, "com.atlas.role": "core"},
		}},
	}
	encoded, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return fmt.Errorf("encode Compose project: %w", err)
	}
	return writeDurable(i.composeFile(), append(encoded, '\n'), 0o600)
}

// containerState reports the Core container's ID and whether it runs. An
// absent container is not running.
func (i Installation) containerState(ctx context.Context) (string, bool, error) {
	id, err := i.compose(ctx, "ps", "--all", "--quiet", "core")
	if err != nil {
		return "", false, err
	}
	if id == "" {
		return "", false, nil
	}
	running, err := docker(ctx, "inspect", "--format", "{{.State.Running}}", id)
	if err != nil {
		return id, false, err
	}
	return id, running == "true", nil
}

// startContainer creates or starts only the Core service; it never pulls.
func (i Installation) startContainer(ctx context.Context) error {
	_, err := i.compose(ctx, "up", "--detach", "--no-deps", "--pull", "never", "core")
	return err
}

// stopContainer stops the Core container with a ten-second grace, then
// verifies exit. Unverified exit is an incomplete stop.
func (i Installation) stopContainer(ctx context.Context) error {
	if _, err := i.compose(ctx, "stop", "--timeout", "10", "core"); err != nil {
		return err
	}
	_, running, err := i.containerState(ctx)
	if err != nil {
		return fmt.Errorf("verify Core exit: %w", err)
	}
	if running {
		return errors.New("Core container exit could not be verified")
	}
	return nil
}

// removeContainer removes the stopped Core container and its Docker-managed
// logs. Images, networks and unrelated containers are untouched.
func (i Installation) removeContainer(ctx context.Context) error {
	_, err := i.compose(ctx, "rm", "--force", "--stop", "core")
	return err
}

func (i Installation) containerLogs(ctx context.Context) string {
	logs, err := i.compose(ctx, "logs", "--no-color", "--tail", "20", "core")
	if err != nil {
		return ""
	}
	return logs
}

// resolveImage returns the immutable image ID for a loaded local image.
func resolveImage(ctx context.Context, reference string) (string, error) {
	id, err := docker(ctx, "image", "inspect", "--format", "{{.Id}}", reference)
	if err != nil {
		return "", fmt.Errorf("Core image %s is not loaded locally: %w", reference, err)
	}
	return id, nil
}

// waitForPrivate waits for a Core run to answer on the private socket while
// its container keeps running.
func (i Installation) waitForPrivate(ctx context.Context, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		hello, err := i.hello(ctx)
		if err == nil && hello.RunID != "" {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("Core did not answer on its private socket: %v; recent Core log:\n%s", err, i.containerLogs(ctx))
		}
		if _, running, stateErr := i.containerState(ctx); stateErr == nil && !running {
			return fmt.Errorf("Core exited before answering; recent Core log:\n%s", i.containerLogs(ctx))
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}
