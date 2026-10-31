# Command-line interface

**Install Core through npm, then administer one installation through a CLI or TUI.**
The compiled operator package provides this interface. Its npm publication identity
remains deferred. [Lifecycle](lifecycle.md) owns operation and recovery semantics.

## Installation and launch

Installation requires a supported Node.js version and Docker on a qualified Linux host.
[Release packaging](build-profile.md#operator-package) owns the deferred npm identity.
`<package>` is a placeholder, not an installable name.

```sh
npm install --global <package>
atlas-core
```

The package installs compiled software without a checkout or compiler. Its install
scripts do not start Core, provision credentials, or change an installation.
[Release packaging](build-profile.md#operator-package) owns artifact identity,
image acquisition, offline installation, and package compatibility.

`atlas-core` opens the TUI when input and output are interactive terminals.
Without a terminal, it prints help and exits successfully. `atlas-core tui`
explicitly opens the TUI and fails if an interactive terminal is unavailable.
`atlas-core help` and `atlas-core version` work before setup and without Docker.
Version output identifies the installed package and its intended Core release.

`--installation PATH` selects an absolute installation directory. The default is
`~/.atlas/core`. Selection never depends on the working directory. The TUI displays
the resolved path before setup or mutation. Software and retained state live separately.

## Setup and configuration

First launch offers guided setup. It checks the supported runtime and platform,
Docker access, required host tools, storage ownership, capacity, and port availability.
Missing prerequisites produce specific installation instructions. Atlas does not
silently install host software or change host permissions.

Setup obtains the verified release image and collects initial credentials, supplied
TLS files, bind address, port, and trusted browser origins. It explains the resulting
endpoint before applying setup. Prerequisite failures include specific host instructions. Configuration needs no hand-edited files in the TUI.
Direct commands accept the explicit inputs documented in [local commands](lifecycle.md#commands).
The packaged setup resolves its release image before invoking that operation.
Secrets use protected files or masked input, never command arguments or ordinary output.
Repeated setup refuses to overwrite an existing or ambiguous installation.
Setup leaves Core stopped. Starting it is a separate explicit action.

Settings display saved and effective values and any apply failure. Saving settings
does not activate them. Applying settings requires the explicit restart defined by
lifecycle. Certificate replacement follows [TLS replacement](lifecycle.md#tls-replacement).

## Direct commands and results

The CLI exposes all [local operations](lifecycle.md#commands) without interactive
prompts. Missing inputs or confirmations fail before the requested mutation begins.
Administrative commands retain the structured JSON result envelope and safe failure
codes. Help and version produce text. Successful commands exit 0 and failures exit 1.

`inspect` reports Core's running state, readiness when available, settings, and
pending recovery. Running does not itself mean ready. [Readiness](readiness.md)
defines service health. Unavailable evidence stays unavailable rather than becoming
a healthy result. `doctor` performs bounded read-only prerequisite and installation
checks, reports actionable results, and exits 1 when a required check fails.
Neither command repairs state, starts Core, or resumes interrupted actions.
`export` retains the bounded diagnostic format and partial results in [diagnostics](diagnostics.md).

## Interactive administration

The TUI uses [Ink](https://github.com/vadimdemedes/ink), React, and
[Ink UI](https://github.com/vadimdemedes/ink-ui) with compatible pinned versions.
Standard controls provide menus, inputs, confirmations, and progress indicators.
Atlas supplies its screens and workflows, not a terminal renderer or widget framework.
Direct commands load no TUI renderer. Both interfaces call the same administration
operations and hold the same installation lock for mutations.

The home screen shows the selected installation, saved endpoint, and Core state. It offers setup,
lifecycle controls, settings, credentials, enrollment, diagnostics, and explicit recovery.
Destructive actions show their effects and require confirmation before execution.
The interface shows progress and the final result, including committed effects and
cleanup failures. It never claims an uncertain operation left the installation unchanged.

Ctrl-C requests cancellation. Escape returns when no operation is active, or requests
return after active work settles. Terminal loss also awaits owned work and cleanup.
A completed cancellation exits 130 when exiting the process. Committed work remains
committed, and operation or cleanup failures take precedence over cancellation.
The TUI refreshes state after each operation without automatically retrying mutations.
Closing the TUI leaves the Core service running.

## Deployment boundary and acceptance

Core configures its own HTTPS endpoint. Users own network exposure, DNS, certificate
issuance, tunnels, proxies, gateways, and operator UI hosting. These are not CLI
integrations or health checks. No hosted-versus-field mode or cloud login is required.

[Operator-interface qualification](qualification.md#operator-interface-qualification)
defines the evidence required before claiming this interface works.
