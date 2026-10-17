# Submission evidence

This index is the shortest path through the final evidence. The machine-readable selection is in
[submission-manifest.json](submission-manifest.json); `cd automation && npm run evidence:check`
validates every listed file, integrity-bound trace and artifact hash, expected result, index link, and
confidentiality rule.

## 1. Genuine LLM discovery

- **Successful discovery** — run `discovery-bfeadefa-54c9-4bea-93c5-a71b50e12d0b`, OpenAI model
  `gpt-5.6-terra`, trace hash
  `f92e3570a152091678c9f5c95fef593e5edb736266e176fe544e82908a972205`. The sanitized
  [trace](runs/discovery-bfeadefa-54c9-4bea-93c5-a71b50e12d0b/discovery-events.jsonl) and
  [result](runs/discovery-bfeadefa-54c9-4bea-93c5-a71b50e12d0b/result.json) show genuine provider
  decisions and typed outputs `2023` and `31444 USD`.
- **Missing customer** — run `discovery-ef14b0a1-b648-4e60-8015-f789c102006e`, trace hash
  `44a7304d8ec8fc8b8e19a5cf1e785f596556ad9344cd39061ae329a6bb4af3c4`. Its sanitized
  [trace](runs/discovery-ef14b0a1-b648-4e60-8015-f789c102006e/discovery-events.jsonl) and
  [result](runs/discovery-ef14b0a1-b648-4e60-8015-f789c102006e/result.json) end with the declared
  `CUSTOMER_NOT_FOUND` outcome.
- [Provider preflight](genuine-provider/preflight-summary.json) records that page content was marked
  untrusted, only secret references crossed the boundary, and no forbidden value was detected.

The discovery JSONL is the production sanitized representation. It retains structured proposals and
provider/model metadata, not raw provider request or response bodies.

## 2. Compiled capability artifact

The verified artifact is
[banking.lookup-customer-account.genuine-compiled@1.0.2](../artifacts/drafts/banking.lookup-customer-account.genuine-compiled.1.0.2.json),
canonical hash `1873dc5b25977f6de3ec522751179c45359df9c50cdf4841e3bf6a08be191095`.

- [Compilation provenance](../artifacts/drafts/banking.lookup-customer-account.genuine-compiled.1.0.2.compilation.json)
- [Human review packet](../artifacts/drafts/banking.lookup-customer-account.genuine-compiled.1.0.2.review-packet.md)
- [Exact-hash approval](../artifacts/drafts/banking.lookup-customer-account.genuine-compiled.1.0.2.review.json)
- [Lifecycle verification](../artifacts/drafts/banking.lookup-customer-account.genuine-compiled.1.0.2.verification.json)
- [Complete Step 11 chain](../artifacts/drafts/banking.lookup-customer-account.genuine-compiled.1.0.2.step11-verification.json)

Together these link genuine discovery to compilation, human approval of exact bytes, two fresh
model-free replays, and `promotionEligible` status without silently promoting the artifact.

## 3. Successful model-free replay

Run `replay-82901137-8bfa-4b05-8572-d98e017b4536` used the approved hash above. The
[event log](runs/replay-82901137-8bfa-4b05-8572-d98e017b4536/events.jsonl) records policy decisions,
ordered actions, structural `tableCell` extraction, checkpoints, raw-trace omission, and terminal
success. The [result](runs/replay-82901137-8bfa-4b05-8572-d98e017b4536/result.json) contains typed
outputs `accountNumber="2023"` and `currentBalance={amount:"31444",currency:"USD"}`. Replay made
zero model calls.

## 4. `CUSTOMER_NOT_FOUND`

Run `replay-96576566-7d42-494f-8223-10486f78884b` is a fresh model-free session. The
[event log](runs/replay-96576566-7d42-494f-8223-10486f78884b/events.jsonl) records
`outcome_detected`; the [result](runs/replay-96576566-7d42-494f-8223-10486f78884b/result.json) is
`businessOutcome:CUSTOMER_NOT_FOUND`, not an infrastructure or locator failure.

## 5. Policy denial

Run `replay-5a0d56c0-1b01-4bcd-bd5a-ba7ddb8ffbe1` proves fail-closed route enforcement. Its
[event log](runs/replay-5a0d56c0-1b01-4bcd-bd5a-ba7ddb8ffbe1/events.jsonl) records `policy_deny`
before browser action; the [result](runs/replay-5a0d56c0-1b01-4bcd-bd5a-ba7ddb8ffbe1/result.json)
is `POLICY_DENIED`.

## 6. Permission denial

Run `replay-433e5d86-3222-4d75-872e-879decde7e61` shows a rendered access denial becoming the
declared `PERMISSION_DENIED` result. See its
[event log](runs/replay-433e5d86-3222-4d75-872e-879decde7e61/events.jsonl) and
[result](runs/replay-433e5d86-3222-4d75-872e-879decde7e61/result.json).

## 7. Authentication recovery

The stable [recovery fixture](submission/authentication-recovery/artifact.json) reproduces one safe,
bounded reauthentication. Run `replay-3f8a160f-4d7b-48d3-8e44-5524772c93aa` records
`session_expired → recovery_started → recovery_succeeded → success` in its
[event log](submission/authentication-recovery/runs/replay-3f8a160f-4d7b-48d3-8e44-5524772c93aa/events.jsonl)
and returns `RECOVERED_OUTPUT` in the
[result](submission/authentication-recovery/runs/replay-3f8a160f-4d7b-48d3-8e44-5524772c93aa/result.json).

The companion run `replay-52e384d4-f0ce-4634-8448-48832e80b03b` proves the bound: after one
successful recovery, a second expiration terminates with `SESSION_EXPIRED`. See the
[event log](submission/authentication-second-expiration/runs/replay-52e384d4-f0ce-4634-8448-48832e80b03b/events.jsonl)
and [result](submission/authentication-second-expiration/runs/replay-52e384d4-f0ce-4634-8448-48832e80b03b/result.json).

## 8. Human takeover and Resume

Run `replay-a9985415-1ce5-40e2-847c-2807012e5a0b` proves the same-session transfer lifecycle. Its
[event log](runs/replay-a9985415-1ce5-40e2-847c-2807012e5a0b/events.jsonl) records the safe boundary,
automation pause, human claim, lease ownership changes, Resume validation, session continuity, and
continued extraction. The [result](runs/replay-a9985415-1ce5-40e2-847c-2807012e5a0b/result.json) is
successful.

## 9. Human Abort

Run `replay-cd1a62b0-4175-48ca-b850-cd2347946196` records deliberate termination while paused.
The [event log](runs/replay-cd1a62b0-4175-48ca-b850-cd2347946196/events.jsonl) includes
`human_abort` and `run_aborted`; the
[result](runs/replay-cd1a62b0-4175-48ca-b850-cd2347946196/result.json) is
`aborted:ABORTED_BY_HUMAN`.

## 10. Confidentiality and selection policy

Only the paths in [submission-manifest.json](submission-manifest.json) are submission evidence.
Other run directories remain ignored local development output. The curated set excludes rejected
artifact versions, abandoned runs, redundant screenshots/snapshots, caches, raw provider payloads,
cookies, storage state, authorization headers, operator tokens, credentials, and raw Playwright
trace archives. Synthetic demo outputs are intentionally retained as assignment evidence.
