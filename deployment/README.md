# Local Core deployment

Build the three Go commands with the repository's locked toolchain. Build Core
statically with `CGO_ENABLED=0 go build -o build/atlas-core ./cmd/atlas-core`.
Build `./cmd/atlas` and `./cmd/atlas-manager` into the same `build` directory.
From the repository root, load the local image with
`docker build --network=none -f deployment/Dockerfile -t atlas-core:s1 'Atlas Core/build'`.
The image contains the production Core executable. No build dependency or Docker
socket enters Core. Once the image and tools are loaded, setup requires no network.

Choose an installation UUID and prepare a caller-owned directory with mode 0700.
`atlas prepare --output-dir /private/operator --server-names 127.0.0.1,atlas.local`
writes `admin.key` and `setup.json`. Retain the key before setup. Commands never
accept a key on their command line or return one in status/history.

Create the manager configuration using `atlas manager-config --installation-id
UUID --image atlas-core:s1 --output /private/manager.json`. Defaults use dedicated
installation, external recovery and runtime directories. Local development may
specify `--root`, `--recovery-root` and `--runtime-root` as three disjoint absolute
directories. `--sudo-docker` chooses the actual `sudo -n docker` host transport
when the owner has authorized sudo access instead of direct daemon access.

Run `atlas-manager --config /private/manager.json` as the installation owner in a
separate process. The supported persistent profile installs the binary at
`/opt/atlas/bin/atlas-manager`, the configuration at `/etc/atlas/UUID/manager.json`
and `atlas-manager@.service` in `/etc/systemd/system`. Add an instance drop-in
with `User=INSTALLATION_OWNER`, make the configuration and three roots owned by
that account, then `systemctl enable --now atlas-manager@UUID`. The manager remains
alive when a CLI closes and while Core is stopped. Its restart policy applies to
the manager. Core's Compose restart policy is `no`.

Use the shared local Unix client for every action:

```sh
atlas setup --socket /run/atlas/UUID/manager.sock --input /private/operator/setup.json
atlas export-ca --socket /run/atlas/UUID/manager.sock --output /private/operator/ca.crt
atlas start --socket /run/atlas/UUID/manager.sock
atlas status --socket /run/atlas/UUID/manager.sock
atlas stop --socket /run/atlas/UUID/manager.sock
atlas restart --socket /run/atlas/UUID/manager.sock
atlas reset --socket /run/atlas/UUID/manager.sock
```

Each submission prints its nonsecret action identity before waiting. A finite
wait ending leaves the outcome unknown; inspect it with `status --action-id ID`
or `retry --action-id ID`. Retry never requests another Reset. A new Reset uses
the current inspected Reset revision, expires the preceding completed result
at acceptance, and retains setup. Pending Reset blocks other actions. Its next
retry or service startup queries Core's independently stored establishment
identity before any cleanup. After establishment it preserves the new Dataset
and newly written logs. Docker logs are cleared by removing stopped owned
containers, through Docker itself. Start/Restart archive those logs into the
owned installation log directory before replacement.

The manager socket checks exact Unix peer owner UID or an explicitly configured
primary management GID. Core's separately mounted private socket accepts only
the owner UID and checks its current run identity. The host never opens SQLite.
Stopped setup and inspection use a maintenance-only Core container.

Deployment enrollment grants are generated locally with `atlas enroll --socket
SOCKET --input /private/asset/grant-input.json --output /private/asset/grant.json`.
The owner prepares and retains the Asset credential and Ed25519 recovery private
key first. Grant input contains `authorization_id`, `installation_id`, `asset_id`,
`credential_id`, the unpadded base64url SHA256 `credential_verifier`, the unpadded
base64url Ed25519 `recovery_public_key`, and an empty `proof`. The manager signs
RFC8785 facts with its retained installation enrollment authority. The SDK
receives the grant and caller-prepared credential, and Core retains public
verification material. Ordinary Reset does not revoke them. Asset private keys
and retention remain with the external deployment or Asset runtime.

This S1 deployment installs no Plugins and has no Hard Reset or update command.
The manager exposes writer-stop, exit-proof, operational-cleanup, startup and
Core-loss extension hooks for their later owning slices.

## Run the offline S1 demonstration

After building `atlas` and `atlas-manager` into `.artifacts`, loading the Core
image and installing the locked SDK dependencies, run from the repository root:

```sh
python3 examples/s1/offline-demo.py --artifacts .artifacts --image atlas-core:s1
```

This Linux profile requires the installation owner's existing passwordless sudo
access to Docker, `unshare` and `nsenter`. It runs the manager and CLI in private
network namespaces, creates a separate installation through the production CLI,
and disconnects every network from that installation's running Core container.
It checks that Core's namespace contains only loopback and that an external TCP
connection returns `ENETUNREACH`. The actual Node SDK demonstration then runs in
the same namespace and connects to Core over CA-verified HTTPS on loopback.
The printed result shows progress, completion, cancellation and single execution
retention. The runner stops Core and cleans up only its own labeled containers,
network and temporary owner-only files, including when the demonstration fails.
It does not modify host firewall rules or require Internet access during the run.
