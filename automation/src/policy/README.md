# Policy

Responsibility: fail-closed action, route, risk, and data-handling rules.

May depend on: domain contracts and configuration.

Must not: trust model self-policing or contain tenant credentials.

Policies are versioned, declarative JSON documents. The loader validates the schema, route regular expressions, and computes a content hash before browser startup. `PolicyEngine.preflight()` checks the artifact's policy reference, action vocabulary, static routes, secret references, risk, and recovery configuration. `PolicyEngine.decide()` runs immediately before every action attempt and returns `allow`, `deny`, or `requireIntervention`; the default is deny.

Risk meanings are intentionally small: `read` observes or extracts; `input` enters non-consequential values; `navigation` changes page state within the allowlist; `authentication` handles declared login secrets; `consequential` could change banking state; and `prohibited` is always denied for this demonstration. No model can override a policy decision.

Authentication recovery is artifact data, not replay code. A declared positive expiration checkpoint enables one recovery attempt only when the policy permits it. The interrupted safe step is then retried; consequential steps are never automatically resumed.
