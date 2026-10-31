# Command-line interface

**Agents use the full CLI. People use a smaller, task-oriented TUI.**
The compiled operator package provides both. Its npm publication identity remains
unselected. [Lifecycle](lifecycle.md) owns operation and recovery semantics.

## Installation and launch

Installation requires supported Node.js and Docker on a qualified Linux host.
[Release packaging](build-profile.md#operator-package) owns package identity, image
verification, offline installation, and compatibility. `<package>` is a placeholder.

```sh
npm install --global <package>
atlas-core
```

Installation adds compiled software without a checkout or compiler. It does not
start Core, provision credentials, or change retained state.
`atlas-core` opens the TUI when input and output are terminals; otherwise it prints
help and exits 0. Explicit `atlas-core tui` fails without an interactive terminal.
`help` and `version` work before setup and without Docker. Version identifies the
installed package and intended Core release.

`--installation PATH` selects an absolute directory. The default is `~/.atlas/core`,
independent of the working directory. The TUI shows the resolved path before mutation.
Software and retained state live separately.

## Setup and configuration

Guided setup checks runtime, platform, Docker access, required host tools, storage
ownership, capacity, and port availability. Missing prerequisites produce specific
instructions. Atlas never silently installs host software or changes permissions.
Setup verifies its release image and collects supplied TLS files, an initial masked
secret, bind address, port, and trusted browser origins. The TUI generates credential
identifiers and shows the proposed endpoint before a default-No confirmation.
Direct setup takes the explicit [local-command inputs](lifecycle.md#commands).
Secrets use protected files or masked input, never arguments or ordinary output.
Repeated setup refuses existing or ambiguous state. Setup leaves Core stopped.
Starting it is a separate explicit action.

Saving settings or a certificate does not activate them. [Lifecycle](lifecycle.md)
defines explicit Start and Restart and [TLS replacement](lifecycle.md#tls-replacement).

## Direct commands and results

The CLI is the complete scriptable interface. Agents can compose every
[local operation](lifecycle.md#commands), including advanced settings and destructive
administration, without interactive prompts. Missing inputs or required confirmations
fail before mutation. Administrative commands retain structured JSON envelopes and
safe failure codes. Help and version produce text. Success exits 0; failure exits 1.

`inspect` reports running state, readiness when available, settings, and recovery.
Running does not imply ready. [Readiness](readiness.md) defines service health.
Unavailable evidence never becomes healthy. `doctor` performs bounded, read-only
prerequisite and installation checks, gives actionable results, and exits 1 when a
required check fails. Neither command repairs, starts Core, or resumes actions.
Doctor checks the saved bind address and port. A running service satisfies that
check only when its verified published binding matches. A different occupied
saved binding fails without stopping either service.
`export` preserves the bounded format and partial results in [diagnostics](diagnostics.md).

## Interactive administration

The TUI uses pinned compatible [Ink](https://github.com/vadimdemedes/ink), React, and
[Ink UI](https://github.com/vadimdemedes/ink-ui) controls. Direct commands load no
renderer. Both interfaces share administration operations and the mutation lock;
capability parity is not a goal.

Home shows the installation, saved endpoint, plain status, and contextual actions.
Before setup, including after completed Hard Reset, it offers Set up Core,
Check installation, and Exit. Established
installations offer ordinary lifecycle control, Settings, Add credential, Diagnostics,
and Refresh status. Missing runtime evidence withholds Start and Stop while keeping
available settings and diagnostics. Ready requires validated service readiness.

Settings edits bind address, HTTPS port, browser origins, and diagnostic level through
plain inputs. Saves validate complete Settings, preserve unexposed values, and check
the displayed revision. Show saved, last verified effective, and last-working evidence
and apply failures. Certificate replacement saves only; activation is separate.
Setup and Add credential generate IDs once per draft and show the resulting key ID.

Other settings, chosen or operator-bound credentials, force-stop, reset, Hard Reset,
update, enrollment, and recovery stay in the CLI. Pending recovery shows its exact
CLI command and effects. Every TUI mutation requires default-No confirmation.
Compact receipts retain safe codes, primary and cleanup failures, bounded failure
lists, partial exports, Doctor instructions, and saved-versus-active TLS evidence.
Failed writes may have committed effects. Only explicit uncommitted evidence permits
"Cancelled before any change"; a normal exit-130 result remains a completed operation.

Escape returns, or requests return after owned work settles, retaining its receipt.
Ctrl-C and terminal loss await owned work and cleanup. Process cancellation exits 130;
operation and cleanup failures take precedence. Refresh never retries mutations.
Closing the TUI leaves Core running.

## Deployment boundary and acceptance

Core configures its own HTTPS endpoint. Users own exposure, DNS, certificate issuance,
tunnels, proxies, gateways, and operator UI hosting. These are not CLI integrations
or health checks. No hosted-versus-field mode or cloud login is required.
[Operator qualification](qualification.md#operator-interface-qualification) owns the
required evidence for both interfaces, according to their different scopes.
