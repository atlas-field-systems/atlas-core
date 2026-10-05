# Resource limits

Proposal only. Priority: high. This is a clarification requiring judgment about the resource being bounded.

## Evidence

| Finding | Consequence | Source |
| --- | --- | --- |
| Core's reusable JSON adapter depended on an outer fixture limit | Another caller could buffer an unbounded request before validating it | [Atlas Core #101](https://github.com/atlas-field-systems/atlas-core/pull/101#discussion_r4175236055) |
| SDK response validation cloned and buffered the entire response | An unbounded response could exhaust memory before rejection | [Atlas Core #101](https://github.com/atlas-field-systems/atlas-core/pull/101#discussion_r4178226007) |
| A small model file declared an enormous accessor count | Input byte size did not bound the arrays allocated by decoding | [Ridgeline #92](https://github.com/the-Drunken-coder/Ridgeline/pull/92#discussion_r4180678801), [confirmed response](https://github.com/the-Drunken-coder/Ridgeline/pull/92#discussion_r4181213595) |
| A simulation budget counted messages without payload amplification | Individually valid messages exceeded the aggregate memory budget | [Atlas-Mesh #1](https://github.com/the-Drunken-coder/Atlas-Mesh/pull/1#discussion_r3692748409) |
| Per-source rate was checked separately for overlapping flows | Several accepted flows exceeded the promised total rate | [meshtastic-lab #3](https://github.com/the-Drunken-coder/meshtastic-lab/pull/3#discussion_r3938169584), [confirmed response](https://github.com/the-Drunken-coder/meshtastic-lab/pull/3#discussion_r3938279914) |
| Capped log records expanded into millions of display rows | A bound on one representation concealed unbounded retained output | [Modernization #428](https://github.com/the-Drunken-coder/Atlas-Modernization/pull/428#discussion_r4014902029) |
| Encoded password fields were decoded before checking their size | Large allocations happened before length and concurrency admission | [Modernization #439](https://github.com/the-Drunken-coder/Atlas-Modernization/pull/439#discussion_r4030422073), [confirmed response](https://github.com/the-Drunken-coder/Atlas-Modernization/pull/439#discussion_r4030450401) |

These are distinct representations of the same recurring mistake. The historical budgets and technologies are examples, not selected Atlas limits.

## Existing coverage

[State, errors and background work](../../agents/code-conventions.md#state-errors-and-background-work) already requires bounded queues, retries, buffers and concurrency. [Operational protections](../../architecture/system-design.md#basic-operational-protections) and the [operating model](../../architecture/operating-model.md) own Atlas's admission behavior. The missing detail is what a reviewer must count and when the limit takes effect.

Current request and response adapters now contain byte bounds. The proposal prevents recurrence; it does not claim those original findings remain unfixed.

## Proposed text

Replace the current general resource-bound bullet with:

> Bound accumulating work and retained data before allocation or work proportional to untrusted input. Account for simultaneous consumers and decoded, cloned, indexed or displayed representations. A limit on individual inputs or visible output must also preserve the promised aggregate resource bound. Make cancellation, shutdown and failure reporting part of the component's interface.

Put the following review procedure in the proposed background-work reference:

1. Identify the resource charged by each admission limit and where admission occurs.
2. Follow the input through decoding, copying, retention and publication. Check expansion and additional buffering.
3. Include consumers that share the same budget, including overlapping requests or flows.
4. Exercise the exceeded bound through the real interface. Check the specified refusal and that unrelated required work remains available.

## Adoption criteria

The clarification belongs in code conventions; numeric budgets stay in their existing Protocol, topic or configuration authority. Budget selection must use the accepted workload and measurements.

Use behavioral tests for actual limit enforcement and expansion. A general source rule banning buffering APIs would reject legitimate bounded uses and miss other allocations, so this proposal does not call for that rule.
