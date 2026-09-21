---
status: accepted
---

# Expose Objects only when ready

An Object becomes visible through Atlas only when it is ready for use; an upload does not create an unavailable Object listing for operators or consumers. The user considered early visibility interesting but chose the simpler contract, avoiding partial-availability states. For a scan result, upload progress remains associated with its In progress Task until the required Object is ready.

Internal upload staging is an implementation concern. This decision governs initial visibility, not later retention, deletion or recovery behavior.

Large uploads resume from confirmed progress after connection loss within the same Core run. Partial transfer state is internal and does not make an unavailable Object publicly visible. Stop/Start and Restart preserve stored transfer state; Reset wipes it. The same-run resume guarantee is settled; reattaching active transfers after a whole-Core restart still needs implementation design. The resumable upload mechanism remains an implementation choice.
