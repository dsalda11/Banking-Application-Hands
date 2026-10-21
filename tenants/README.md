# Tenant variants

These declarative files specialize the approved shared banking capability without copying or
modifying it. Both configurations bind to the exact approved `1.0.2` artifact hash. They contain
environment-variable references only; credential values are never tenant configuration data.

- `tenant-a.json` describes the original ABC Bank UI at `/index`.
- `tenant-b.json` describes the Harbor Community variant at `/tenant-b/login`.

The Step 1 resolver validates and hashes these configurations independently of Playwright. It only
permits target-locator, URL-checkpoint, and known-business-outcome text differences. Applying a
resolved configuration to replay is intentionally deferred to cross-tenant Step 2.
