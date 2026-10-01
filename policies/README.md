# Policies

This directory stores checked-in, non-secret allowlists and risk policies. Tenant credentials never belong here.

`local-bank-readonly.v1.json` is the strict demonstration policy. It permits only the local banking origin and the routes needed by the lookup artifact, allows only the provider-independent read/input/navigation action vocabulary, denies uploads/downloads and unknown behavior by default, and permits one artifact-declared authentication recovery.

Policies are validated and hashed before the browser starts. Replay evaluates the policy during preflight and again before every action attempt. A denial is terminal; no artifact or runtime value can override it.

`local-bank-discovery.v1.json` applies the same fail-closed boundary to Step 9: local routes only,
read/input actions only, declared secret references only, no screenshots or traces, no uploads,
downloads, scripts, external navigation, consequential actions, or model-proposed policy changes.
