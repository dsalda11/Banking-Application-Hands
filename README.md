# LLM Discovery and Deterministic Banking Automation

This repository combines a local Spring Boot/JSP/MySQL banking application with a TypeScript
browser-automation system. The automation accepts a natural-language goal, uses a genuine LLM only
during bounded discovery, records a sanitized trace, and compiles successful observations into a
typed, versioned capability artifact. An artifact must pass exact-hash human review before the
model-free replay engine can execute it and return typed outputs or a declared business outcome.

Policy checks sit between every proposed or replayed action and the UI. When automation cannot
continue safely, the implemented handoff path can pause at an action boundary, transfer a fenced
lease to a human on the same live browser session, and Resume, Complete, Abort, or Reclaim control.

## Architecture

```text
Discovery
goal -> DiscoveryOrchestrator -> PlannerClient -> OpenAI provider adapter
     -> schema/observation validation -> PolicyEngine -> SurfaceAdapter -> Playwright -> UI
     -> sanitized discovery trace

Compilation and lifecycle
validated trace -> ArtifactCompiler -> canonical draft artifact
                -> exact-hash human review -> fresh verification -> promotion eligibility

Production replay
approved artifact + runtime inputs/secrets -> PolicyEngine -> ReplayEngine
                                           -> SurfaceAdapter -> Playwright -> UI
                                           -> typed result + sanitized evidence
                                           (no planner or provider call)

Human intervention
safe pause -> automation lease released -> human claims fenced lease -> same browser session
           -> Resume / Complete / Abort / Reclaim -> sanitized lifecycle evidence
```

The `SurfaceAdapter` is provider-neutral; Playwright is contained in the web implementation. The
artifact registry and lifecycle code keep draft, reviewed, verified, promotion-eligible, and active
states distinct. Evidence writers retain structured, sanitized events instead of raw browser or
provider payloads. See [REPORT.md](REPORT.md) for the design trade-offs and
[ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md) for the concise implementation record.

## Prerequisites

- Node.js 24 and npm (the automation package rejects other Node majors)
- Docker with Docker Compose v2
- Playwright Chromium, installed by the repository script below
- JDK 8 or newer only when running the Spring/Maven checks outside Docker; the container build uses
  Java 8

Runtime-only variables:

| Variable | Purpose | Required |
| --- | --- | --- |
| `BANK_STAFF_USERNAME` | Local synthetic staff login | Replay and discovery |
| `BANK_STAFF_PASSWORD` | Local synthetic staff login | Replay and discovery |
| `OPENAI_API_KEY` | Reviewer's own OpenAI credential | Genuine discovery only |
| `OPENAI_MODEL` | Provider model name; code has a safe configuration default | Genuine discovery only |
| `BANK_APP_BASE_URL` | Banking UI origin; defaults to `http://127.0.0.1:8080` | No |
| `BROWSER_HEADLESS` | `true` for unattended runs; defaults to `false` | No |

`BANK_NON_STAFF_USERNAME`, `BANK_NON_STAFF_PASSWORD`, and `BANK_CUSTOMER_USERNAME` support focused
proof commands but are not needed for the two reviewer paths below. Docker Compose also accepts
`APP_PORT`, `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD`, and `MYSQL_ROOT_PASSWORD`; its
defaults are suitable only for the local synthetic demonstration.

## Setup from a fresh clone

From the repository root:

```bash
cd automation
npm ci
npm run browser:install
cd ..

docker compose up --build -d
docker compose ps
```

Wait until both `db` and `app` report healthy. The application is then available at
<http://127.0.0.1:8080/index>. The app container builds the executable WAR from source; MySQL is not
published to the host. For a host-port conflict, prefix the startup command with `APP_PORT=8081` and
set `BANK_APP_BASE_URL` to the matching URL for automation runs.

The local synthetic staff credential must be supplied to the automation process at runtime. Do not
store it in the repository. To verify the source outside Docker:

```bash
./mvnw test
./mvnw package

cd automation
npm run schema:check
npm run build
```

## Demo A — deterministic replay without an LLM

Replay executes the reviewed artifact directly. It has no `PlannerClient`, discovery orchestrator,
provider fallback, or model call, so `OPENAI_API_KEY` and `OPENAI_MODEL` are not required.

After starting Compose, validate the exact checked-in artifact and run the successful customer:

```bash
cd automation
export BANK_STAFF_USERNAME="<local-demo-staff-username>"
export BANK_STAFF_PASSWORD="<local-demo-staff-password>"

npm run artifact:validate -- \
  --artifact ../artifacts/drafts/banking.lookup-customer-account.genuine-compiled.1.0.2.json

BROWSER_HEADLESS=true npm run replay -- \
  --artifact ../artifacts/drafts/banking.lookup-customer-account.genuine-compiled.1.0.2.json \
  --policy ../policies/local-bank-discovery.v1.json \
  --input customerUsername=customer
```

Validation prints the canonical hash
`1873dc5b25977f6de3ec522751179c45359df9c50cdf4841e3bf6a08be191095`. Replay exits `0` with a
`success` result whose dynamically extracted outputs include:

```json
{
  "accountNumber": "2023",
  "currentBalance": { "amount": "31444", "currency": "USD" }
}
```

The declared missing-customer case is:

```bash
BROWSER_HEADLESS=true npm run replay -- \
  --artifact ../artifacts/drafts/banking.lookup-customer-account.genuine-compiled.1.0.2.json \
  --policy ../policies/local-bank-discovery.v1.json \
  --input customerUsername=missing-user
```

It prints `status: "businessOutcome"` with `code: "CUSTOMER_NOT_FOUND"` and exits `2`; this is a
known domain result, not an infrastructure failure.

## Demo B — genuine discovery with your own provider credential

Discovery is intentionally separate from replay. With Compose running, provide your own credential
and model configuration at runtime:

```bash
cd automation
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

The command performs bounded one-action-at-a-time discovery and writes a sanitized trace under the
ignored runtime evidence area. Compilation, human review of the exact canonical hash, verification,
and promotion remain deliberate, separate lifecycle commands; discovery does not approve or activate
an artifact.

Secrets are supplied only at runtime. No `.env` or `.env.example` file is tracked, and credentials
must never be committed. The author's key is neither required nor included. The checked-in evidence
demonstrates the genuine `openai / gpt-5.6-terra` run that produced the reviewed capability.

## Evidence

[evidence/README.md](evidence/README.md) is the submission index. Its compact manifest-backed set
demonstrates genuine LLM discovery, successful model-free replay, `CUSTOMER_NOT_FOUND`, policy and
permission denials, bounded authentication recovery, terminal second session expiration, same-session
human takeover plus Resume, and human Abort.

The reviewed genuine artifact is
`banking.lookup-customer-account.genuine-compiled@1.0.2`, canonical hash
`1873dc5b25977f6de3ec522751179c45359df9c50cdf4841e3bf6a08be191095`. It is verified and
promotion-eligible but intentionally remains a draft because active-registry promotion is a separate
human lifecycle action.

## Verification

Run automation checks from `automation/`:

```bash
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

`doctor` validates Node 24, writable repository paths, and the presence of banking/provider runtime
configuration without printing values. It is expected to fail when required genuine-discovery
configuration is absent. Run the Java checks from the repository root with `./mvnw test` and
`./mvnw package`.

## Security notes

Secrets are runtime-only, and artifacts contain secret reference names rather than values. Genuine
provider calls use structured output, no provider tools, and disabled provider-side response storage;
raw requests and responses are not retained. Raw Playwright trace archives are intentionally disabled
because DOM, network, and storage snapshots can preserve sensitive state. Checked-in evidence is a
selected, sanitized subset and is scanned along with tracked files and reachable Git history. These
controls reduce exposure but do not turn the intentionally insecure local banking target or the
single-process operator interface into production systems. Deterministic replay requires no LLM.

## License

MIT License — see [LICENSE](LICENSE) for the original license and attribution.
