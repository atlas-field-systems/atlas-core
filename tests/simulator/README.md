# S1 simulator and demonstration

The simulator is an external test and example adapter for [spec #122](https://github.com/atlas-field-systems/atlas-core/issues/122). It is not an Asset OS inside Core. It keeps the ownership split of the [Asset client](../../docs/topics/sdk.md#asset-client):

| Part | Owns |
| --- | --- |
| `asset-os.ts`, the private Asset OS fixture | Scheduling and execution in its own queue order, the 5 m arrival rule, execution identities and counts, `completed`/`running`/`suspended`/`not_started`/`unknown` state, held continuations behind unknown work, explicit recovery, the recovery key, the credential, and retained evidence with pending registration, report and authority-claim descriptors. Its JSON retention file is written atomically and outlives any reporting process |
| `keys.ts`, the trusted-runtime callbacks | Ed25519 signing for the current reporting process and replacement authorization for the Asset OS. The SDK receives signatures, never keys |
| `reporting.ts`, one reporting process | Core-facing traffic through the SDK `AssetClient`: registration, process-authority claims, assigned-work delivery to the Asset OS, and reports of retained evidence. Evidence prepared while connected is current; evidence that could not be prepared is later reported as historical with its original time and stable identity, and descriptors from an earlier process keep their original report identity as `evidence_origin` |
| `installation.ts`, the local driver | The real `atlas-manage` CLI over the shared host-management implementation, plus verified HTTPS links to Core |

The Asset OS never derives outcomes from Core Task status or SDK submission results, and the reporting process never schedules, starts or reruns work. After a known Reset, obsolete descriptors are discarded rather than relabelled, the Asset registers again with a new registration identity, and its first claim in the new Dataset expects generation 0.

## Run the demonstration

From the repository root, after `python3 scripts/verify.py --bootstrap` (or at least locked dependencies and `scripts/build_core.py`), with a local Docker daemon:

```sh
python3 scripts/build_core.py
node tests/simulator/demo.mjs "$(mktemp -d)"
```

`--port PORT` selects the local HTTPS port; otherwise a free one is used. The demonstration runs CLI setup, generating the first administrator key and the enrollment authority into owner-only files and exporting the CA. It then Starts Core, discovers it with the operator SDK, enrolls and registers a simulated Asset, and issues two queued Move To Tasks while the Asset is offline. The Asset claims process authority with a signed check-in and executes the first Task through 12.5, 5.1 and 4.9 m to completion. The operator requests cancellation of the second Task, the Asset confirms it, and Core Restarts with its Dataset retained before Stopping. The installation stays in the directory. Remove it with `docker compose --file DIR/*/root/setup/compose.json down`, then delete the directory.

The same demonstration runs in `tests/s1/setup.test.ts` inside a network namespace that has only loopback, which shows that setup, management, the SDK and the simulator need no internet once images and tools are loaded.
