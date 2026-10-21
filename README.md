# Atlas

**Atlas coordinates field systems: observe what exists, ask Assets to do work,
and retain what they report.**

This repository is a documentation-only design experiment. Nothing here claims
an implemented API, generated package, passing runtime, or qualified deployment.

## Three layers, one contract

| Layer | Owns | Does not own |
| --- | --- | --- |
| **Atlas Protocol** | Shared vocabulary, schemas, message contracts, observable rules | Databases, processes, implementation |
| **Atlas Core** | A running server that enforces Protocol and retains state | Physical execution on a drone |
| **Atlas SDK** | An IP-specific TypeScript client for Protocol | Server policy or private Core internals |

Protocol is foundational. Core implements it; SDK speaks it. Applications use
SDK to reach Core. A gateway translates radio traffic; the Asset runtime executes.
Both remain outside Core. The operator UI is a separate Atlas project outside
Core and Protocol. Adequate IP connectivity is the SDK boundary.

Assets publish Observations about detected subjects. Core maintains shared Tracks
through replaceable fusion. The [initial policy](Atlas%20Protocol/tracks.md#default-policy)
creates one Track per Observation. These records remain until a deliberate Reset.

**Contract-first, not generator-first.** Generate repetitive declarations where
stock tools help. Write Core behavior and SDK workflows as ordinary code.

## Read in this order

Start with the [operating environment](operating-environment.md) for deployment
expectations and remaining assumptions. The [draft mission example](mission-example.md)
shows how an operator, Atlas Mission, Core, and external Assets could work together.

1. [Protocol](Atlas%20Protocol/README.md): what Atlas means and promises.
2. [Core](Atlas%20Core/README.md): how the server provides those promises.
3. [SDK](Atlas%20SDK/README.md): how other programs use them.

Each folder's README gives its short reading order. Contributors also read
[AGENTS.md](AGENTS.md). There is no separate glossary, decision archive, or audit
folder to reconcile. Earlier explanations remain in Git history, not as a second
active specification.

These pages are the current design baseline, not a complete executable wire
specification. Concrete schemas and independent acceptance examples remain incomplete.
