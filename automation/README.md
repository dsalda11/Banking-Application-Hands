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
