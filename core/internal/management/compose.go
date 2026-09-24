package management

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// composeTimeout bounds one Docker Compose command, including a health wait.
const composeTimeout = 2 * time.Minute

// Start runs the installed Core image, waits for its private health probe,
// then starts every installed Plugin. It never builds or pulls, so it works
// without internet access.
func (i Installation) Start(ctx context.Context) error {
	if _, err := os.Stat(i.databaseFile()); err != nil {
		return fmt.Errorf("installation is not set up; run atlasctl setup: %w", err)
	}
	// Docker would create a missing bind-mount source owned by root.
	if err := os.MkdirAll(i.OperationalDir(), 0o700); err != nil {
		return fmt.Errorf("create operational storage directory: %w", err)
	}
	if err := i.compose(ctx, "up", "-d", "--wait", "--wait-timeout", "30", "--no-build", "--pull", "never", "core"); err != nil {
		return err
	}
	installed, err := i.installedPlugins()
	if err != nil {
		return err
	}
	for _, id := range installed {
		if err := i.StartPlugin(ctx, id); err != nil {
			return err
		}
	}
	return nil
}

// Stop makes a planned stop of every running Plugin, then stops Core,
// keeping setup, Dataset, Object storage and logs. If a Plugin cannot stop
// cooperatively, Core keeps running and the failure is reported.
func (i Installation) Stop(ctx context.Context) error {
	running, err := i.runningPlugins(ctx)
	if err != nil {
		return err
	}
	for _, id := range running {
		if err := i.StopPlugin(ctx, id); err != nil {
			return fmt.Errorf("%w; Core is still running", err)
		}
	}
	return i.compose(ctx, "stop", "core")
}

// runningPlugins lists installed Plugins whose containers are running.
func (i Installation) runningPlugins(ctx context.Context) ([]string, error) {
	installed, err := i.installedPlugins()
	if err != nil || len(installed) == 0 {
		return nil, err
	}
	output, err := i.composeOutput(ctx, io.Discard, "ps", "--status", "running", "--services")
	if err != nil {
		return nil, err
	}
	var running []string
	for _, id := range installed {
		if slices.Contains(strings.Fields(output), pluginService(id)) {
			running = append(running, id)
		}
	}
	return running, nil
}

// compose runs Docker Compose over Core's file and every installed Plugin's.
func (i Installation) compose(ctx context.Context, args ...string) error {
	_, err := i.composeOutput(ctx, os.Stdout, args...)
	return err
}

func (i Installation) composeOutput(ctx context.Context, stdout io.Writer, args ...string) (string, error) {
	files, err := i.composeFiles()
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, composeTimeout)
	defer cancel()
	var captured strings.Builder
	cmd := exec.CommandContext(ctx, "docker", append(append([]string{"compose"}, files...), args...)...)
	cmd.Env = append(os.Environ(), fmt.Sprintf("ATLAS_UID=%d", os.Getuid()), fmt.Sprintf("ATLAS_GID=%d", os.Getgid()))
	cmd.Stdout = io.MultiWriter(stdout, &captured)
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("docker compose %s: %w", args[0], err)
	}
	return captured.String(), nil
}

func (i Installation) composeFiles() ([]string, error) {
	fragments, err := filepath.Glob(filepath.Join(i.pluginsDir(), "*.compose.yaml"))
	if err != nil {
		return nil, err
	}
	files := []string{"-f", i.composeFile()}
	for _, fragment := range fragments {
		files = append(files, "-f", fragment)
	}
	return files, nil
}
