# Delivery plan

**Build small complete workflows, not a platform before its first user.**
These milestones organize work; they are not claims of implementation or approval
to execute every milestone. The full target remains documented across the three layers.

## First useful system

Start with a simulated external gateway and operator using SDK HTTP mode. Register
an Asset, accept a report, and read its state. Repeat through a second valid API key,
deduplicate the report, and reject a revoked key.
Prove a separate direct-IP report as well; neither path substitutes for the other.

Then publish a drone-owned Track through the gateway, preserving its publisher across
gateway and key changes. Execute one queued coordinate Move To and reconcile its outcome
after lost or delayed delivery. Do not require Objects or full synchronization to
prove this Task workflow. Real radio and flight firmware remain external qualification.

## Add independent capabilities

Prove complete Object upload/download with exact bytes, lost replies, interruption,
and deletion protection. Separately install an offline Elevation Lookup Plugin,
invoke it, cancel or interrupt it, and remove it without affecting Core or published
results. A Plugin lookup does not need an Asset Task or Object merely to exist.

Exercise real local management and durable recovery with those owners in place.
Then extend the Task workflow to queue changes, Pause/Resume, live geometry, result
declarations, retirement, and relevant administration. Split each outcome into a
reviewable change rather than treating this paragraph as one large implementation task.

## Add the maintained picture last

After HTTP behavior works, implement Full synchronization through the same SDK.
Prove atomic commits, snapshot handoff, replay, rebuild, slow-client behavior, and
capacity refusal. Do not reduce the target to notification-only invalidation without
a separate product decision.

## Close these details when their workflow arrives

| Before | Engineering decision or proof still needed |
| --- | --- |
| First enrollment/report | Bootstrap authorization, recoverable credential exchange, exact report schemas and independent examples |
| First gateway Track | Relay representation, source identity, process evidence, and contact interaction |
| Growing Tasks/queues | Aggregate resource and combined-message bounds that leave room for terminal transitions |
| Stopped-state administration | Local activity's durable acceptance point, damage handling, and repeat-safe import |
| Capacity claims | Whole-installation disk isolation, cumulative Plugin receipts, decoded SDK memory, and storage growth |
| Release | Qualified locks/schema profile, offline installation, independent Plugin build, and real hardware evidence |

These are gaps to finish, not permission to invent a new product architecture.
Write the small decision and acceptance example in its owning page before coding.

## Deliberately outside scope

No clustering, federation, automatic mission recovery across Core restart,
operational backup/restore or migrations, SDK offline write queue, selective/hybrid
replica, resumable uploads, arbitrary Plugin-defined Entity components or Commands,
or automatic external-effect retries. Add them only for an explicit requirement.

[Next: qualification](qualification.md)
