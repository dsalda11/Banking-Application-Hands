# Artifacts

This directory stores versioned, reviewable capability artifacts consumed by deterministic replay.

Artifacts must never contain credentials, tokens, cookies, or raw sensitive data.

`goals/` contains validated discovery goals. Goals declare objectives, typed inputs/outputs,
secret-reference names, success/business outcomes, application scope, budgets, screenshot policy,
and intervention permission. They contain neither credentials nor known replay selectors.

`drafts/` is deliberately not traversed by `ArtifactRegistry`. It contains compiler output and
separate immutable compilation, review, and replay-verification records. A draft becomes active only
through explicit conflict-safe promotion. The hand-authored example remains unchanged and is never
used by the compiler as a plan.
