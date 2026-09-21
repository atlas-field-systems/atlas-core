# Temporary mission extensions

Research record: historical evidence and proposals. Read the [status and decision pointers](README.md#status-and-authority) before using this report for successor planning.

Status: clarified product requirement and proposed design direction. This updates the earlier research hypothesis that integration capabilities could default to built-in Core modules. No execution or packaging technology has been selected.
## Why Plugins exist

The user needs capabilities that may be used for one flight, one test, or compatibility with one particular system. A specialized signal-report processor is a concrete example. Its implementation belongs in a separate repository that can be archived after use. Atlas should remain usable after the extension is removed, without retaining that experiment's dependencies or specialized implementation.

This is a reason to preserve an extension mechanism alongside permanent Core modules. The requirement is independent ownership and removal. It does not by itself require a marketplace, automatic updates, hot loading, or the old signed catalog and deployment manager.

## Proposed division

| Permanent Core modules | Optional mission extensions |
| --- | --- |
| Shared Entity, Task, content, identity and synchronization behavior that Atlas promises to support | Specialized processing, experimental detectors, temporary source formats and one-system compatibility |
| Developed and released with the Core system | Developed in separate repositories and attached only to deployments that need them |
| Own the durable resource and execution contracts | Consume those contracts and publish results through supported interfaces |
| Continue working when an extension is absent | Can be stopped, removed and archived without leaving required code in Core |

Publishing an Entity or processing an Asset Task result does not make the producer a Core module. A temporary processor uses supported APIs but does not execute or complete Asset Tasks itself. Core retains authority over its resources; the processor owns its algorithm and dependencies.

## Smallest architecture to compare

Start by testing an explicitly configured external program or container from a separate repository. Use the SDK for all ordinary Atlas API interaction, including Object upload and download. Keep Plugin-specific coordination limited to behavior Atlas manages, such as capability discovery, invocation, cancellation and health. Installation/configuration and process lifecycle controls remain internal to local CLI/TUI administration, outside the public API and SDK. A standalone processor that only reads inputs and publishes results may need no private Plugin protocol at all.

This is a proposal, not a requirement to use containers or a specific transport. Compare it with an in-process package if that really removes its dependencies from the normal Core build and deployment. The external-program approach is a strong candidate when the processor needs its own language or scientific dependencies.

Start with explicit operator configuration and an identified artifact version. Independent repositories do not imply that Atlas must operate a general distribution service. Decide installation automation and catalog trust separately from the extension interface.

## Prove removal, not only installation

Use a specialized signal-report processor as the first extension experiment:

1. Build it from its own repository without changing Core's source, lockfile or ordinary build.
2. Supply a bounded input or reference to recorded reports, run the processor, and publish results through supported Atlas contracts.
3. For planned stops and updates, cease new admission and stop ingestion, then finish or explicitly cancel finite work. Exercise explicit force stop when cooperative shutdown fails. Record an honest outcome. Keep the outcomes of Asset Tasks that produced input Objects separate from the processing outcome.
4. Remove the extension and its credentials/configuration while Core stays running. Verify that Core works without its artifact or repository available.
5. Verify that results and provenance remain readable after Plugin removal. With a separate control Plugin still installed, exercise Stop then Start, and Restart; verify retained operational data and Atlas-managed diagnostic logs. Run Reset and verify Core starts with those records/logs cleared while the control Plugin's installed selection, configuration, credentials and artifact survive. Reset also changes the dataset identifier. Retain extension provenance with results until Reset.
6. Archive the extension's source and enough build/dependency information to identify what ran. Archiving source alone does not guarantee a future rebuild or continued compatibility with a later Core.

The acceptance rule is that removing the extension removes its specialized implementation and dependency burden from normal Atlas development. Results remain after Plugin removal and ordinary Core Stop/Start or Restart. Reset clears operational data and Atlas-managed logs; independent Plugin lifecycle changes do not themselves restart or reset Core.

## Avoid moving the same coupling into Protocol

The successor keeps Asset Commands in Core. An operator tasks an Asset to scan an area. The Asset produces an Object in a format determined by its capabilities, such as scan data from a software-defined radio and antenna. The operator separately invokes a Plugin Operation on that Object to process it and produce a result. This does not add an Asset Command. Area/building searches can be Plugin Operations; source gathering can run through the managed Plugin lifecycle. These capabilities do not require Tool Assets.

Test how a temporary capability declares its input and output contracts without changing the permanent Core schema for every experiment. Evaluate a small Operation interface and shared resource rules; let the extension own specialized payload validation where appropriate. Decide how results can remain interpretable after that extension disappears. This is a design question to resolve with the first processor, not a commitment to a generic form builder or universal schema engine.

A one-off compatibility adapter can stay an extension even if it uses the same runtime as Core. Expected lifetime and maintenance ownership are stronger criteria than whether its code could fit inside the server.

## Revised recommendation

Design a modular Core with a small optional extension interface. Keep permanent capabilities inside Core where that ownership is justified. Keep temporary mission capabilities outside its repository and normal release. Evaluate how much management the extension needs from an actual install, execution, removal and archive workflow.
