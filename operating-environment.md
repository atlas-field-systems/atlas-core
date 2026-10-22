# Operating environment

This page records the expected conditions around Atlas. Protocol, Core, and SDK
pages own the detailed behavior. Unconfirmed design assumptions are marked below.

## Expected deployment

- Operators normally use a separate Atlas UI project. The UI stays separate from
  Core and Protocol and reaches Core through the SDK. See [system boundaries](README.md#three-layers-one-contract).
- The Core host has internet access. This does not imply reliable connectivity
  between Core, clients, gateways, and Assets.
- Host placement and local administration depend on the deployment.
- SDK clients run on computers with Raspberry Pi 5-class or better compute,
  adequate power, and good Wi-Fi or equivalent IP connectivity. External gateways
  handle constrained radio, and Asset runtimes execute physical work.
- Most Asset integrations use on-demand HTTP and reporting. Full synchronization
  is an opt-in for clients that need a maintained local picture; optional coverage
  still needs measured memory and initial-load budgets on the selected computer.
- Each participant has a separate API key with identical public-API permissions.
  A valid key is sufficient to report for any Asset. See [identity](Atlas%20Protocol/identity.md).

## Normal interruptions

- Packet loss and connection drops lasting seconds or about 30 seconds are normal.
- An Asset can disappear behind terrain and reconnect about five minutes later.
  This is an acceptable operating condition, not a fixed disconnection limit.
- Extreme disaster-survival guarantees are outside the intended scope.

## Existing design assumptions to confirm

- A small field team uses one Linux installation. Initial targets are one or two
  operators, about 20 Assets, and 200 Observations reporting concurrently. The baseline
  fixture retains 200 Tracks under the default policy. Total retained counts can grow
  until Reset. See [deployment](Atlas%20Core/README.md#deployment)
  and [workload targets](Atlas%20Core/qualification.md#workload-targets-not-measured-capability).
- Deployment supplies correct UTC clocks and certificate trust. See
  [time](Atlas%20Protocol/reports.md#time-and-contact) and [setup](Atlas%20Core/lifecycle.md#configuration-and-access).
- Plugins are trusted extension code. See [Plugin trust](Atlas%20Core/plugins.md#installation-and-trust).
- Durability assumes healthy local Linux storage with supported flush semantics.
  Power-loss durability still needs qualification. See [storage](Atlas%20Core/storage.md#publishing-files).

## Failures the design already addresses

- Connections can fail and replies can be lost. A lost reply leaves the outcome
  uncertain until reconciled. See [SDK requests](Atlas%20SDK/requests.md).
- An Asset can become unreachable while physical work continues. Reconnection
  does not authorize repeating uncertain work. See [recovery](Atlas%20Protocol/reports.md#movement-and-recovery).
- Core can stop or restart. Retained data does not promise mission continuity.
  See [lifecycle](Atlas%20Core/lifecycle.md).
- Storage can fill. Core refuses new work rather than silently deleting protected
  facts. See [capacity](Atlas%20Core/storage.md#retention-and-capacity).
