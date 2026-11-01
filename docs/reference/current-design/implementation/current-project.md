# Atlas

> Retained current design for review. [Planning status](../../../README.md#planning-status).

**Atlas coordinates field systems: observe what exists, ask Assets to do work,
and retain what they report.**

Atlas Protocol supplies the browser-safe TypeScript contract. Atlas Core implements
the initial HTTPS/WSS server, durable worker, local lifecycle commands, and container.
SDK provides the browser-safe TypeScript client with HTTP by default, opt-in Full
synchronization, reporting, remote history and verified file transfers. Functional
checks are separate from the unrun sustained-workload and power-loss qualification.

## Three layers, one contract

| Layer              | Owns                                                            | Does not own                                    |
| ------------------ | --------------------------------------------------------------- | ----------------------------------------------- |
| **Atlas Protocol** | Shared vocabulary, schemas, message contracts, observable rules | Databases, server processes, physical execution |
| **Atlas Core**     | A running server that enforces Protocol and retains state       | Physical execution on a drone                   |
| **Atlas SDK**      | An IP-specific TypeScript client for Protocol                   | Server policy or private Core internals         |

Protocol is foundational. Core implements it; SDK speaks it. Applications use
SDK to reach Core. A gateway translates radio traffic; the Asset runtime executes.
Both remain outside Core. The operator UI is a separate Atlas project outside
Core and Protocol. Adequate IP connectivity is the SDK boundary.

Assets publish Observations about detected subjects. Core maintains shared Tracks
through replaceable fusion. The [initial policy](../entities/tracks/tracks.md#default-policy)
creates one Track per Observation. These records remain until a deliberate Reset.

Core, SDK, and the shared runtime boundary use TypeScript. Core uses Node.js and
SQLite behind ordinary modules. One browser-safe Protocol package owns runtime
schemas and inferred types and exports portable OpenAPI through qualified stock
tooling. Core mechanisms and SDK workflows remain ordinary handwritten code.

## Read in this order

Start with the [operating environment](../support/operating-environment.md) for deployment
requirements. The [mission example](../examples/mission.md) shows how an operator,
Atlas Mission, Core, and external Assets work together within the initial scope.

1. [Protocol](protocol-overview.md): what Atlas means and promises.
2. [Core](core-overview.md): how the server provides those promises.
3. [SDK](sdk-overview.md): how other programs use them.

[Atlas Simulations](../simulations/README.md) defines simulated Assets that use
SDK against a real Core. It is a consumer of these layers, not a fourth layer.

Each folder's README gives its short reading order. Contributors also read
[AGENTS.md](contributing.md). There is no separate glossary, decision archive, or audit
folder to reconcile. Earlier explanations remain in Git history, not as a second
active specification.

Use the [Protocol package](protocol-package.md) for runtime schemas,
inferred types, exact boundary validation, and stock OpenAPI export. Its
[qualification commands](qualification/protocol.md) check the built artifact.
Core and SDK define separate qualification commands for consuming workflows and durable behavior.
