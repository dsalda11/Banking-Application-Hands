# Banking Application Software

An intentionally insecure Spring Boot/JSP/MySQL banking demonstration app using fake data. Keep it local; do not use real credentials or deploy it publicly.

## Start

Requires Docker Desktop and Compose v2.

```bash
docker compose up --build -d
```

Compose uses safe local demo defaults for the database and application settings. Override them
through the shell or CI environment when needed, for example `APP_PORT=8081 docker compose up -d`.
No environment template is required or tracked.

Email remains disabled by default. If it is deliberately enabled, provide
`SPRING_MAIL_USERNAME` and `SPRING_MAIL_PASSWORD` through the runtime environment. Never commit
mail credentials or place them in a repository-local configuration file.

Open <http://127.0.0.1:8080/index> and log in with:

```text
Username: admin
Password: admin
```

The app is built from source as an executable WAR. MySQL runs in a separate healthy container, initializes from `database/database.sql`, and persists in a named Docker volume. Only the app is published on `127.0.0.1`; MySQL is not exposed to the host. Email is disabled by default.

## Commands

```bash
docker compose ps
docker compose logs --no-color
docker compose stop
docker compose down
docker compose up --build -d
```

Reset the fake database:

```bash
docker compose down
docker volume rm banking-application-software_banking-mysql-data
docker compose up --build -d
```

For a port conflict, set `APP_PORT=8081` in the command environment. For startup or JSP problems,
check `docker compose logs --no-color app`; for database initialization problems, check
`docker compose logs --no-color db`. SQL initialization runs only when the database volume is new.

## Running the automation

Run these commands from the repository root. The automation workspace requires Node.js 24 and npm;
Docker Desktop with Compose v2 is required for the banking application. Install the automation
dependencies and its project-local Chromium browser once:

```bash
cd automation
npm install
npm run browser:install
cd ..
```

The banking credentials below belong to the local synthetic demo application. Supply them only to
the process environment; do not put credentials in a repository file.

### Option A — deterministic replay, no LLM credentials required

Start the banking application from the repository root:

```bash
docker compose up --build -d
```

Then run the checked-in capability artifact. Replace only the banking credential placeholders with
the local demo staff credentials:

```bash
cd automation
export BANK_STAFF_USERNAME="<local-demo-staff-username>"
export BANK_STAFF_PASSWORD="<local-demo-staff-password>"
BROWSER_HEADLESS=true npm run replay -- \
  --artifact ../artifacts/lookup-customer-account.v1.example.json \
  --policy ../policies/local-bank-readonly.v1.json \
  --input customerUsername=customer
```

The command exits `0` and prints a JSON result containing these success fields (run IDs, hashes,
evidence paths, and timestamps vary):

```json
{
  "status": "success",
  "outputs": {
    "accountNumber": "2023",
    "currentBalance": { "amount": "31444", "currency": "USD" }
  }
}
```

The existing not-found demonstration uses the same saved artifact:

```bash
BROWSER_HEADLESS=true npm run replay -- \
  --artifact ../artifacts/lookup-customer-account.v1.example.json \
  --policy ../policies/local-bank-readonly.v1.json \
  --input customerUsername=missing-user
```

It prints `"status":"businessOutcome"` and `"code":"CUSTOMER_NOT_FOUND"`, then exits with code
`2` because that is a declared business outcome. Replay is deterministic and performs no LLM calls;
it does not require `OPENAI_API_KEY` or `OPENAI_MODEL`.

### Option B — new discovery with your own provider credentials

Leave the banking application running and, from `automation/`, provide the banking credentials plus
your own OpenAI runtime credential and a model supported by your provider account:

```bash
export BANK_STAFF_USERNAME="<local-demo-staff-username>"
export BANK_STAFF_PASSWORD="<local-demo-staff-password>"
export OPENAI_API_KEY="<your-own-key>"
export OPENAI_MODEL="<supported-model>"
BROWSER_HEADLESS=true npm run discover -- \
  --goal ../artifacts/goals/lookup-customer-account.goal.json \
  --policy ../policies/local-bank-discovery.v1.json \
  --planner openai \
  --input customerUsername=customer
```

All secrets are supplied only at runtime. No `.env` or `.env.example` files are tracked, and
credentials must never be committed. Deterministic replay remains available without model
credentials. The checked-in sanitized
[`evidence/genuine-provider/preflight-summary.json`](evidence/genuine-provider/preflight-summary.json)
documents the author's genuine provider-backed discovery run without retaining any credential
value. New run evidence is written below the ignored `evidence/runs/` directory.

## Discovery compiler and replay

The `automation/` workspace implements bounded discovery, integrity-checked JSONL traces, a
model-free deterministic artifact compiler, hash-bound human review, fresh-session replay
verification, and conflict-safe promotion. Generated drafts and lifecycle records live under
`artifacts/drafts/` and are not visible to the active artifact registry. The hand-authored banking
artifact is not overwritten or read as a compiler plan.

See [automation/src/compiler/README.md](automation/src/compiler/README.md) for trace acceptance rules,
multi-trace merging, dead-end removal, parameterization, locator/checkpoint selection, provenance,
lifecycle gates, and exact CLI commands. Fake-planner evidence is labeled separately from genuine
OpenAI provenance.

## License

MIT License — see [LICENSE](LICENSE) for the original license and attribution.
