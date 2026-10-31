# Command-line interface

**Install Core through npm. Agents and scripts use the full CLI; people use a smaller TUI.**
The compiled operator package provides both. Its npm publication identity remains
deferred. [Lifecycle](lifecycle.md) owns operation and recovery semantics.

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
endpoint before applying setup. Prerequisite failures include specific host instructions.
Guided setup needs no hand-edited files. Direct commands accept the explicit inputs documented in [local commands](lifecycle.md#commands).
The packaged setup resolves its release image before invoking that operation.
Secrets use protected files or masked input, never command arguments or ordinary output.
Repeated setup refuses to overwrite an existing or ambiguous installation.
Setup leaves Core stopped. Starting it is a separate explicit action.

Saving settings or a certificate activates nothing. [Lifecycle](lifecycle.md#tls-replacement)
defines the explicit restart that applies them.

## Direct commands and results

The CLI is the complete scriptable interface. It exposes all
[local operations](lifecycle.md#commands) without interactive prompts. Missing inputs or confirmations fail before the requested mutation begins.
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

The TUI is a curated interface for common human workflows, not a second CLI. It has
no parity requirement. Home shows the installation, saved endpoint, one plain status,
and only the actions that status allows: Set up Core, Check installation, and Exit
before setup; ordinary lifecycle control, Settings, Add credential, Diagnostics, and
Refresh status afterward. Unavailable runtime evidence withholds Start and Stop but
keeps Settings and Diagnostics. Only validated `service.ready` evidence shows ready.

Settings edits bind address, HTTPS port, comma-separated trusted browser origins, and
diagnostic level through plain inputs. Each save validates complete Settings, keeps
other saved values, and requires the displayed revision. The page shows saved, last
verified effective, and last-working evidence and any apply failure. Certificate
replacement only saves. Restart, or Start when stopped, is a separate confirmed action.
Setup and Add credential take a masked secret, generate their identifiers once per
draft, and show the API key ID.

Other settings, chosen or operator-bound credentials, `stop --force`, reset, Hard
Reset, update, enrollment, and recovery are CLI tasks. Pending recovery replaces
ordinary actions with the exact `recover` command and its effects. Every mutation
requires default-No confirmation.

Compact receipts keep safe codes, primary and cleanup failures, every bounded failure,
partial exports, Doctor instructions, and saved-versus-active TLS evidence. A failed
write says committed effects may remain. "Cancelled before any change" requires an
explicit uncommitted result; a normal result with exit 130 says cancellation arrived
after the operation finished.

Ctrl-C requests cancellation. Escape returns when no operation is active, or requests
return after active work settles. Terminal loss also awaits owned work and cleanup.
Escape keeps the settled receipt visible on the home screen before the next action.
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
