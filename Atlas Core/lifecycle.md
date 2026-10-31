# Lifecycle and local administration

**Restart retains data. Reset clears it. Neither reruns uncertain work.**

| Action | Operational data and logs | Installation setup |
| --- | --- | --- |
| Start | Open retained data, or initialize first use | Reapply retained setup |
| Stop | Retain; stop Core | Retain |
| Restart | Retain | Retain |
| Reset | Clear; establish a new Dataset | Retain keys and operator profiles |
| Hard Reset | Clear all Atlas-owned state | Clear setup, keys, and trust |

Updates require an explicit Reset between missions. There is no operational-data
migration or backup/restore. Hard Reset keeps software and unrelated host resources.
Installation-format conversion must be deliberate and preserve identity, revocation,
and credentials. Incompatible retained formats never authorize an automatic wipe.
Before recording update intent, the target image checks the retained database
format through a read-only one-shot. An incompatible format returns
`incompatible_format` without changing data, credentials, or installation setup.
Use a fresh installation for that release; Reset does not convert old formats.

## Commands

Run `node dist/cli.js COMMAND --installation /absolute/owned/installation` locally.
Source and packaged commands use the same parser and dispatcher. Omitted installation
selects `~/.atlas/core`; an explicit path must be absolute. Invalid arguments fail
before installation writes. See [command-line administration](command-line.md).
Docker access uses `sudo -n docker`. The image argument is an immutable `sha256:` ID
from `artifacts/image-id`, never a tag. Packages supply their recorded image by default. Setup supplies a valid TLS certificate and private key
and a mode-0600 credential JSON file containing `api_key_id`, `request_id`, and `secret`.
The secret is a 32-byte random base64url value. Commands never print that secret.
Local JSON records are limited to 64 KiB before parsing. Readers consume at most
one extra byte to detect excess, then close the input and return `record_limit`.
The limit applies while reading, including when the input continues producing data.

| Command | Required options or result |
| --- | --- |
| `setup` | `--image ID --certificate FILE --key FILE --credential-file FILE`; optional `--settings FILE` |
| `doctor`, `help`, `version`, `tui` | Prerequisites, usage, release identity, or guided terminal interface |
| `tls show`, `tls replace` | See TLS replacement below |
| `provision` | `--credential-file FILE`; create another key locally |
| `start`, `inspect`, `stop`, `restart` | Explicit lifecycle; `stop --force` still verifies writer exit |
| `reset`, `recover` | Clear operational state, or explicitly finish an interrupted action; leave Core stopped |
| `hard-reset` | `--confirm-destructive`; leave Core stopped and require setup |
| `update` | `--image ID --confirm-reset`; leave Core stopped |
| `settings show` | Saved and effective values, last-working revision, apply failure, diagnostic limits |
| `settings save` | `--expected-revision N --file FILE`; validate a complete Settings candidate |
| `settings apply` | `--restart`; no automatic application or fallback |
| `export` | `--out FILE`; bounded allowlisted JSONL, with partial-export status |
| `enrollment inspect` | Exact unrevoked local open-enrollment bindings and a warning while enabled |
| `enroll` | `--dataset UUID --request-file FILE`; RegisterAsset facts through the private endpoint |
| `enrollment revoke` | `--binding UUID --api-key UUID --confirm`; revoke that exact binding |

All settings apply through explicit Restart. The selected default Settings are
exported by `dist/settings.js`. Settings use local commands, never public SDK routes.
Local open enrollment is off by default. Public
RegisterAsset always requires a valid key; local enrollment adds no permission tier.
Disabling enrollment prevents new enrollments but does not revoke existing bindings.

## One command owns each action

Each mutation holds the installation lock and awaits owned subprocesses and writers.
Concurrent mutations return `management_busy`; inspection remains available.
Core owns policy and its private mode-0600 Unix maintenance endpoint. Commands own
Docker access and never edit live SQL. Containers disable logging and automatic restart.
There is no persistent management service, takeover control, or automatic recovery.
No detached cleanup worker runs after a command exits.
Core stops scheduling maintenance and awaits active maintenance and summary work
before closing transfers and HTTP. Diagnostics drain before their database worker
reservation owner closes. Shutdown
retains maintenance failures alongside cleanup failures. File reclamation completes
its durable bookkeeping before the worker closes; Stop still verifies process exit.
Failed Start attempts shutdown and writer-exit verification even when recording
`apply_failure` fails. It retains the original, bookkeeping, and cleanup failures;
an unwritten exit proof never counts as verified cleanup. CLI `failures` lists up to
eight safe failure codes, including the primary; it omits raw error messages and paths.

After interrupted Start, Stop, or settings work, inspect actual state before retrying.
A lost control reply proves no exit. Verify immutable container ID, launch, host boot,
PID namespace and start identity before cleanup. Reused PIDs and names prove nothing.
Independent integrations own their processes and storage.

## Reset recovery

Before destructive work, flush a bounded action outside cleared storage: action kind,
old and intended Dataset, immutable writers, phases, and safe primary and cleanup failures.
Use owned paths, atomic replacement, and file and directory flushes. Stop and verify every
writer before deletion. Unverified exit blocks cleanup.
Update recovery repeats the target image's compatibility check before cleanup,
including intents written by older commands. Refusal leaves the action pending.
If an older command already deleted files, recovery cannot restore those files.

Clear operational data, logs, and activity. Core atomically establishes the intended
Dataset and action marker, then the command flushes independent matching proof before
serving. Recovery reads these facts through a Core-owned offline readonly one-shot,
without opening an ordinary writer or trusting phase labels alone.

- Matching marker and Dataset, with matching or absent proof: preserve that Dataset,
  regenerate missing proof, and finish recorded old cleanup.
- Verified absence of this action's marker and proof, intact intent, and only the
  old Dataset or cleared storage: finish old cleanup and establish once.
- Missing or corrupt intent, unreadable or conflicting facts, or absence after recorded
  establishment: refuse for repair. Never wipe ambiguous state.

Ordinary Start refuses incomplete destructive work. Nothing resumes automatically.
Hard Reset retains minimal recovery facts until verified completion. Fresh setup retires its
old exit proofs before accepting new credentials. User-owned diagnostic exports survive.
Old requests from independent integrations remain fenced by Dataset.

## Retained state and access

Restart retains Task evidence and unresolved execution, Observations, Tracks,
associations, readings, report retries, keys, and bounded logs. It expires HTTP views,
snapshots and contact challenges and sets Asset contact offline. Partial uploads restart
from zero. Whole-Core restart does not promise mission continuity or replay physical work.

HTTPS/WSS use normal certificate verification and explicit trusted origins, with no TLS bypass.
Offline setup supplies local trust, preloaded images and reference data, and the first credential.
Setup needs no cloud login. Credentials stay out of URLs and diagnostics. Operator and key
rules remain in [Protocol identity](../Atlas%20Protocol/identity.md).
Setup flushes both retained TLS files before recording the installation manifest.
A file-flush or close failure stops setup and preserves the failure for repair.
An incomplete first setup has no committed installation identity. It refuses overwrite
and lifecycle recovery. Preserve that path for repair and select a fresh path for setup.
[Diagnostics](diagnostics.md#collection-and-lifetime) owns log and export lifetime.
Await diagnostic writers before clearing logs. Unmanaged container or host logs must not escape Reset.

## TLS replacement

`atlas-core tls replace --certificate /absolute/cert.pem --key /absolute/key.pem`
saves a validated pair. `--restart` explicitly stops and starts Core to activate it.
Both inputs must be regular files, at most 64 KiB, with a current matching certificate.
The dispatcher holds one flock. Two mode-0600 files are flushed in an immutable
`setup/tls/UUID` directory before an atomic `tls-state.json` pointer commit.
The runtime resolves the saved pointer once per launch. Save leaves the running
service unchanged. `tls show` reports saved and last verified active fingerprints,
expiry, pending activation, and activation failure. Readiness alone permits active evidence.

An interrupted save leaves `tls-journal.json`. Start refuses it. Stop the service,
then explicitly `recover`; recovery validates pointer and generation evidence,
including intact expired historical pairs. New saves and startup still require
current certificates; recovery never activates a pair. Recovery proves all writers
stopped and prunes only unreferenced generations. Seven generations
bound saves; reaching the bound requires this explicit recovery. Failed activation
retains the candidate and prior verified evidence without automatic rollback.
Legacy fixed TLS files require explicit `tls replace` conversion before start.
Start on an already ready service retains its loaded TLS and settings. Restart
activates saved candidates; readiness of an older service cannot activate a new pair.
Certificate issuance and renewal scheduling belong to deployment tooling.

[Next: service readiness](readiness.md)
