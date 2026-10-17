# Automation engine

This directory contains the Node.js 24 TypeScript system for discovery, compilation, deterministic
replay, policy enforcement, evidence recording, and same-session human intervention. It automates
the banking application through its rendered UI; it does not query the database or call application
controllers.

Use the repository [README](../README.md) for fresh-clone setup and the two reviewer demos. This file
covers lower-level development and lifecycle commands.

## Runtime configuration

Configuration is read from the process environment. No `.env` or `.env.example` file is tracked.

- `BANK_STAFF_USERNAME`, `BANK_STAFF_PASSWORD`: required by staff replay and discovery.
- `OPENAI_API_KEY`: required only by genuine OpenAI discovery.
- `OPENAI_MODEL`: discovery model; defaults to `gpt-5.6-terra` when omitted.
- `BANK_APP_BASE_URL`: defaults to `http://127.0.0.1:8080`.
- `BROWSER_HEADLESS`: defaults to `false`.
- `OPERATOR_HOST`, `OPERATOR_PORT`: loopback operator endpoint configuration.
- `ARTIFACTS_DIR`, `POLICIES_DIR`, `EVIDENCE_DIR`: repository-relative storage overrides.
- `DISCOVERY_MAX_MODEL_CALLS`, `DISCOVERY_MAX_ACTIONS`, `DISCOVERY_TIMEOUT_MS`,
  `DISCOVERY_MAX_REPEATED_STATES`, `DISCOVERY_MAX_CONSECUTIVE_FAILURES`: bounded discovery limits.
- `DISCOVERY_SEND_SCREENSHOTS`: permits sanitized discovery screenshots only when both runtime and
  goal policy allow them.

`npm run doctor` reports readiness and configuration-presence booleans without printing secret
values. Replay itself needs no provider variable.

## Development commands

```bash
npm ci
npm run browser:install

npm run format
npm run lint
npm run typecheck
npm run test
npm run test:surface
npm run schema:check
npm run build
npm run doctor
npm run security:scan
npm run security:dependencies
npm run evidence:check
```

`npm run test` runs the non-browser Vitest suite and secret-scanner regression tests.
`npm run test:surface` runs Playwright-backed surface, replay, recovery, and handoff coverage.
`npm run check` is a convenient offline aggregate, but does not replace the surface, dependency,
security, or evidence checks listed above.

## Boundaries

- `src/discovery/`: bounded orchestration and `PlannerClient`; the OpenAI adapter emits strict
  structured decisions and never receives a Playwright handle.
- `src/compiler/`: integrity-validates sanitized JSONL traces and emits canonical artifacts plus
  separate lifecycle records.
- `src/replay/`: validates and interprets artifacts without importing discovery or provider code.
- `src/policy/`: validates policy documents and fails closed at preflight and before each attempt.
- `src/surfaces/`: provider-neutral action/checkpoint contract; Playwright stays under `web/`.
- `src/intervention/`: exclusive leases, generation fencing, loopback operator server, and
  Resume/Complete/Abort/Reclaim coordination.
- `src/evidence/` and `src/logging/`: sanitized structured evidence and metadata-only redaction.

The replay engine accepts only declared inputs and secret references, checks target fingerprints,
resolves locator candidates in order, rejects zero or ambiguous `exactlyOne` matches, enforces
bounded retries/timeouts, evaluates checkpoints, validates typed outputs, and recognizes declared
business outcomes.

## Artifact lifecycle commands

All paths below are relative to this directory.

```bash
npm run trace:validate -- --trace ../evidence/runs/<run-id>/discovery-events.jsonl

npm run artifact:compile -- \
  --goal ../artifacts/goals/lookup-customer-account.goal.json \
  --trace ../evidence/runs/<successful-run>/discovery-events.jsonl \
  --trace ../evidence/runs/<outcome-run>/discovery-events.jsonl \
  --artifact-id <artifact-id> \
  --version <version>

npm run artifact:review -- \
  --artifact ../artifacts/drafts/<artifact>.json \
  --manifest ../artifacts/drafts/<artifact>.compilation.json \
  --review ../artifacts/drafts/<artifact>.review.json \
  --approve

npm run artifact:verify -- \
  --artifact ../artifacts/drafts/<artifact>.json \
  --review ../artifacts/drafts/<artifact>.review.json \
  --policy ../policies/local-bank-discovery.v1.json \
  --input customerUsername=customer \
  --outcome-input CUSTOMER_NOT_FOUND:customerUsername=missing-user
```

Review approval binds the canonical artifact hash. Verification uses fresh model-free browser
sessions. Promotion is separate and conflict-safe:

```bash
npm run artifact:promote -- \
  --artifact ../artifacts/drafts/<artifact>.json \
  --review ../artifacts/drafts/<artifact>.review.json \
  --verification ../artifacts/drafts/<artifact>.verification.json \
  --registry <active-registry-directory>
```

The checked-in `1.0.2` artifact is promotion-eligible but has not been promoted into the active
registry. Do not treat discovery, review, or verification as implicit promotion.

## Replay and result contract

The exact reviewer replay commands and expected outputs are in the root README. Relevant exit codes
are:

| Code          | Meaning                                                                     |
| ------------- | --------------------------------------------------------------------------- |
| `0`           | Success                                                                     |
| `1`           | Terminal validation, policy, checkpoint, session, or infrastructure failure |
| `2`           | Declared business outcome                                                   |
| `3`           | Permission denied                                                           |
| `4`           | Human intervention required in non-interactive execution                    |
| `5`           | Human abort                                                                 |
| `130` / `143` | Graceful `SIGINT` / `SIGTERM` interruption                                  |

`npm run replay:interactive` must run headed. It pauses before policy-marked actions, keeps the same
browser/context/page alive, and prints a loopback operator URL whose fragment token remains in
memory and outside logs. Rejected decisions and stale generations cannot resume automation;
cleanup closes operator and browser resources idempotently.

## Discovery and retained data

Genuine discovery uses the official OpenAI JavaScript SDK and Responses API with strict JSON Schema
output, `store: false`, no built-in tools, bounded retries, and typed provider errors. Page-derived
content is explicitly untrusted. The planner can propose only the domain action vocabulary; schema,
observation binding, policy, and the `SurfaceAdapter` remain authoritative.

The scripted planner exists for deterministic offline regression tests and is not evidence of the
genuine provider run. The curated genuine traces and replays are indexed in
[evidence/README.md](../evidence/README.md).

Raw provider payloads, cookies, storage state, authorization headers, operator tokens, and raw
Playwright trace ZIPs are not retained. Runtime run directories are ignored by default; only the
manifest-selected sanitized submission evidence is checked in.
