---
status: accepted
---

# Deploy Core and Plugins as sibling Docker containers

Use Docker Compose to group the Atlas installation on one server, with one Core container and a separate container for each installed Plugin. Keep Core's internal responsibilities in one Go process. The user accepted this layout on 21 September 2026 to package Plugin dependencies and manage their lifecycles independently while preserving ordinary calls and transactions inside Core.

```text
Docker host
  Atlas Compose project
    Core container
      Entities, Tasks, Objects and supporting modules
    Plugin A container
    Plugin B container

  Mounted storage
    Operational database, Object content and Atlas-managed logs
    Retained installation setup, configuration and credentials
```

The containers are siblings managed by the host Docker Engine. A Compose project groups them; it is not a containing runtime or a nested Docker installation. Image layers package files, not Atlas subsystems. See [Docker's multi-container model](https://docs.docker.com/get-started/docker-concepts/running-containers/multi-container-applications/).

## Ownership and lifecycle

Core's Plugins module owns lifecycle policy, including admission, protected stopping and reported outcomes. Local CLI/TUI administration and a private Docker integration carry out container actions under that policy. Docker engine control stays in the trusted management path and is not exposed through the public Atlas API, SDK or Plugin containers. Its exact host-versus-Core placement and private coordination channel remain implementation choices. [Docker daemon access](https://docs.docker.com/engine/security/) grants substantial host control; this decision does not mandate mounting its socket into Core.

Apply [independent Plugin lifecycle](0002-core-manages-installed-plugins.md) and [active-work protection](0006-protect-active-plugin-work-during-lifecycle-changes.md) when installing, stopping or replacing a Plugin container. A Compose action must not restart Core or unrelated Plugins as a side effect. Containerization does not introduce automatic Plugin recovery or retry failed Operations. Installed images must be available before an offline mission, following [ADR-0010](0010-operate-without-internet-access.md).

SDK and Protocol are release artifacts and need no standalone runtime containers. SQLite is embedded in Core and needs no database container. Plugins use the SDK and receive no direct mount of Core's database or Object store. Each Plugin may package its own runtime and dependencies; additional system containers need a concrete independent-execution requirement.

## Storage and scope

Use mounted persistent storage whose lifetime is independent of container replacement. Keep operational data separate from retained installation setup so [Reset](0015-separate-start-stop-restart-and-reset.md) can clear the former while preserving the latter. Stop/Restart preserve both. Reset must also clear Atlas-managed diagnostic logs, including any managed through Docker; merely restarting a container is not Reset. [Hard Reset](0015-separate-start-stop-restart-and-reset.md#hard-reset) additionally removes this installation's setup, managed Plugin containers/data/artifacts and managed logs while retaining Core software and unrelated Docker resources. Its coordinator must outlive Core shutdown and prevent automatic restart during cleanup. Volume names, mount layout and log-cleanup mechanics remain implementation choices. See [Docker volume lifecycles](https://docs.docker.com/engine/storage/volumes/).

Separate containers for Entities, Tasks and Objects were rejected because they would introduce network calls and partial failures into closely related responsibilities. Containers are selected for independently managed Plugins. Registry choice, Plugin manifest/install format, host support matrix, resource limits and update tooling remain open. Docker Compose is the deployment choice; no Compose implementation, container images or new management service are created by this decision.
