# Deterministic trace compiler

`DiscoveryTraceLoader` accepts newline-terminated JSONL only. It validates every strict event,
contiguous sequence and unique event IDs, one consistent run/goal/policy identity, terminal ordering,
supported schema versions, and the terminal SHA-256 integrity claim. A compilable success requires a
validated `finish`, observed passing final checkpoints, and an observed extractor for every reported
output. A business outcome requires its declared code and checkpoint evidence. Stopped, denied,
provider-failed, exhausted, aborted, unresolved-intervention, truncated, secret-bearing, and
locator-provenance-invalid traces are rejected.

One primary success trace may be combined with outcome traces and repeated successful traces. Goal
and policy identities/hashes must match. The compiler is provider-independent: it has no planner,
Playwright, application-source, or database dependency. It selects only validated, policy-allowed,
executed, successful actions; failed/no-progress exploration is retained only as manifest diagnostics.

Values retain typed `input` and `secret` references. Targets retain only observation-issued candidates
that resolved exactly once. Candidate order is role/accessibility, label, visible text,
placeholder/stable attribute, then stable CSS. XPath, visual/coordinate, unstable-index, ambiguous,
and invented candidates fail compilation. Temporary observation references never enter artifacts.

Checkpoints come from observed routes, resolved targets, typed extraction, final goal criteria, and
supplied outcome evidence. Navigation retry is bounded and emitted only with compatible multiple-run
evidence; other recovery defaults to `none`. Consequential or ambiguous-risk actions fail compilation.

Artifact JSON uses canonical key ordering and no changing compilation time, so identical inputs
produce identical bytes. Wall-clock provenance is confined to the separate compilation manifest.
Review approval binds the exact artifact hash. Verification creates a fresh session for every
success/outcome case and uses `ReplayEngine` without a model. Promotion is an explicit exclusive copy
followed by registry reload; conflicts are never overwritten.

```bash
npm run trace:validate -- --trace ../evidence/runs/<run>/discovery-events.jsonl

npm run artifact:compile -- \
  --goal ../artifacts/goals/lookup-customer-account.goal.json \
  --trace ../evidence/runs/<success>/discovery-events.jsonl \
  --trace ../evidence/runs/<not-found>/discovery-events.jsonl \
  --artifact-id banking.lookup-customer-account.fake-compiled --version 1.0.1

npm run artifact:review -- --artifact ../artifacts/drafts/<artifact>.json \
  --manifest ../artifacts/drafts/<artifact>.compilation.json \
  --review ../artifacts/drafts/<artifact>.review.json --approve

npm run artifact:verify -- --artifact ../artifacts/drafts/<artifact>.json \
  --review ../artifacts/drafts/<artifact>.review.json \
  --policy ../policies/local-bank-discovery.v1.json \
  --input customerUsername=customer \
  --outcome-input CUSTOMER_NOT_FOUND:customerUsername=missing-user

npm run artifact:promote -- --artifact ../artifacts/drafts/<artifact>.json \
  --review ../artifacts/drafts/<artifact>.review.json \
  --verification ../artifacts/drafts/<artifact>.verification.json \
  --registry /tmp/capability-registry
```

Secrets are environment variables only. Do not place them in CLI arguments.
