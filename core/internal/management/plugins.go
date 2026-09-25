package management

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/atlas-field-systems/atlas-core/core/internal/identity"
	"github.com/atlas-field-systems/atlas-core/core/internal/plugins"
	"github.com/atlas-field-systems/atlas-core/core/internal/storage"
)

// Bounds on lifecycle messages to Core. A planned stop waits for Core to
// drain finite work.
const (
	coordinationTimeout = 5 * time.Second
	stoppingTimeout     = plugins.LifecycleResponseTimeout + 5*time.Second
)

// maxCoreReply bounds the error body read from Core.
const maxCoreReply = 4 << 10

// defaultCoreURL is where Plugin containers reach Core on the Compose network.
const defaultCoreURL = "http://core:8080"

// PluginOptions override where a Plugin and Core reach each other, for
// running a Plugin outside Compose.
type PluginOptions struct {
	Endpoint string
	CoreURL  string
}

func (i Installation) pluginsDir() string { return filepath.Join(i.SetupDir(), "plugins") }

// PluginEnvFile holds a Plugin's identity for its container.
func (i Installation) PluginEnvFile(id string) string {
	return filepath.Join(i.pluginsDir(), id+".env")
}

func (i Installation) pluginComposeFile(id string) string {
	return filepath.Join(i.pluginsDir(), id+".compose.yaml")
}

func pluginService(id string) string { return "plugin-" + id }

// InstallPlugin records the Plugin in pluginDir from its manifest, issues its
// integration credential and writes its container configuration. The
// container receives only that configuration: no Core storage or Docker
// control.
func (i Installation) InstallPlugin(ctx context.Context, pluginDir string, options PluginOptions) (plugins.Manifest, error) {
	data, err := os.ReadFile(filepath.Join(pluginDir, plugins.ManifestFile))
	if err != nil {
		return plugins.Manifest{}, err
	}
	manifest, err := plugins.ParseManifest(data)
	if err != nil {
		return plugins.Manifest{}, err
	}
	options = withDefaults(options, manifest)
	credential, dispatchSecret, err := newPluginSecrets()
	if err != nil {
		return plugins.Manifest{}, err
	}
	if err := i.writePluginFiles(manifest, options, credential, dispatchSecret); err != nil {
		return plugins.Manifest{}, err
	}
	if err := i.recordPlugin(ctx, manifest, options.Endpoint, credential, dispatchSecret); err != nil {
		return plugins.Manifest{}, errors.Join(err, os.Remove(i.PluginEnvFile(manifest.ID)), os.Remove(i.pluginComposeFile(manifest.ID)))
	}
	return manifest, nil
}

func withDefaults(options PluginOptions, manifest plugins.Manifest) PluginOptions {
	if options.Endpoint == "" {
		options.Endpoint = fmt.Sprintf("http://%s:%d", pluginService(manifest.ID), manifest.Port)
	}
	if options.CoreURL == "" {
		options.CoreURL = defaultCoreURL
	}
	return options
}

func newPluginSecrets() (string, string, error) {
	credential, err := identity.NewCredential(identity.PluginPrefix)
	if err != nil {
		return "", "", err
	}
	dispatchSecret, err := identity.NewCredential(identity.DispatchPrefix)
	return credential, dispatchSecret, err
}

func (i Installation) writePluginFiles(manifest plugins.Manifest, options PluginOptions, credential, dispatchSecret string) error {
	if err := os.MkdirAll(i.pluginsDir(), 0o700); err != nil {
		return err
	}
	env := fmt.Sprintf("ATLAS_PLUGIN_ID=%s\nATLAS_PLUGIN_KEY=%s\nATLAS_DISPATCH_SECRET=%s\nATLAS_CORE_URL=%s\nATLAS_PLUGIN_PORT=%d\n",
		manifest.ID, credential, dispatchSecret, options.CoreURL, manifest.Port)
	if err := writePrivateFile(i.PluginEnvFile(manifest.ID), env); err != nil {
		return fmt.Errorf("Plugin %s is already installed or its configuration exists: %w", manifest.ID, err)
	}
	fragment := fmt.Sprintf("services:\n  %s:\n    image: %s\n    restart: \"no\"\n    env_file: [%q]\n    expose: [\"%d\"]\n",
		pluginService(manifest.ID), manifest.Image, i.PluginEnvFile(manifest.ID), manifest.Port)
	if err := writePrivateFile(i.pluginComposeFile(manifest.ID), fragment); err != nil {
		return errors.Join(err, os.Remove(i.PluginEnvFile(manifest.ID)))
	}
	return nil
}

func (i Installation) recordPlugin(ctx context.Context, manifest plugins.Manifest, endpoint, credential, dispatchSecret string) error {
	db, err := storage.Open(ctx, i.databaseFile(), storage.Installation)
	if err != nil {
		return err
	}
	defer db.Close()
	if err := plugins.NewRegistry(db).Install(ctx, manifest, endpoint, dispatchSecret); err != nil {
		return err
	}
	return identity.New(db).AddPluginKey(ctx, manifest.ID, credential)
}

// installedPlugins lists Plugin IDs from their container configuration.
func (i Installation) installedPlugins() ([]string, error) {
	fragments, err := filepath.Glob(filepath.Join(i.pluginsDir(), "*.compose.yaml"))
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(fragments))
	for _, fragment := range fragments {
		ids = append(ids, strings.TrimSuffix(filepath.Base(fragment), ".compose.yaml"))
	}
	return ids, nil
}

// StartPlugin starts a Plugin container, waits for its health check, and
// tells Core it started. Core never reruns an earlier attempt.
func (i Installation) StartPlugin(ctx context.Context, id string) error {
	return i.withPluginLock(id, func() error { return i.startPlugin(ctx, id) })
}

// StopPlugin stops a Plugin after Core closes its admission and drains its
// finite work. Core and other containers keep running.
func (i Installation) StopPlugin(ctx context.Context, id string) error {
	return i.withPluginLock(id, func() error { return i.stopPlugin(ctx, id) })
}

// RestartPlugin is a planned stop followed by a start. It never reruns an
// Operation; resubmitting is a separate, explicit new attempt.
func (i Installation) RestartPlugin(ctx context.Context, id string) error {
	return i.withPluginLock(id, func() error {
		if err := i.stopPlugin(ctx, id); err != nil {
			return err
		}
		return i.startPlugin(ctx, id)
	})
}

// ForceStopPlugin kills a Plugin that could not stop cooperatively. Its
// unfinished attempts become interrupted; it does not claim external effects
// stopped.
func (i Installation) ForceStopPlugin(ctx context.Context, id string) error {
	return i.withPluginLock(id, func() error {
		if err := i.coordinate(ctx, id, plugins.ActionForceStopping); err != nil {
			return err
		}
		if err := i.compose(ctx, "stop", "-t", "0", pluginService(id)); err != nil {
			return err
		}
		return i.coordinate(ctx, id, plugins.ActionForceStopped)
	})
}

func (i Installation) startPlugin(ctx context.Context, id string) error {
	if err := i.compose(ctx, "up", "-d", "--wait", "--wait-timeout", "30", "--no-deps", "--no-build", "--pull", "never", pluginService(id)); err != nil {
		return err
	}
	return i.coordinate(ctx, id, plugins.ActionStarted)
}

func (i Installation) stopPlugin(ctx context.Context, id string) error {
	if err := i.coordinate(ctx, id, plugins.ActionStopping); err != nil {
		return fmt.Errorf("stop Plugin %s: %w", id, err)
	}
	if err := i.compose(ctx, "stop", pluginService(id)); err != nil {
		return errors.Join(err, i.coordinate(ctx, id, plugins.ActionStopFailed))
	}
	return nil
}

// withPluginLock serializes local lifecycle commands for one Plugin across
// processes, failing fast if another command holds it.
func (i Installation) withPluginLock(id string, work func() error) error {
	file, err := os.OpenFile(filepath.Join(i.pluginsDir(), id+".lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fmt.Errorf("another lifecycle command for Plugin %s is running: %w", id, err)
	}
	defer syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
	return work()
}

// coordinate sends a lifecycle action to the running Core over its private
// channel.
func (i Installation) coordinate(ctx context.Context, pluginID, action string) error {
	core, err := i.coreAddress(ctx)
	if err != nil {
		return err
	}
	secret, err := readSecretFile(i.managementSecretFile(), identity.ManagementPrefix)
	if err != nil {
		return fmt.Errorf("read management secret: %w", err)
	}
	body, err := json.Marshal(plugins.LifecycleRequest{Action: action})
	if err != nil {
		return err
	}
	timeout := coordinationTimeout
	if action == plugins.ActionStopping {
		timeout = stoppingTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, core+"/internal/plugins/"+pluginID+"/lifecycle", bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set(plugins.ManagementSecretHeader, secret)
	return send(request)
}

func send(request *http.Request) error {
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return fmt.Errorf("coordinate with Core: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNoContent {
		return nil
	}
	var failure struct {
		Message string `json:"message"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, maxCoreReply)).Decode(&failure) == nil && failure.Message != "" {
		return errors.New(failure.Message)
	}
	return fmt.Errorf("Core refused the lifecycle action: HTTP %d", response.StatusCode)
}

// coreAddress finds Core's published address on the host.
func (i Installation) coreAddress(ctx context.Context) (string, error) {
	output, err := i.composeOutput(ctx, io.Discard, "port", "core", "8080")
	if err != nil {
		return "", fmt.Errorf("locate running Core: %w", err)
	}
	address, _, _ := strings.Cut(strings.TrimSpace(output), "\n")
	return "http://" + address, nil
}
