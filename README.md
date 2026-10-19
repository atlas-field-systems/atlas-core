# Atlas

**Atlas coordinates field systems: observe what exists, ask Assets to do work,
and retain what they report.**

Atlas Protocol includes an executable contract package with generated Go and
TypeScript declarations and stateless validation. Core and SDK remain design
documents. There is no implemented Core server, SDK runtime, or qualified deployment.

## Three layers, one contract

| Layer | Owns | Does not own |
| --- | --- | --- |
| **Atlas Protocol** | Shared vocabulary, schemas, message contracts, observable rules | Databases, processes, server or client workflows |
| **Atlas Core** | A running server that enforces Protocol and retains state | Physical execution on a drone |
| **Atlas SDK** | An IP-specific TypeScript client for Protocol | Server policy or private Core internals |

Protocol is foundational. Core implements it; SDK speaks it. Applications use
SDK to reach Core. A gateway translates radio traffic; the Asset runtime executes.
Both remain outside Core. The operator UI is a separate Atlas project outside
Core and Protocol. Adequate IP connectivity is the SDK boundary.

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

The [Protocol package](Atlas%20Protocol/README.md#verify-and-consume) supplies the
executable wire contract and independent acceptance fixtures. Core and SDK behavior
still requires implementation and integration qualification.
