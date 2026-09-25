# Domain

The domain layer defines the provider- and surface-independent contracts shared by discovery, compilation, replay, policy, evidence, and intervention. Zod schemas are the runtime source of truth and exported TypeScript types are inferred from them.

It may depend only on Zod and standard TypeScript/JavaScript APIs. It must not call providers, control browsers, read secrets, access the filesystem, or encode Java application internals.

Capability artifacts are strict, versioned JSON data: they contain declarative actions, locators, checkpoints, recovery, contracts, and provenance, but no executable code, prompts, transcripts, or secret values. Shape validation checks individual objects; semantic validation checks cross-references and safety rules such as declared outputs, bounded retries, and usable locators.

Business outcomes such as `CUSTOMER_NOT_FOUND` are legitimate typed results and are distinct from failures. Discovery decisions use ephemeral observation references or bounded coordinate fallbacks, while replay artifacts use ordered, reviewable locator descriptors.

Run `npm run schema:generate` to regenerate the checked-in JSON Schemas and `npm run schema:check` to detect drift. Generation is deterministic; Zod remains the executable source of truth. The generator uses Zod’s built-in emitter where recursive unions remain finite and deterministic review projections for the recursive artifact/decision/event contracts because the installed Zod emitter otherwise expands those unions exponentially.
