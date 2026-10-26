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
Incompatible retained formats never authorize an automatic wipe.

## Commands

Run `node dist/cli.js COMMAND --installation /absolute/owned/installation` locally.
Docker access uses `sudo -n docker`. The image argument is an immutable `sha256:` ID
from `artifacts/image-id`, never a tag. Setup supplies a valid TLS certificate and private key
and a mode-0600 credential JSON file containing `api_key_id`, `request_id`, and `secret`.
The secret is a 32-byte random base64url value. Commands never print that secret.

| Command | Required options or result |
| --- | --- |
| `setup` | `--image ID --certificate FILE --key FILE --credential-file FILE`; optional `--settings FILE` |
| `provision` | `--credential-file FILE`; create another key locally |
| `start`, `inspect`, `stop`, `restart` | Explicit lifecycle; `stop --force` still verifies writer exit |
| `reset`, `recover` | Clear operational state, or explicitly finish an interrupted action; leave Core stopped |
| `hard-reset` | `--confirm-destructive`; leave Core stopped and require setup |
| `update` | `--image ID --confirm-reset`; leave Core stopped |
| `settings show` | Saved, effective and last-working revisions, apply failure, diagnostic limits |
| `settings save` | `--expected-revision N --file FILE`; validate a complete Settings candidate |
| `settings apply` | `--restart`; no automatic application or fallback |
| `export` | `--out FILE`; bounded allowlisted JSONL, with partial-export status |
| `enrollment inspect` | Exact unrevoked local open-enrollment bindings and a warning while enabled |
| `enroll` | `--dataset UUID --request-file FILE`; RegisterAsset facts through the private endpoint |
| `enrollment revoke` | `--binding UUID --api-key UUID --confirm`; revoke that exact binding |

All settings apply through explicit Restart. The selected default Settings are
exported by `dist/settings.js`. Local open enrollment is off by default. Public
RegisterAsset always requires a valid key; local enrollment adds no permission tier.
Disabling enrollment prevents new enrollments but does not revoke existing bindings.

## One command owns each action

Each mutation holds the installation lock and awaits owned subprocesses and writers.
Concurrent mutations return `management_busy`; inspection remains available.
Core owns policy and its private mode-0600 Unix maintenance endpoint. Commands own
Docker access and never edit live SQL. Containers disable logging and automatic restart.
No persistent management service or detached cleanup worker runs after a command exits.

After interrupted Start, Stop, or settings work, inspect actual state before retrying.
A lost control reply proves no exit. Verify immutable container ID, launch, host boot,
PID namespace and start identity before cleanup. Reused PIDs and names prove nothing.
Independent integrations own their processes and storage.

## Reset recovery

Before destructive work, flush a bounded action outside cleared storage: action kind,
old and intended Dataset, immutable writers, phases, and safe primary and cleanup failures.
Use owned paths, atomic replacement, and file and directory flushes. Stop and verify every
writer before deletion. Unverified exit blocks cleanup.

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
Hard Reset retains minimal recovery facts until completion. Fresh setup retires its
old exit proofs before accepting new credentials. User-owned diagnostic exports survive.
Old requests from independent integrations remain fenced by Dataset.

## Retained state and access

Restart retains Task evidence and unresolved execution, Observations, Tracks,
associations, readings, report retries, keys, and bounded logs. It expires HTTP views,
snapshots and contact challenges and sets Asset contact offline. Partial uploads restart
from zero. Whole-Core restart does not promise mission continuity or replay physical work.

HTTPS/WSS use normal certificate verification and explicit trusted origins. Setup
needs no cloud login. Credentials stay out of URLs and diagnostics. Operator and key
rules remain in [Protocol identity](../Atlas%20Protocol/identity.md).
[Diagnostics](diagnostics.md#collection-and-lifetime) owns log and export lifetime.

[Next: service readiness](readiness.md)
