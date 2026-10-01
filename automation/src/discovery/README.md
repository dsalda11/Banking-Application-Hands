# Discovery

Responsibility: the bounded LLM-driven observe/validate/authorize/act loop.

May depend on: domain contracts, model adapters, surfaces, policy, and evidence interfaces.

Must not: implement deterministic replay logic or bypass policy checks.

`DiscoveryOrchestrator` owns budgets, stale-observation checks, repetition detection, policy
evaluation, secret indirection, evidence, and cleanup. `PlannerClient` receives only the validated
goal, a bounded sanitized observation, safe prior-result metadata, remaining budgets, and a concise
trace summary. It returns exactly one strict `DiscoveryProposal`; it cannot access Playwright or
execute anything.

The production OpenAI adapter uses the Responses API with `store: false`, no tools, and strict JSON
Schema output. The scripted planner supplies deterministic offline tests. Page text is untrusted
data and cannot modify policy, budgets, secret declarations, or the proposal vocabulary.

Observation element IDs are valid only for one state fingerprint. Locator candidates are created by
the surface collector, including frame locators where available; model-invented selectors are not
accepted. Password values, cookies, storage, hidden content, raw HTML, scripts, and unrestricted
screenshots are excluded.
