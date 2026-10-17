#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const evidenceRoot = path.join(repositoryRoot, "evidence");
const manifestPath = path.join(evidenceRoot, "submission-manifest.json");
const indexPath = path.join(evidenceRoot, "README.md");
const expectedArtifactHash =
  "1873dc5b25977f6de3ec522751179c45359df9c50cdf4841e3bf6a08be191095";

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function contentHash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function json(relativePath) {
  return JSON.parse(
    await readFile(path.join(repositoryRoot, relativePath), "utf8"),
  );
}

async function jsonl(relativePath) {
  const text = await readFile(path.join(repositoryRoot, relativePath), "utf8");
  assert(text.endsWith("\n"), `${relativePath} must end with a newline`);
  return text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(item)));
    else files.push(item);
  }
  return files;
}

function eventExists(events, eventType) {
  return events.some((event) => event.eventType === eventType);
}

const manifest = await json("evidence/submission-manifest.json");
assert(
  manifest.schemaVersion === "1.0.0",
  "Unsupported evidence manifest version",
);
assert(
  manifest.artifact.canonicalHash === expectedArtifactHash,
  "Manifest artifact hash changed",
);

const declaredFiles = [
  "evidence/README.md",
  "evidence/submission-manifest.json",
  ...manifest.groups.flatMap((group) => group.files),
];
const uniqueFiles = [...new Set(declaredFiles)];
assert(
  uniqueFiles.length === declaredFiles.length,
  "Submission manifest contains duplicate files",
);

for (const relativePath of uniqueFiles) {
  const absolutePath = path.join(repositoryRoot, relativePath);
  assert(
    (await stat(absolutePath)).isFile(),
    `Required evidence is not a file: ${relativePath}`,
  );
  const ignored = spawnSync("git", [
    "-C",
    repositoryRoot,
    "check-ignore",
    "-q",
    relativePath,
  ]);
  assert(
    ignored.status !== 0,
    `Required evidence is still ignored: ${relativePath}`,
  );
}

const artifact = await json(manifest.artifact.path);
assert(
  contentHash(artifact) === expectedArtifactHash,
  "Canonical artifact hash mismatch",
);
assert(artifact.id === manifest.artifact.id, "Artifact ID mismatch");
assert(
  artifact.version === manifest.artifact.version,
  "Artifact version mismatch",
);

const review = await json(
  "artifacts/drafts/banking.lookup-customer-account.genuine-compiled.1.0.2.review.json",
);
assert(review.decision === "approved", "Exact-hash approval is absent");
assert(review.artifactHash === expectedArtifactHash, "Approval hash mismatch");
const verification = await json(
  "artifacts/drafts/banking.lookup-customer-account.genuine-compiled.1.0.2.verification.json",
);
assert(
  verification.result === "promotionEligible",
  "Artifact is not promotion eligible",
);
assert(
  verification.artifactHash === expectedArtifactHash,
  "Verification hash mismatch",
);
assert(
  verification.cases.every((item) => item.passed),
  "A lifecycle verification case failed",
);

for (const groupId of [
  "genuine-discovery-success",
  "genuine-discovery-not-found",
]) {
  const group = manifest.groups.find((item) => item.id === groupId);
  const tracePath = group.files.find((file) =>
    file.endsWith("discovery-events.jsonl"),
  );
  const events = await jsonl(tracePath);
  const terminal = events.at(-1);
  assert(terminal.runId === group.runId, `${groupId} run ID mismatch`);
  assert(
    terminal.data.traceHash === group.traceHash,
    `${groupId} declared trace hash mismatch`,
  );
  assert(
    contentHash(events.slice(0, -1)) === group.traceHash,
    `${groupId} trace integrity failed`,
  );
  const proposals = events.filter(
    (event) => event.eventType === "planner_proposal",
  );
  assert(proposals.length > 0, `${groupId} lacks genuine provider proposals`);
  assert(
    proposals.every(
      (event) =>
        event.data.provider === group.provider &&
        event.data.model === group.model,
    ),
    `${groupId} provider provenance mismatch`,
  );
}

const replaySuccess = await json(
  "evidence/runs/replay-82901137-8bfa-4b05-8572-d98e017b4536/result.json",
);
assert(
  replaySuccess.status === "success",
  "Successful deterministic replay is not successful",
);
assert(
  replaySuccess.artifactHash === expectedArtifactHash,
  "Replay artifact hash mismatch",
);
assert(
  replaySuccess.outputs.accountNumber === "2023",
  "Account output mismatch",
);
assert(
  replaySuccess.outputs.currentBalance.amount === "31444",
  "Balance output mismatch",
);
assert(
  replaySuccess.outputs.currentBalance.currency === "USD",
  "Currency output mismatch",
);
const replaySuccessEvents = await jsonl(
  "evidence/runs/replay-82901137-8bfa-4b05-8572-d98e017b4536/events.jsonl",
);
assert(
  eventExists(replaySuccessEvents, "run_succeeded"),
  "Successful replay lacks terminal event",
);
assert(
  eventExists(replaySuccessEvents, "policy_allow"),
  "Successful replay lacks policy evidence",
);
assert(
  eventExists(replaySuccessEvents, "checkpoint_result"),
  "Successful replay lacks checkpoints",
);

const notFound = await json(
  "evidence/runs/replay-96576566-7d42-494f-8223-10486f78884b/result.json",
);
assert(
  notFound.status === "businessOutcome",
  "Not-found replay is not a business outcome",
);
assert(
  notFound.code === "CUSTOMER_NOT_FOUND",
  "Not-found replay code mismatch",
);
const notFoundEvents = await jsonl(
  "evidence/runs/replay-96576566-7d42-494f-8223-10486f78884b/events.jsonl",
);
assert(
  eventExists(notFoundEvents, "outcome_detected"),
  "Not-found outcome evidence is absent",
);

const policyDenial = await json(
  "evidence/runs/replay-5a0d56c0-1b01-4bcd-bd5a-ba7ddb8ffbe1/result.json",
);
assert(
  policyDenial.error?.code === "POLICY_DENIED",
  "Policy-denial result mismatch",
);
const policyEvents = await jsonl(
  "evidence/runs/replay-5a0d56c0-1b01-4bcd-bd5a-ba7ddb8ffbe1/events.jsonl",
);
assert(
  eventExists(policyEvents, "policy_deny"),
  "Policy-denial event is absent",
);

const permissionDenial = await json(
  "evidence/runs/replay-433e5d86-3222-4d75-872e-879decde7e61/result.json",
);
assert(
  permissionDenial.status === "permissionDenied" &&
    permissionDenial.code === "PERMISSION_DENIED",
  "Permission-denial result mismatch",
);

const recovery = await json(
  "evidence/submission/authentication-recovery/runs/replay-3f8a160f-4d7b-48d3-8e44-5524772c93aa/result.json",
);
const recoveryEvents = await jsonl(
  "evidence/submission/authentication-recovery/runs/replay-3f8a160f-4d7b-48d3-8e44-5524772c93aa/events.jsonl",
);
assert(
  recovery.status === "success",
  "Authentication recovery did not succeed",
);
assert(
  eventExists(recoveryEvents, "recovery_started"),
  "Recovery start evidence is absent",
);
assert(
  eventExists(recoveryEvents, "recovery_succeeded"),
  "Recovery success evidence is absent",
);

const secondExpiration = await json(
  "evidence/submission/authentication-second-expiration/runs/replay-52e384d4-f0ce-4634-8448-48832e80b03b/result.json",
);
assert(
  secondExpiration.error?.code === "SESSION_EXPIRED",
  "Second expiration is not terminal",
);

const resume = await json(
  "evidence/runs/replay-a9985415-1ce5-40e2-847c-2807012e5a0b/result.json",
);
const resumeEvents = await jsonl(
  "evidence/runs/replay-a9985415-1ce5-40e2-847c-2807012e5a0b/events.jsonl",
);
assert(
  resume.status === "success",
  "Human-Resume run did not finish successfully",
);
for (const eventType of [
  "safe_boundary_reached",
  "automation_paused",
  "human_claim_accepted",
  "automation_resumed",
  "session_continuity_verified",
])
  assert(
    eventExists(resumeEvents, eventType),
    `Human-Resume evidence lacks ${eventType}`,
  );

const abort = await json(
  "evidence/runs/replay-cd1a62b0-4175-48ca-b850-cd2347946196/result.json",
);
const abortEvents = await jsonl(
  "evidence/runs/replay-cd1a62b0-4175-48ca-b850-cd2347946196/events.jsonl",
);
assert(
  abort.status === "aborted" && abort.code === "ABORTED_BY_HUMAN",
  "Abort result mismatch",
);
assert(
  eventExists(abortEvents, "human_abort"),
  "Human Abort evidence is absent",
);

const index = await readFile(indexPath, "utf8");
for (const match of index.matchAll(/\]\(([^)]+)\)/g)) {
  const rawTarget = match[1].replace(/^<|>$/g, "").split("#", 1)[0];
  if (!rawTarget || /^[a-z]+:/i.test(rawTarget)) continue;
  const target = path.resolve(evidenceRoot, decodeURIComponent(rawTarget));
  assert(
    (await stat(target)).isFile(),
    `Evidence index has a broken link: ${rawTarget}`,
  );
}

const sensitivePatterns = [
  ["provider API key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  [
    "authorization header",
    /authorization\s*[:=]\s*bearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  ],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  [
    "forbidden retained field",
    /"(?:cookies?|storageState|operatorToken|apiPayload|rawProviderRequest|rawProviderResponse)"\s*:/i,
  ],
];
const runtimeSecrets = [
  process.env.OPENAI_API_KEY,
  process.env.BANK_STAFF_PASSWORD,
]
  .filter((value) => typeof value === "string" && value.length >= 3)
  .map((value) => Buffer.from(value));
const fixtureSecrets = [
  "fixture-password-sentinel-3b7d",
  "fixture-session-token-sentinel-8ca1",
  "fixture-cookie-sentinel-c901",
].map((value) => Buffer.from(value));

for (const relativePath of uniqueFiles) {
  const bytes = await readFile(path.join(repositoryRoot, relativePath));
  for (const secret of [...runtimeSecrets, ...fixtureSecrets])
    assert(
      !bytes.includes(secret),
      `Confidential value retained in ${relativePath}`,
    );
  if (bytes.includes(0) || bytes.byteLength > 2 * 1024 * 1024) continue;
  const text = bytes.toString("utf8");
  for (const [name, pattern] of sensitivePatterns)
    assert(!pattern.test(text), `${name} found in ${relativePath}`);
}

for (const file of await walk(evidenceRoot))
  assert(
    !/\.(?:zip|trace)$/i.test(file),
    `Raw browser trace retained: ${file}`,
  );

for (const rejected of [
  "artifacts/drafts/banking.lookup-customer-account.genuine-compiled.1.0.1.json",
  "artifacts/drafts/banking.lookup-customer-account.genuine-compiled.1.0.1.compilation.json",
  "artifacts/drafts/banking.lookup-customer-account.genuine-compiled.1.0.1.review-packet.md",
]) {
  const exists = await stat(path.join(repositoryRoot, rejected)).then(
    () => true,
    () => false,
  );
  assert(!exists, `Rejected draft remains in final submission: ${rejected}`);
}

console.log(
  `Evidence check passed: ${manifest.groups.length} behavior groups and ${uniqueFiles.length} required files validated.`,
);
