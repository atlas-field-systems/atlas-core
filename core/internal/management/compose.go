package management

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"time"
)

// composeTimeout bounds one Docker Compose command, including a health wait.
const composeTimeout = 2 * time.Minute

// Start runs the installed Core image and waits for its private health probe.
// It never builds or pulls, so it works without internet access.
func (i Installation) Start(ctx context.Context) error {
	if _, err := os.Stat(i.databaseFile()); err != nil {
		return fmt.Errorf("installation is not set up; run atlasctl setup: %w", err)
	}
	// Docker would create a missing bind-mount source owned by root.
	if err := os.MkdirAll(i.OperationalDir(), 0o700); err != nil {
		return fmt.Errorf("create operational storage directory: %w", err)
	}
	return i.compose(ctx, "up", "-d", "--wait", "--wait-timeout", "30", "--no-build", "--pull", "never", "core")
}

// Stop stops Core and keeps setup, Dataset, Object storage and logs.
func (i Installation) Stop(ctx context.Context) error {
	return i.compose(ctx, "stop", "core")
}

func (i Installation) compose(ctx context.Context, args ...string) error {
	ctx, cancel := context.WithTimeout(ctx, composeTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "docker", append([]string{"compose", "-f", i.composeFile()}, args...)...)
	cmd.Env = append(os.Environ(), fmt.Sprintf("ATLAS_UID=%d", os.Getuid()), fmt.Sprintf("ATLAS_GID=%d", os.Getgid()))
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("docker compose %s: %w", args[0], err)
	}
	return nil
}
