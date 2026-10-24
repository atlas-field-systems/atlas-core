# Atlas

**Atlas coordinates field systems: observe what exists, ask Assets to do work,
and retain what they report.**

Atlas Protocol includes an executable browser-safe TypeScript package. Core and
SDK remain design contracts; this repository supplies no running Atlas server,
SDK workflows, or qualified deployment.

## Three layers, one contract

| Layer | Owns | Does not own |
| --- | --- | --- |
| **Atlas Protocol** | Shared vocabulary, schemas, message contracts, observable rules | Databases, server processes, physical execution |
| **Atlas Core** | A running server that enforces Protocol and retains state | Physical execution on a drone |
| **Atlas SDK** | An IP-specific TypeScript client for Protocol | Server policy or private Core internals |

Protocol is foundational. Core implements it; SDK speaks it. Applications use
SDK to reach Core. A gateway translates radio traffic; the Asset runtime executes.
Both remain outside Core. The operator UI is a separate Atlas project outside
Core and Protocol. Adequate IP connectivity is the SDK boundary.

Assets publish Observations about detected subjects. Core maintains shared Tracks
through replaceable fusion. The [initial policy](Atlas%20Protocol/tracks.md#default-policy)
creates one Track per Observation. These records remain until a deliberate Reset.

Core, SDK, and the shared runtime boundary use TypeScript. Core uses Node.js and
SQLite behind ordinary modules. One browser-safe Protocol package owns runtime
schemas and inferred types and exports portable OpenAPI through qualified stock
tooling. Core mechanisms and SDK workflows remain ordinary handwritten code.

## Read in this order

Start with the [operating environment](operating-environment.md) for deployment
requirements. The [mission example](mission-example.md) shows how an operator,
Atlas Mission, Core, and external Assets work together within the initial scope.

1. [Protocol](Atlas%20Protocol/README.md): what Atlas means and promises.
2. [Core](Atlas%20Core/README.md): how the server provides those promises.
3. [SDK](Atlas%20SDK/README.md): how other programs use them.

Each folder's README gives its short reading order. Contributors also read
[AGENTS.md](AGENTS.md). There is no separate glossary, decision archive, or audit
folder to reconcile. Earlier explanations remain in Git history, not as a second
active specification.

Use the [Protocol package](Atlas%20Protocol/package-usage.md) for runtime schemas,
inferred types, exact boundary validation, and stock OpenAPI export. Its
[qualification commands](Atlas%20Protocol/qualification.md) check the built artifact.
Core and SDK must still qualify their own consuming workflows and durable behavior.
