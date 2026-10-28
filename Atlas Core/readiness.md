# Service health and readiness

**Readiness means Core can safely serve its public API. Health also reports
installation-wide degradation.** These predicates belong to Core, separate from
Asset contact health and SDK picture readiness. Protocol owns the response shapes.

| Core state | `healthy` | `ready` | Public behavior |
| --- | --- | --- | --- |
| Normal service | true | true | Admit work under ordinary guards and budgets |
| Installation-wide ordinary-write admission paused by storage pressure | false | true | Keep safe reads and reserved control/terminal paths; refuse new ordinary work |
| Isolated Object integrity fault | false | true | Refuse that Object's content; preserve metadata and unrelated operations |
| Startup or incomplete destructive recovery | false | false | No ordinary work before retained authority and Dataset are established |
| Draining for Stop or Restart | false | false | Stop new work; resolve owned operations and streams before exit |
| Database worker failure or loss of trusted global authority | false | false | Stop domain work; require explicit local recovery |

An ordinary per-request validation, authentication, or quota refusal does not itself
change these predicates. Diagnostic loss does not change readiness or authorize retries.
Clear degradation only after its underlying condition is verified resolved.
Readiness never promises every proposed write will pass its guards or budget.

GetHealth retains its authenticated discovery envelope. GetReadiness returns
`{ready: false}` in its success envelope with HTTP 503 when not ready.
If Core cannot establish current context or authenticate safely, do not invent
discovery data merely to return these booleans. Refuse safely when possible.
Local inspection and host force-stop remain available under [lifecycle rules](lifecycle.md).

Probe results do not commit domain work, prove physical execution, trigger an
automatic restart, or resume interrupted destructive actions. Public mutations
still use their own authority, transaction, and failure rules.

Qualify startup, draining, worker failure, storage admission pressure, and a damaged
Object through real endpoints. Check retained reads and reserved control behavior,
not just the probe booleans. `npm test` covers these Core paths; it does not
establish sustained workload or power-loss qualification.

[Next: fusion](fusion.md)
