# Replay

The replay layer is a deterministic artifact interpreter. `artifact-loader.ts` parses and
semantically validates one JSON capability before a browser is opened. `artifact-registry.ts`
discovers validated active filesystem artifacts by exact `id@version`; drafts remain outside that
registry. `runtime-bindings.ts` validates declared non-secret inputs and separately binds only the
artifact's declared environment secrets. `replay-engine.ts` executes ordered steps through the
provider-neutral `SurfaceAdapter`.

Each action attempt, checkpoint, outcome detection, locator strategy, duration, and sanitized error is recorded as event evidence. Retry attempts are bounded by the artifact's declared recovery policy; validation, configuration, and terminal target errors are never retried. A declared business outcome terminates with `businessOutcome`, while a failed success checkpoint or missing required output terminates with `failure`.

Replay has no banking selectors, step IDs, URLs, credential names, or business outcome codes in its
implementation. It does not call an LLM, database, application controller, or Java code. The
scripted smoke remains a lower-level adapter integration check, not the production demo.
