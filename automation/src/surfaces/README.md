# Surface adapters

The surface boundary observes and acts on a UI using provider-neutral domain actions. The public interface exposes no Playwright types; the Playwright implementation is isolated under `web/`.

Locator candidates are tried in declared order. `exactlyOne` requires one visible match, while
`firstVisible` selects the first visible match. Observation references are ephemeral and are
replaced on every observation. Frame paths and scopes remain structured data. Visual anchors are
discovery-only and are not emitted into replay artifacts.

Each run owns a fresh browser context and follows an explicit lifecycle. The adapter enforces the
configured origin, rejects external top-level navigation, and closes unexpected popups. Password
fields are excluded from observations and screenshots. Raw Playwright tracing is disabled by the
checked-in policies because its archives can retain DOM, network, and storage state.

The web adapter supports scripted smoke checks, bounded discovery, deterministic replay, policy
enforcement, sanitized evidence recording, authentication recovery, and same-session human handoff.
