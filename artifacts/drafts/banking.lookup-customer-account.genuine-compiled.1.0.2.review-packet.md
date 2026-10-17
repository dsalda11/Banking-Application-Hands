# Human review packet

## Approval target

- Artifact: `artifacts/drafts/banking.lookup-customer-account.genuine-compiled.1.0.2.json`
- Compilation manifest: `artifacts/drafts/banking.lookup-customer-account.genuine-compiled.1.0.2.compilation.json`
- Capability: `banking.lookup-customer-account.genuine-compiled`
- Version: `1.0.2`
- Exact canonical artifact hash: `1873dc5b25977f6de3ec522751179c45359df9c50cdf4841e3bf6a08be191095`
- Lifecycle: `draft`

## Genuine-provider provenance

| Result               | Discovery run ID                                 | Trace hash                                                         | Provider | Model           |
| -------------------- | ------------------------------------------------ | ------------------------------------------------------------------ | -------- | --------------- |
| Success              | `discovery-bfeadefa-54c9-4bea-93c5-a71b50e12d0b` | `f92e3570a152091678c9f5c95fef593e5edb736266e176fe544e82908a972205` | `openai` | `gpt-5.6-terra` |
| `CUSTOMER_NOT_FOUND` | `discovery-ef14b0a1-b648-4e60-8015-f789c102006e` | `44a7304d8ec8fc8b8e19a5cf1e785f596556ad9344cd39061ae329a6bb4af3c4` | `openai` | `gpt-5.6-terra` |

Both retained traces passed the production `DiscoveryTraceLoader`. The successful genuine run
observed account number `2023` and current balance `{ "amount": "31444", "currency": "USD" }`.
Those values are retained only as sanitized discovery evidence; neither value occurs in the new
artifact or compilation manifest, and neither is used by an output locator. The second genuine run
terminated with the declared `CUSTOMER_NOT_FOUND` business outcome. No new provider call was made
for this recompilation.

## Runtime contract

- Parameter: `customerUsername` — non-empty string, maximum 128 characters.
- Secret references: `BANK_STAFF_USERNAME`, `BANK_STAFF_PASSWORD`.
- Secrets remain runtime references; no secret value is stored in the artifact, manifest, or packet.
- Declared outputs:
  - `accountNumber` — non-empty string, maximum 64 characters.
  - `currentBalance` — object containing required string `amount` and currency fixed to `USD`.
- Declared business outcome: `CUSTOMER_NOT_FOUND`, detected by visible text `Customer not found.`

## Target fingerprint

The start page must satisfy all three stable observations:

- URL path matches `^/index$`.
- Visible text contains `- Welcome Guest -`.
- Visible text contains `Login :-`.

The prior `^(untitled)$` title-only fingerprint is not present in this draft.

## Ordered actions, locators, fallbacks, and checkpoints

| Step | Action                                    | Primary locator                                                  | Independent fallback                         | Checkpoint                       |
| ---- | ----------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------- | -------------------------------- |
| 1    | Navigate to `http://127.0.0.1:8080/index` | Not applicable                                                   | Not applicable                               | URL matches `/index`             |
| 2    | Enter `BANK_STAFF_USERNAME`               | Role `textbox`, exact name `username`                             | Attribute `name=username`                    | Username textbox remains visible |
| 3    | Enter `BANK_STAFF_PASSWORD`               | Role `textbox`, exact name `password`                             | Attribute `name=password`                    | Password textbox remains visible |
| 4    | Activate login                            | Role `button`, exact name `Submit`                                | None supported by retained surface evidence  | URL matches `/staff`             |
| 5    | Open customers                            | Role `link`, exact name `Customers`                               | Exact visible text `Customers`                | URL matches `/showcust`          |
| 6    | Enter `customerUsername`                  | Role `textbox`, exact name `Find customer by username:`           | Attribute `name=username`                    | Search textbox remains visible   |
| 7    | Activate search                           | Role `button`, exact name `Search`                                | None supported by retained surface evidence  | URL matches `/showcust`          |
| 8    | Extract `accountNumber`                   | Table data cell under header `Account No.`, observed column `3`   | None independently supported by the evidence | Output matches declared shape    |
| 9    | Extract `currentBalance`                  | Table data cell under header `Balance`, observed column `4`       | None independently supported by the evidence | Output matches declared shape    |

The compiler retains safe alternative candidates issued by the same sanitized observation for
ordinary controls. It does not manufacture redundant fallbacks for the login button, search button,
or output cells. Output lookup uses the stable header meaning and table structure, requires exactly
one matching data cell, and never uses the cell's current text. A browser regression reused the
unchanged targets to extract different values (`9001` and `77777`) without recompilation.

The `accountNumber` extractor applies `trim`. The `currentBalance` extractor applies
`amountWithCurrency` with currency `USD`. Final success requires both outputs to match their declared
types. The compiler removed two non-executable terminal exploration events and reported no warnings.

## Risks and limitations

- This draft is derived from one genuine successful trace plus one genuine not-found trace. It has
  not been replayed in a fresh browser session because approval has not occurred.
- Output lookup depends on the stable visible table headers and their observed column positions. A
  table-column redesign will fail closed rather than silently selecting a known output value.
- The filtered result page must expose exactly one data cell for each output column. Zero or multiple
  matches produce an explicit locator error.
- Login and search each retain one locator because their discovery observations exposed no genuinely
  independent stable fallback.
- The target is an intentionally insecure, local-only banking demonstration using synthetic data.
- Discovery used a nondeterministic provider, but post-approval verification must use the model-free
  deterministic replay engine.

## Promotion-safety status

- Artifact schema validation: passed during compilation.
- Artifact semantic validation: passed during compilation.
- Genuine success and business-outcome trace integrity validation: passed.
- Output-locator literal scan: passed; neither `2023` nor `31444` occurs in the artifact or manifest.
- Compiler result: `draft`; manifest warnings: none.
- Human approval record for version `1.0.2`: absent.
- Fresh deterministic replay verification: not run.
- Promotion eligibility: **blocked** until this exact hash is explicitly approved and the required
  fresh model-free success/outcome replays pass.

If accepted, the next action is explicit human approval of this exact hash:

```bash
cd automation
npm run artifact:review -- \
  --artifact ../artifacts/drafts/banking.lookup-customer-account.genuine-compiled.1.0.2.json \
  --manifest ../artifacts/drafts/banking.lookup-customer-account.genuine-compiled.1.0.2.compilation.json \
  --review ../artifacts/drafts/banking.lookup-customer-account.genuine-compiled.1.0.2.review.json \
  --approve
```

Do not run verification or promotion unless that command represents the reviewer's explicit
approval of hash `1873dc5b25977f6de3ec522751179c45359df9c50cdf4841e3bf6a08be191095`.
