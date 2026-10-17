# 1. Architecture

The system separates probabilistic discovery from deterministic execution. A natural-language goal
declares typed inputs, outputs, secret-reference names, success conditions, business outcomes, target
scope, and budgets. During discovery, `DiscoveryOrchestrator` asks a `PlannerClient` for exactly one
structured proposal at a time. The genuine provider adapter uses the OpenAI Responses API, strict
JSON Schema output, no provider tools, and disabled response storage. The LLM never receives a
Playwright object and never executes browser code.

Every proposal is checked against the current observation identity, parsed through the domain schema,
and evaluated by the fail-closed policy engine before `SurfaceAdapter` can act. This boundary is the
main safety decision: the model suggests from a small vocabulary, while code owns authority,
credentials, budgets, and effects. `SurfaceAdapter` also keeps orchestration independent of
Playwright; the current web implementation is one adapter rather than the domain model itself.

Successful discovery is compiled instead of replaying an LLM transcript. The compiler accepts only
integrity-validated, observed events; removes failed exploration; preserves parameter and secret
references; and emits canonical JSON. Lifecycle records are separate from artifact bytes. A human
reviews the exact hash, fresh model-free sessions verify success and declared outcomes, and promotion
is a distinct action. The genuine path was demonstrated with OpenAI `gpt-5.6-terra`, then compiled,
hash-approved, and replayed without a model. The approved artifact remains promotion-eligible rather
than silently active.

This architecture deliberately favors an inspectable single-process implementation over queues,
distributed workers, or a general workflow language. Evidence writing is similarly narrow: it
records sanitized decisions, policy results, checkpoints, and outcomes without retaining raw provider
or browser traces.

# 2. Artifact schema

A capability has a stable ID and semantic version, schema version, description, lifecycle state,
policy reference, target entry point and fingerprints, provenance, contract, ordered steps, and final
success checkpoint. The contract defines typed non-secret parameters, required secret-reference
names, typed outputs, and declared business outcomes. Each step carries an action, semantic target
when needed, risk, timeout, bounded recovery rule, and post-action checkpoint.

Targets are ordered locator bundles rather than generated Playwright code. Candidates include roles,
labels, text, stable attributes, CSS, and structural table relationships. Match semantics are
explicit, and fallbacks run only after a candidate has zero matches—not after ambiguity. The banking
artifact extracts `accountNumber` and `currentBalance` with a structural `tableCell` locator tied to
the `Account No.` and `Balance` headers. Observed values such as the demonstration account number or
balance are outputs, never locator inputs, so a different customer value can be extracted without
recompilation.

Checkpoints cover routes, element state, output shapes, and composed success conditions. Target
fingerprints combine path and stable visible text so a generic page title cannot establish identity.
Provenance names the genuine discovery run; compilation, approval, and verification manifests carry
their own hashes and timestamps. Canonical serialization makes the artifact hash reproducible.

The schema is intentionally decoupled from raw model transcripts and Playwright types. That keeps
provider phrasing, ephemeral observation handles, browser objects, and credentials out of the
production contract, while Zod runtime validation and generated JSON Schema provide the same strict
shape at trust boundaries and during external review.

# 3. Determinism & error handling

Replay loads and semantically validates one artifact and its policy before opening a browser. It
binds only declared inputs and runtime secret references, performs policy preflight, creates a fresh
context, verifies target fingerprints, and executes ordered actions through `SurfaceAdapter`. The
replay dependency graph has no planner, provider adapter, discovery orchestrator, or model fallback.

Locator candidates are attempted in declared order. An exact match proceeds; zero matches may move to
the next independent candidate; multiple matches fail as ambiguity rather than choosing arbitrarily.
If every candidate fails, replay returns a typed locator failure. Checkpoints record the step,
expectation, and sanitized observed state. Fingerprints prevent a similar phrase on the wrong page
from passing as the expected target.

Action attempts, total actions, recovery attempts, per-action timeouts, and total replay time are
bounded by artifact and policy limits. Repeated-state and discovery budgets stop open-ended planning.
Authentication recovery is declared data: one permitted expiration can run a bounded login sequence
and resume the interrupted safe step; a second expiration is terminal. Consequential work is not
silently retried.

Results distinguish success, declared business outcomes, recoverable conditions, policy denial,
permission denial, locator or checkpoint failure, timeout or terminal session failure, human need or
abort, and hard application/infrastructure failure. `CUSTOMER_NOT_FOUND` is therefore a successful
classification of a known domain outcome, not an exception. Three additional fresh-session stability
runs of the approved artifact produced the same typed outputs with zero provider calls, passing policy
and checkpoints and closing resources cleanly.

# 4. Heterogeneity & multi-tenant

Only one concrete browser surface is implemented. `SurfaceAdapter` is the intended seam for another
web driver, an accessibility-tree driver, or a desktop automation adapter because the engine consumes
semantic actions, targets, checkpoints, and observations rather than Playwright code. This is a
design affordance, not a claim that desktop execution exists.

Similarly, the artifact format could support vendor-level base capabilities shared by institutions,
with tenant- and application-version-specific locator or configuration overrides. Product
fingerprints, schema versions, capability versions, and policy references could detect incompatible
drift; meaningful changes would require revalidation and exact-hash reapproval. Secret values would
remain tenant runtime bindings rather than artifact fields.

The repository does not implement tenant routing, override merging, cross-tenant canonicalization,
remote registries, desktop adapters, or artifact migration. Those features were left out so the
submission could prove one genuine discovery-to-replay path and its trust boundaries thoroughly.

# 5. Escalation & handoff

Interactive replay checks for intervention at safe action boundaries. When a blocked, risky, or stuck
condition requires a person, automation pauses and releases its lease. A human claims exclusive,
generation-fenced ownership while the same Playwright browser, context, page, cookies, and application
session remain alive. The operator can act directly in that browser and request Resume, Complete,
Abort, or an intended reclaim after lease expiry.

Resume validates the expected postcondition before control returns to automation. Complete validates
that the goal can finish; Abort terminates deliberately. Rejected decisions restore human ownership
with a new generation, stale generations cannot act, and duplicate commands are idempotently rejected
rather than executed twice. Sanitized lifecycle evidence spans pause, claim, ownership changes,
decision validation, continuation, and cleanup. Signal handling also shuts down the operator server,
timers, evidence writer, and browser in order.

The operator interface is deliberately loopback-only and single-process. Its run token is memory-only
and placed in a URL fragment so it is not sent in HTTP requests or logs. This proves same-session
control transfer and fencing, but it is not a production co-browsing service with organizational
identity, durable distributed leases, or remote authorization.

# 6. Safety

Versioned policy documents allowlist origins, routes, action types, secret references, risk classes,
recovery, trace behavior, and budgets. Validation and preflight reject malformed or incompatible
artifacts before execution; runtime policy runs again before every attempt. Unknown behavior and
prohibited risk fail closed. Irreversible or consequential actions require the policy's explicit
treatment rather than model judgment.

Credentials are resolved from declared runtime environment names and are never accepted as ordinary
artifact inputs. Logs and evidence redact sensitive keys and values; scanners cover selected evidence,
tracked files, unsafe environment files, raw trace archives, provider-payload patterns, and reachable
Git history while reporting metadata rather than matched values. Provider input is sanitized and
page text is marked untrusted. The provider is called with no tools and `store: false`, and raw
request/response bodies are not retained. Raw Playwright trace ZIPs are disabled because they can
capture DOM, network, cookies, and storage state.

Exact-hash approval prevents a reviewed artifact from changing unnoticed. Replay verifies canonical
content, stays model-free, enforces checkpoints, and writes only bounded sanitized evidence. These
controls are defense in depth, not a claim of perfect security: the target app is intentionally
insecure, visible UI can contain identifiers, the local operator is not an enterprise identity
system, and new surfaces or tenants would require fresh threat analysis.

# 7. Cuts

The implementation targets one legacy local web application, not desktop software. It designs seams
for heterogeneous surfaces and multi-tenant specialization but does not build those systems. The
operator UI is minimal rather than a production co-browsing console. Execution is single-process:
there are no queues, clusters, distributed fencing, cloud registry, or scheduler. Promotion into the
active artifact registry remains a separate human action, so the verified `1.0.2` artifact is not
automatically deployed.

The genuine evidence set contains the successful and missing-customer discovery runs needed to prove
the path, not a broad model benchmark. Structural locators still depend on stable legacy labels,
routes, roles, and table headers. The compiler is conservative and rejects evidence it cannot justify
rather than attempting broad cross-application generalization.

With more time, the next work would be authenticated durable handoff, an external immutable artifact
registry with signed approvals, tenant/version overlay validation, drift monitoring and controlled
re-discovery, and additional real surfaces and application versions. Those extensions should preserve
the demonstrated boundary: models may discover, but approved deterministic artifacts and policy own
production execution.
