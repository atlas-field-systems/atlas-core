// Command atlasctl administers a local Atlas installation.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"

	"github.com/atlas-field-systems/atlas-core/core/internal/management"
)

const usage = `usage: atlasctl -root DIR COMMAND
  setup | recover | revoke-enrollment | start | stop
  plugin-install [-endpoint URL] [-core-url URL] PLUGIN_DIR
  plugin-start | plugin-stop | plugin-restart | plugin-force-stop PLUGIN_ID`

func main() {
	root := flag.String("root", ".", "Atlas installation directory containing compose.yaml and state/")
	flag.Parse()
	if flag.NArg() < 1 {
		fail(usage)
	}
	installation := management.Installation{Root: *root}
	if err := run(context.Background(), installation, flag.Arg(0), flag.Args()[1:]); err != nil {
		fail("%s: %v", flag.Arg(0), err)
	}
}

func run(ctx context.Context, installation management.Installation, command string, args []string) error {
	switch command {
	case "setup":
		key, err := installation.Setup(ctx)
		if err == nil {
			fmt.Println("Administrative credential:", key)
			fmt.Println("Protected local copy:", installation.FirstKeyFile())
		}
		return err
	case "recover":
		key, err := installation.Recover(ctx)
		if err == nil {
			fmt.Println("Recovery administrative credential:", key)
		}
		return err
	case "revoke-enrollment":
		err := installation.RevokeEnrollment(ctx)
		if err == nil {
			fmt.Println("Enrollment authority revoked")
		}
		return err
	case "start":
		return installation.Start(ctx)
	case "stop":
		return installation.Stop(ctx)
	case "plugin-install":
		return installPlugin(ctx, installation, args)
	case "plugin-start", "plugin-stop", "plugin-restart", "plugin-force-stop":
		id, err := pluginID(args)
		if err != nil {
			return err
		}
		return pluginCommands[command](installation, ctx, id)
	default:
		return fmt.Errorf("unknown command\n%s", usage)
	}
}

var pluginCommands = map[string]func(management.Installation, context.Context, string) error{
	"plugin-start":      management.Installation.StartPlugin,
	"plugin-stop":       management.Installation.StopPlugin,
	"plugin-restart":    management.Installation.RestartPlugin,
	"plugin-force-stop": management.Installation.ForceStopPlugin,
}

func installPlugin(ctx context.Context, installation management.Installation, args []string) error {
	flags := flag.NewFlagSet("plugin-install", flag.ContinueOnError)
	var options management.PluginOptions
	flags.StringVar(&options.Endpoint, "endpoint", "", "where Core reaches the Plugin (default: its Compose service)")
	flags.StringVar(&options.CoreURL, "core-url", "", "where the Plugin reaches Core (default: http://core:8080)")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 1 {
		return errors.New("plugin-install needs the Plugin directory")
	}
	manifest, err := installation.InstallPlugin(ctx, flags.Arg(0), options)
	if err == nil {
		fmt.Printf("Installed Plugin %s %s; configuration in %s\n", manifest.ID, manifest.Release, installation.PluginEnvFile(manifest.ID))
	}
	return err
}

func pluginID(args []string) (string, error) {
	if len(args) != 1 {
		return "", errors.New("the command needs a Plugin ID")
	}
	return args[0], nil
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
