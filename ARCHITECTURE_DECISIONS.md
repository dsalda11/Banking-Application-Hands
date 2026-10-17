# Architecture decisions

This is the implementation record for the completed submission. The reviewer entry points are
[README.md](README.md), [REPORT.md](REPORT.md), and [evidence/README.md](evidence/README.md).

## Separate discovery from production replay

Discovery is allowed to be probabilistic; production execution is not. A `PlannerClient` proposes
one strict domain decision from a bounded observation. Schema validation, observation binding, policy,
and `SurfaceAdapter` execution remain outside the model. Successful observations are compiled into
an immutable canonical artifact rather than replaying model text or generated code.

Replay loads the artifact, binds declared inputs and runtime secret references, enforces policy,
executes ordered actions, evaluates checkpoints, and validates outputs. Its implementation has no
planner or provider dependency. This makes the reviewed behavior inspectable and lets replay run
without model credentials.

## Keep UI execution behind SurfaceAdapter

The domain contract expresses navigation, text entry, activation, extraction, observations,
checkpoints, and lifecycle operations without Playwright types. The implemented web adapter owns
browser details and locator resolution. This isolates selectors and browser state from the compiler,
policy engine, and orchestration code, and leaves a credible seam for future surface adapters without
claiming they exist today.

## Treat model and page content as untrusted

The OpenAI adapter uses structured output, no provider tools, bounded retries, and `store: false`.
The planner never receives credentials, cookies, storage state, authorization data, a raw Playwright
trace, or a browser handle. Page-derived content is marked untrusted and cannot change the action
vocabulary, policy, budgets, or secret declarations.

Each proposal must reference the current observation and pass schema and policy checks before acting.
Discovery budgets cover model calls, actions, elapsed time, repeated states, alternating loops, and
consecutive failures.

## Compile only observed successful behavior

The trace loader verifies strict JSONL events, sequence and identity consistency, terminal ordering,
supported schemas, and the claimed SHA-256 trace hash. The compiler keeps only actions that were
issued, policy-allowed, executed, and observed as successful. Failed exploration remains diagnostic
metadata rather than executable artifact content.

Inputs and secrets remain references. Locator candidates must come from resolved observations and
are ordered by semantic stability. Output locators use structure such as labeled table columns, not
the observed value being extracted. Checkpoints and target fingerprints come from observable state.
Canonical key ordering and stable metadata make equivalent compilation byte-for-byte deterministic.

## Require exact-hash lifecycle gates

Compilation writes a draft artifact and a separate manifest. Human review records approval or
rejection of the exact canonical hash. Verification checks that approval relationship, then uses
fresh model-free browser sessions for the success and declared-outcome cases. A passing verification
can mark the artifact promotion-eligible, but active-registry promotion remains a separate,
conflict-safe operation.

The checked-in genuine artifact is
`banking.lookup-customer-account.genuine-compiled@1.0.2`, hash
`1873dc5b25977f6de3ec522751179c45359df9c50cdf4841e3bf6a08be191095`. It is approved, verified,
and promotion-eligible; it has not been automatically promoted.

## Fail closed in policy and resolution

Policy documents allowlist origins, routes, actions, risks, secrets, recovery, tracing, and budgets.
The engine checks static compatibility before execution and evaluates policy again before each
attempt. Unknown behavior is denied.

Locator bundles declare match behavior. An ambiguous exact match is terminal and cannot fall through
to a candidate that might click something else. Zero matches may use a genuinely independent fallback;
exhaustion becomes a typed locator failure. Target fingerprints and post-action checkpoints prevent a
similar-looking wrong page from satisfying the run.

Retries, actions, recovery, per-step waits, and total replay duration are bounded. One declared
authentication recovery can resume the interrupted safe step; a second expiration is terminal.
Known business outcomes such as `CUSTOMER_NOT_FOUND` are distinct from infrastructure failures.

## Transfer control without replacing the session

Interactive replay pauses at a safe boundary, releases the automation lease, and lets a human claim
exclusive ownership of the same browser context and page. Monotonic lease generations fence stale
actors. Resume and Complete validate postconditions; Abort terminates safely; expiry requires the
defined reclaim path. Duplicate or stale commands do not execute twice.

The operator server is loopback-only and single-process. Its run token is memory-only and delivered in
a URL fragment. This proves the ownership protocol and same-session continuity without presenting a
minimal demo console as production remote co-browsing infrastructure.

## Retain narrow, sanitized evidence

Evidence contains structured events, policy decisions, checkpoint results, typed outcomes, and safe
screenshots only where needed. Raw provider request/response bodies, credentials, cookies, storage
state, authorization headers, operator tokens, and Playwright trace ZIPs are not retained. The
submission manifest selects the small checked-in set; other runtime runs are ignored.

Security and evidence checks validate required paths and hashes, scan prospective evidence and Git
history for prohibited patterns, and report finding metadata without echoing secret values.

## Deliberate limits

The implementation covers one local legacy web application. It is single-process and has no desktop
adapter, tenant overlay system, distributed queue, durable lease service, cloud registry, automatic
promotion, or enterprise operator authentication. These cuts keep the demonstrated discovery,
compilation, review, replay, policy, evidence, and handoff boundaries small enough to inspect.
