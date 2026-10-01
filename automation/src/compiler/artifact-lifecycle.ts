import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { RunResultType } from '../domain/run-result.js';
import type { LoadedPolicy } from '../policy/policy-loader.js';
import { loadArtifact } from '../replay/artifact-loader.js';
import { ArtifactRegistry } from '../replay/artifact-registry.js';
import { ReplayEngine } from '../replay/replay-engine.js';
import type { SurfaceAdapter } from '../surfaces/surface-types.js';
import { canonicalJsonFile, contentHash } from './canonical-json.js';
import type { CompilationManifest, CompilationResult } from './artifact-compiler.js';

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ReviewRecord = z.strictObject({
  schemaVersion: z.literal('1.0.0'),
  artifactId: z.string().min(1),
  artifactVersion: z.string().min(1),
  artifactHash: Hash,
  decision: z.enum(['approved', 'rejected']),
  reviewedAt: z.string().datetime(),
  reviewer: z.string().min(1).max(128),
});
export type ReviewRecordType = z.infer<typeof ReviewRecord>;

export const VerificationManifest = z.strictObject({
  schemaVersion: z.literal('1.0.0'),
  artifactId: z.string().min(1),
  artifactVersion: z.string().min(1),
  artifactHash: Hash,
  policyId: z.string().min(1),
  policyVersion: z.string().min(1),
  policyHash: Hash,
  reviewHash: Hash,
  verifiedAt: z.string().datetime(),
  freshSessions: z.number().int().min(1),
  cases: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        expected: z.string().min(1),
        actual: z.string().min(1),
        runId: z.string().min(1),
        passed: z.boolean(),
        outputsHash: Hash.optional(),
      }),
    )
    .min(1),
  result: z.enum(['replayVerified', 'rejected', 'promotionEligible']),
});
export type VerificationManifestType = z.infer<typeof VerificationManifest>;

export class ArtifactLifecycleError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactLifecycleError';
  }
}

async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch {
    throw new ArtifactLifecycleError(
      'RECORD_READ_FAILED',
      `Could not read ${path.basename(filePath)}`,
    );
  }
}

async function writeExclusive(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(filePath, canonicalJsonFile(value), { encoding: 'utf8', flag: 'wx' });
  } catch {
    throw new ArtifactLifecycleError('ARTIFACT_CONFLICT', `Refusing to overwrite ${filePath}`);
  }
}

export async function storeDraft(
  draftsDirectory: string,
  compilation: CompilationResult,
): Promise<{ artifactPath: string; manifestPath: string }> {
  const stem = `${compilation.artifact.id}.${compilation.artifact.version}`;
  const artifactPath = path.join(draftsDirectory, `${stem}.json`);
  const manifestPath = path.join(draftsDirectory, `${stem}.compilation.json`);
  await writeExclusive(artifactPath, compilation.artifact);
  await writeExclusive(manifestPath, compilation.manifest);
  return { artifactPath, manifestPath };
}

export async function reviewArtifact(options: {
  artifactPath: string;
  compilationManifestPath?: string;
  reviewPath: string;
  decision: 'approved' | 'rejected';
  reviewer: string;
  now?: () => Date;
}): Promise<ReviewRecordType> {
  const loaded = await loadArtifact(options.artifactPath);
  if (options.compilationManifestPath) {
    const manifest = (await readJson(options.compilationManifestPath)) as CompilationManifest;
    if (manifest.artifact.hash !== loaded.contentHash)
      throw new ArtifactLifecycleError(
        'COMPILATION_HASH_MISMATCH',
        'Compilation provenance does not match artifact',
      );
  }
  const record = ReviewRecord.parse({
    schemaVersion: '1.0.0',
    artifactId: loaded.artifact.id,
    artifactVersion: loaded.artifact.version,
    artifactHash: loaded.contentHash,
    decision: options.decision,
    reviewedAt: (options.now?.() ?? new Date()).toISOString(),
    reviewer: options.reviewer,
  });
  await writeExclusive(options.reviewPath, record);
  return record;
}

export interface VerificationCase {
  readonly name: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly expected: 'success' | string;
  readonly expectedOutputs?: Readonly<Record<string, unknown>>;
}

function resultKind(result: RunResultType): string {
  if (result.status === 'failure')
    return `failure:${result.error.code}:${result.error.stepId ?? 'preflight'}`;
  return result.status === 'businessOutcome' || result.status === 'permissionDenied'
    ? result.code
    : result.status;
}

export async function verifyArtifact(options: {
  artifactPath: string;
  reviewPath: string;
  verificationPath: string;
  loadedPolicy: LoadedPolicy;
  secrets: Readonly<Record<string, string>>;
  cases: readonly VerificationCase[];
  baseUrl: string;
  evidenceDirectory: string;
  headless: boolean;
  adapterFactory: () => SurfaceAdapter;
  now?: () => Date;
}): Promise<VerificationManifestType> {
  const loaded = await loadArtifact(options.artifactPath);
  const review = ReviewRecord.parse(await readJson(options.reviewPath));
  if (review.decision !== 'approved' || review.artifactHash !== loaded.contentHash)
    throw new ArtifactLifecycleError('REVIEW_HASH_MISMATCH', 'Approved review is absent or stale');
  if (options.cases.length === 0)
    throw new ArtifactLifecycleError(
      'VERIFICATION_CASES_MISSING',
      'At least one replay case is required',
    );
  const declaredOutcomes = new Set(
    loaded.artifact.contract.businessOutcomes.map((outcome) => outcome.code),
  );
  for (const outcome of declaredOutcomes)
    if (!options.cases.some((candidate) => candidate.expected === outcome))
      throw new ArtifactLifecycleError('OUTCOME_CASE_MISSING', `Verification lacks ${outcome}`);
  const results = [];
  for (const testCase of options.cases) {
    // The factory is intentionally invoked per case: discovery sessions and previous
    // replay cases cannot leak browser context into verification.
    const replay = await new ReplayEngine().run({
      loadedArtifact: loaded,
      loadedPolicy: options.loadedPolicy,
      inputs: testCase.inputs,
      secrets: options.secrets,
      baseUrl: options.baseUrl,
      evidenceDirectory: options.evidenceDirectory,
      headless: options.headless,
      adapter: options.adapterFactory(),
    });
    const actual = resultKind(replay);
    const outputs = replay.status === 'success' ? replay.outputs : undefined;
    const passed =
      actual === testCase.expected &&
      (testCase.expectedOutputs === undefined ||
        JSON.stringify(outputs) === JSON.stringify(testCase.expectedOutputs));
    results.push({
      name: testCase.name,
      expected: testCase.expected,
      actual,
      runId: replay.runId,
      passed,
      ...(outputs ? { outputsHash: contentHash(outputs) } : {}),
    });
  }
  const passed = results.every((result) => result.passed);
  const manifest = VerificationManifest.parse({
    schemaVersion: '1.0.0',
    artifactId: loaded.artifact.id,
    artifactVersion: loaded.artifact.version,
    artifactHash: loaded.contentHash,
    policyId: options.loadedPolicy.policy.id,
    policyVersion: options.loadedPolicy.policy.version,
    policyHash: options.loadedPolicy.contentHash,
    reviewHash: contentHash(review),
    verifiedAt: (options.now?.() ?? new Date()).toISOString(),
    freshSessions: options.cases.length,
    cases: results,
    result: passed ? 'promotionEligible' : 'rejected',
  });
  await writeExclusive(options.verificationPath, manifest);
  if (!passed)
    throw new ArtifactLifecycleError(
      'REPLAY_VERIFICATION_FAILED',
      `Replay cases failed: ${results
        .filter((result) => !result.passed)
        .map((result) => `${result.name} expected ${result.expected}, received ${result.actual}`)
        .join('; ')}`,
    );
  return manifest;
}

export async function promoteArtifact(options: {
  artifactPath: string;
  reviewPath: string;
  verificationPath: string;
  registryDirectory: string;
}): Promise<string> {
  const loaded = await loadArtifact(options.artifactPath);
  const review = ReviewRecord.parse(await readJson(options.reviewPath));
  const verification = VerificationManifest.parse(await readJson(options.verificationPath));
  if (
    review.decision !== 'approved' ||
    review.artifactHash !== loaded.contentHash ||
    verification.artifactHash !== loaded.contentHash ||
    verification.reviewHash !== contentHash(review) ||
    verification.result !== 'promotionEligible'
  )
    throw new ArtifactLifecycleError(
      'PROMOTION_NOT_ELIGIBLE',
      'Lifecycle hashes or states do not permit promotion',
    );
  await mkdir(options.registryDirectory, { recursive: true });
  const destination = path.join(
    options.registryDirectory,
    `${loaded.artifact.id}.${loaded.artifact.version}.json`,
  );
  try {
    await copyFile(options.artifactPath, destination, constants.COPYFILE_EXCL);
  } catch {
    throw new ArtifactLifecycleError(
      'PROMOTION_CONFLICT',
      'Active artifact ID/version already exists',
    );
  }
  const registry = new ArtifactRegistry(options.registryDirectory);
  await registry.discover();
  const promoted = registry.get(loaded.artifact.id, loaded.artifact.version);
  if (promoted.contentHash !== loaded.contentHash)
    throw new ArtifactLifecycleError('PROMOTION_HASH_MISMATCH', 'Registry reload hash mismatch');
  return destination;
}
