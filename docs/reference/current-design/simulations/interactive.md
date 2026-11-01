# Interactive runs

> Retained current design for review. [Planning status](../../../README.md#planning-status).

**An interactive run keeps simulated Assets alive in Core until you stop it.**
Assets appear in Atlas Mission, or in any SDK client, and respond to the Tasks you
send. The simulator never creates a Task in this mode.

## Start a run

Start Core first and [provision a key](../support/lifecycle.md#commands) for
the simulator. Then run this command from `Atlas Simulations`.

```sh
npm run simulate -- \
  --scenario scenarios/road-inspection.json \
  --core https://core.example:8443 \
  --credential-file /absolute/path/to/simulator-key.json
```

| Option | Meaning |
| --- | --- |
| `--scenario` | The [scenario file](scenarios.md). `timeline`, `deadline_seconds`, and `expect` are ignored |
| `--core` | Core base URL. Configure a private CA before you start Node |
| `--credential-file` | A mode-0600 file with the key that registers Assets |

## What you see

For the example scenario, Mission shows `Drone 1` and its run ID at the start
position, with `healthy` communications. The Asset's `tags` section holds `simulated`.

1. Queue a Move To. Core accepts the Task, and the Asset reports `in_progress`
   within about one second.
2. Watch the position change twice per second at `cruise_speed`.
3. Request Pause. The Asset holds position, and Mission shows the Pause as confirmed.
4. Request Resume. The Asset continues the same Task and reports `completed` on arrival.
5. When Vehicle 1 enters the detection radius, a new Track appears.

## Stop a run

Press Ctrl-C or send SIGTERM. The run stops its timers, awaits in-flight writes,
revokes the API keys it created, and awaits `client.close()` for every Asset. It
exits 0 only after all of that cleanup succeeds, and it exits 1 with each failure
listed otherwise. A second signal does not skip cleanup. The run reports a stalled
write and exits 1 after 30 seconds.

Stopping deletes no Asset. Assets stay registered, reach `offline` after 60 seconds,
and keep their Tasks in the last reported state until Reset. Core has no tag filter,
so a client that hides simulated Assets reads `tags` on each Asset. An Asset that
stopped before its first report has no Tags, and only its alias suffix identifies it.
Each new run registers new Assets.

## Refusals

| Situation | Result |
| --- | --- |
| Invalid scenario | Exit 2 before any network work |
| Core Reset during a run | Exit 1. See [failure behavior](asset-runtime.md#failure-behavior) |
| Registering key rejected | Exit 1 and register nothing |

[Next: eval runs](evals.md)
