---
status: accepted
---

# Use Core time as the installation reference clock

Accepted on 28 September 2026. Several accepted rules depend on comparing times recorded by different participants: Track observation age for Commands that need current data under [ADR-0022](0022-one-publisher-per-track.md#track-data-used-by-commands), freshness windows for Asset [Contact](../topics/asset-reporting.md#contact-and-freshness), Command validity and execution deadlines under [ADR-0007](0007-reconcile-asset-tasks-after-disconnection.md#queued-and-immediate-scheduling), and the expiry of Resume. An installation operates without internet access under [ADR-0010](0010-operate-without-internet-access.md), so participants cannot be assumed to share a time server, and a clock that drifts by a minute can silently turn fresh data stale or an expired control valid.

## Decision

Core time is the installation's reference clock. Core records receipt times in Core time, and observation age, Contact freshness, Command validity, execution deadlines and Resume expiry are judged in Core time. Other participants estimate their offset from Core while connected and use that estimate to report observation times in Core time and to judge deadlines while disconnected. A radio gateway conveys Core time or the offset to its bound Assets, and the Asset OS applies it while disconnected. Core does not rewrite a reported observation time, and an unknown observation time stays unknown.

Core time need not be correct absolute time. Consistency across the installation matters more than agreement with an outside source. A deployment may discipline the Core host's clock from GPS or another local source, but Atlas does not require it.

## Alternatives considered

- **Require synchronized clocks on every participant**, for example through NTP or GPS. This moves a correctness condition into deployment and fails silently when one device drifts or lacks a fix.
- **Leave each participant on its own clock.** Comparisons across participants would then be unreliable, and nothing would detect the error.

Using Core time makes drift a measured quantity rather than a hidden assumption, at the cost of an offset estimate in the Asset client, gateways and other SDK consumers.

## Consequences

- The SDK, including the Asset client, maintains the offset estimate and exposes its uncertainty where a rule depends on it; gateways pass it on to bandwidth-limited Assets. The exact estimation method, uncertainty bounds and wire fields remain engineering work.
- A Command whose rule depends on age or a deadline states how it treats offset uncertainty.
- An adjustment of the Core host's clock during or between Core runs must not make retained reports appear fresh or expire valid work; handling it is engineering work.
- The [testing strategy](../testing-strategy.md#required-scenario-coverage) must exercise participants with skewed clocks, including a disconnected Asset judging Resume expiry.
