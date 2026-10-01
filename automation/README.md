# Automation Engine Scaffold

This is the isolated TypeScript automation engine that will eventually operate the separate Java/JSP banking application through its UI. It does not query the banking database or modify the Java target.

## Requirements

- Node.js 24 LTS (`.nvmrc` is set to `24`)
- npm

## Install and verify

```bash
npm install
npm run doctor
npm run check
```

The checked-in `.env.example` documents optional settings; this phase does not create a real `.env` file. Supply local environment variables externally when a later discovery or replay phase needs them, and never commit credentials.

Scaffold verification needs no OpenAI API key, banking credentials, running banking app, Docker, browser installation, or network access after dependencies are installed.

The `doctor` command checks the repository directories, write access, runtime version, base URL, optional credential presence, browser mode, and operator address without printing secret values.

Formatting, linting, type checking, tests, and build are available through the scripts in `package.json`. Discovery and replay commands will be documented in later phases.

The Phase 2 domain contracts live under `src/domain/`; the draft example capability is `../artifacts/lookup-customer-account.v1.example.json`. Generate and check reviewable JSON Schemas with:

```bash
npm run schema:generate
npm run schema:check
```

## Surface smoke

Install only the project Chromium browser when browser checks are needed:

```bash
npm run browser:install
```

Offline checks remain fast and do not launch Chromium:

```bash
npm run test
npm run check
```

The local scripted banking smoke requires the existing Docker app and ephemeral runtime credentials:

```bash
BANK_STAFF_USERNAME=... BANK_STAFF_PASSWORD=... BROWSER_HEADLESS=true \
  npm run surface:smoke -- --customer-username customer
BANK_STAFF_USERNAME=... BANK_STAFF_PASSWORD=... BROWSER_HEADLESS=true \
  npm run surface:smoke -- --customer-username missing-user
# Or set BANK_CUSTOMER_USERNAME and run the proof alias:
BANK_STAFF_USERNAME=... BANK_STAFF_PASSWORD=... BANK_CUSTOMER_USERNAME=customer \
  npm run proof:bank
```

Use `BROWSER_HEADLESS=false` for headed local debugging. Screenshots, traces, observations, event logs, and results are written under `../evidence/runs/<run-id>/`, which is ignored. The command is a manually scripted surface proof, not deterministic artifact replay yet.

The provider-neutral `SurfaceAdapter` owns observation, typed action execution, checkpoints, screenshots, traces, and cleanup. Playwright types remain inside `src/surfaces/web/`; the proof workflow only invokes the adapter with existing domain actions. Locator candidates resolve in declared order, with semantic strategies preferred and structured scopes/frame paths preserved. Credentials are runtime-only and screenshots/traces are blocked while a password field is populated.

## Phase 4 artifact replay

The generic replay engine validates the artifact before launching Chromium, binds only declared inputs and secrets, executes its ordered actions through `SurfaceAdapter`, evaluates each declared checkpoint, applies bounded artifact retries, recognizes declared business outcomes, and writes sanitized evidence under `../evidence/runs/<run-id>/`. It is deterministic and non-LLM; it is not discovery or artifact compilation.

```bash
npm run artifact:list
npm run artifact:validate -- --artifact ../artifacts/lookup-customer-account.v1.example.json

BANK_STAFF_USERNAME=... BANK_STAFF_PASSWORD=... BROWSER_HEADLESS=true \
  npm run replay -- \
    --artifact ../artifacts/lookup-customer-account.v1.example.json \
    --input customerUsername=customer

BANK_STAFF_USERNAME=... BANK_STAFF_PASSWORD=... BROWSER_HEADLESS=true \
  npm run replay -- \
    --artifact ../artifacts/lookup-customer-account.v1.example.json \
    --input customerUsername=missing-user
```

The replay command returns exit code `0` for success, `2` for an expected business outcome, and `1` for a failure. Secrets are resolved only from environment names listed in the artifact and are never accepted as CLI inputs.

Policy-controlled replay uses the strict local policy by default; it can also be supplied explicitly:

```bash
BANK_STAFF_USERNAME=... BANK_STAFF_PASSWORD=... BROWSER_HEADLESS=true \
  npm run replay -- \
    --artifact ../artifacts/lookup-customer-account.v1.example.json \
    --policy ../policies/local-bank-readonly.v1.json \
    --input customerUsername=customer
```

Exit codes are `0` success, `1` terminal engine/configuration/policy failure, `2` declared business outcome, `3` declared permission denial, and `4` intervention required. Policy denials, permission denial, session expiration, recovery, locator failures, checkpoint failures, and retry attempts are recorded as sanitized event evidence.

## Recovery fixture and trace retention

`npm run test:surface` includes a loopback-only browser fixture for one bounded authentication recovery, a second-expiration terminal failure, and permission denial without reauthentication. It uses the production artifact loader, policy loader, replay engine, and Playwright adapter; the Java banking application is not modified to force session expiry.

Raw Playwright trace ZIPs are disabled by the local read-only policy because DOM snapshots, network data, and browser state cannot be reliably sanitized. JSONL events, password-safe screenshots, and bounded observations remain the audit evidence. Passwords, cookies, session tokens, and authorization values are confidential; usernames and customer lookup values are identifiers that can legitimately appear in visible UI or declared input data.

## Interactive replay lifecycle

`replay:interactive` uses one `InteractiveReplayLifecycle` for process signals, replay cancellation,
operator URL delivery, exit-code mapping, and idempotent cleanup. Rejected Resume or Complete
validation restores human control with a new fencing generation. The operator page tracks monotonic
coordinator revisions so delayed responses cannot restore an old generation or re-enable stale
controls. Cancellation is observed only at safe action/checkpoint boundaries; an in-flight atomic
surface call is allowed to finish.

`SIGINT` exits with code 130 and `SIGTERM` with code 143 after the coordinator, loopback server,
timers, evidence, and replay surface have closed. Operator tokens are memory-only and invalidated by
cleanup. This implementation is single-process.

## Step 8 human takeover acceptance

The real-browser acceptance fixture uses the production replay engine, policy engine, Playwright web
adapter, coordinator, lease manager, operator server, loaders, and JSONL writer. At a safe boundary,
the same browser, context, target page, cookies, and application session remain allocated while the
human lease is active. A test-only actor clicks the existing target page directly and is never exposed
through the operator API. Invalid Resume restores human ownership with a new fencing generation.
Valid Resume validates the postcondition and skips the human-completed action. Verified Complete
performs only policy-allowed missing output extraction before validating final success. Abort closes
both target and operator resources.

```bash
npm run test:surface -- --run test/intervention/human-takeover.surface.test.ts

BROWSER_HEADLESS=false npm run replay:interactive -- \
  --artifact ../artifacts/lookup-customer-account.v1.example.json \
  --policy ../policies/local-bank-human-demo.v1.json \
  --input customerUsername=customer
```

For the headed demonstration, open the printed operator URL, claim control, and first try Resume
before opening customer details. After rejection, use the already-open banking Chromium window to
select **View Details** for `customer`, then Resume. Expect account `2023` and balance `31444 USD`.
Run the command again and choose Abort for the separate abort proof. Evidence is written under
`../evidence/runs/<run-id>/`.

The operator is loopback-only and single-process. Production evolution requires organizational
authentication, durable distributed fencing, and authenticated remote control without transferring
raw browser storage or weakening exclusive ownership.

## Step 9 bounded discovery

Discovery proposes one action at a time and never gives the model a Playwright handle. The runtime
captures a bounded semantic observation, validates the proposal with Zod, rejects stale observation
IDs/fingerprints, evaluates the fail-closed policy, executes through `SurfaceAdapter`, and records
the observed result separately from the proposal. Page content is untrusted and cannot change
policy, budgets, declared secrets, or the action vocabulary.

The loop enforces model-call, action, navigation, wall-clock, repeated-state/action, alternating-loop,
and consecutive-failure limits. Passwords and usernames declared as secrets are represented to the
planner only by reference name; values are resolved immediately before an authorized surface action.
Raw API payloads, browser storage, cookies, raw DOM, and Playwright traces are not retained.

Offline discovery uses `ScriptedPlannerClient`. Production discovery uses the official OpenAI
JavaScript SDK and Responses API with strict JSON Schema output, `store: false`, no built-in tools,
one bounded retry, and typed authentication/rate-limit/timeout/refusal/malformed-output errors.

```bash
# Deterministic observation-driven fake planner (no provider network call)
npm run discover -- \
  --goal ../artifacts/goals/lookup-customer-account.goal.json \
  --policy ../policies/local-bank-discovery.v1.json \
  --planner fake \
  --input customerUsername=customer

# Genuine model-backed discovery
npm run discover -- \
  --goal ../artifacts/goals/lookup-customer-account.goal.json \
  --policy ../policies/local-bank-discovery.v1.json \
  --planner openai \
  --input customerUsername=customer
```

The live command reads only `OPENAI_API_KEY`, `OPENAI_MODEL`, and the declared banking secret
references from the environment. Discovery JSONL is stored as
`../evidence/runs/<discovery-run-id>/discovery-events.jsonl`; proposal, policy decision, execution,
actual result, output candidates, interventions, and stopping conditions are distinct event types.
Request-human proposals reuse the Step 8 lease/coordinator/operator console and preserve the same
surface session. Resume always captures a fresh observation, invalidating all pre-handoff element
IDs. Step 9 produces an integrity-bound typed discovery trace. Step 10 consumes one successful trace
plus optional declared-outcome/repeated-success traces and compiles only the verified path.

## Step 10 compiler and automated Step 11 gate

The enriched trace persists sanitized observations, validated proposals, executed typed actions,
resolved locator candidate indexes, and checkpoint evidence as bounded JSON strings. This is not raw
DOM or a provider payload. A terminal hash covers every preceding event. The compiler proves locator
provenance against the referenced observation, removes failed/no-progress exploration, preserves
input and secret references, emits observed checkpoints and typed extractors, and writes canonical
artifact bytes plus a separate time-bearing provenance manifest.

Lifecycle state is external to deterministic content: draft → validated → review approved → fresh
replay verified → promotion eligible, or rejected. Review and verification records become invalid
after a content change. Verification creates independent browser contexts and runs success plus every
compiled business outcome through the existing model-free replay engine. Promotion is an explicit
exclusive filesystem copy and registry reload. Draft directories are not active registry inputs.

The browser fixture executes the fake-planner discovery/compiler/replay slice three consecutive
times. Banking drafts under `artifacts/drafts/` are labeled fake-planner-derived. Genuine OpenAI
provenance is claimed only when a provider-backed trace reaches observed success; an authorization or
provider failure never produces a synthetic substitute. Exact commands are in `src/compiler/README.md`.
