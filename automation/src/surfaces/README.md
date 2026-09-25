# Surface adapters

The surface boundary observes and acts on a UI using provider-neutral domain actions. The public interface exposes no Playwright types; the Playwright implementation is isolated under `web/`.

Locator candidates are tried in declared order. `exactlyOne` requires one visible match, while `firstVisible` selects the first visible match. Observation references are ephemeral and are replaced on every observation. Frame paths and scopes remain structured data. Visual anchors are explicitly unsupported in this phase.

Each run owns a fresh browser context and follows an explicit lifecycle. The adapter enforces the configured banking origin, rejects external top-level navigation, and closes unexpected popups. Password fields are never included in observations, screenshots, or traces; tracing begins only after the smoke flow has authenticated.

This phase supplies the web adapter and scripted smoke flow. Generic replay, policy enforcement, sanitized evidence recording, and human handoff remain later phases.
