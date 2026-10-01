# Banking Application Software

An intentionally insecure Spring Boot/JSP/MySQL banking demonstration app using fake data. Keep it local; do not use real credentials or deploy it publicly.

## Start

Requires Docker Desktop and Compose v2.

```bash
cp .env.example .env   # first time only
docker compose up --build -d
```

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

For a port conflict, set `APP_PORT=8081` in `.env`. For startup or JSP problems, check `docker compose logs --no-color app`; for database initialization problems, check `docker compose logs --no-color db`. SQL initialization runs only when the database volume is new.

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
