# Intervention

Responsibility: automation/human control ownership and same-session handoff.

May depend on: domain contracts, surfaces, evidence, and the loopback operator interface.

Must not: launch a replacement session for human takeover or store raw session secrets.

`ControlLeaseManager` is a single-process, in-memory fencing lease. It grants exclusive automation or human ownership, expires human control into a safely paused state, and requires explicit reclaim. `operator-server.ts` binds only to loopback and authenticates a run-scoped in-memory token supplied through the URL fragment; production would require durable leases and organizational identity.

`InterventionCoordinator` and `AutomationActionGuard` protect each surface action, checkpoint,
retry, and recovery operation. Interactive replay pauses before a policy-marked action, keeps the
existing surface session allocated, and resumes only with the matching intervention and lease
generation. Non-interactive replay returns `INTERVENTION_REQUIRED` without performing the pending
action. The loopback HTTP operator server is wired through `InteractiveReplayLifecycle`; its token
is memory-only and cleanup is idempotent.
