import { readFile } from 'node:fs/promises';
import { CapabilityArtifact, type CapabilityArtifactType } from '../domain/index.js';
import { contentHash } from '../compiler/canonical-json.js';

export type ArtifactLoadErrorCode =
  | 'ARTIFACT_READ_FAILED'
  | 'ARTIFACT_MALFORMED_JSON'
  | 'ARTIFACT_SCHEMA_INVALID'
  | 'ARTIFACT_SEMANTIC_INVALID'
  | 'UNSUPPORTED_ARTIFACT_VERSION';

export class ArtifactLoadError extends Error {
  constructor(
    readonly code: ArtifactLoadErrorCode,
    message: string,
    readonly issues?: readonly string[],
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'ArtifactLoadError';
  }
}

export interface LoadedArtifact {
  readonly artifact: CapabilityArtifactType;
  readonly contentHash: string;
  readonly path: string;
}

export const SUPPORTED_ARTIFACT_SCHEMA_VERSION = '1.0.0';

export async function loadArtifact(filePath: string): Promise<LoadedArtifact> {
  let rawText: string;
  try {
    rawText = await readFile(filePath, 'utf8');
  } catch (error: unknown) {
    throw new ArtifactLoadError(
      'ARTIFACT_READ_FAILED',
      'Could not read capability artifact',
      [],
      error,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(rawText) as unknown;
  } catch (error: unknown) {
    throw new ArtifactLoadError(
      'ARTIFACT_MALFORMED_JSON',
      'Capability artifact is not valid JSON',
      [],
      error,
    );
  }
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'schemaVersion' in raw &&
    typeof raw.schemaVersion === 'string' &&
    raw.schemaVersion !== SUPPORTED_ARTIFACT_SCHEMA_VERSION
  )
    throw new ArtifactLoadError(
      'UNSUPPORTED_ARTIFACT_VERSION',
      `Unsupported capability schema version ${raw.schemaVersion}`,
    );
  const parsed = CapabilityArtifact.safeParse(raw);
  if (!parsed.success) {
    throw new ArtifactLoadError(
      'ARTIFACT_SCHEMA_INVALID',
      'Capability artifact does not match the domain schema',
      parsed.error.issues.map((issue) => issue.path.join('.')),
    );
  }
  const artifact = parsed.data;
  if (artifact.schemaVersion !== SUPPORTED_ARTIFACT_SCHEMA_VERSION)
    throw new ArtifactLoadError(
      'UNSUPPORTED_ARTIFACT_VERSION',
      `Unsupported capability schema version ${artifact.schemaVersion}`,
    );
  const { validateArtifactSemantics } = await import('../domain/semantic-validation.js');
  const semantic = validateArtifactSemantics(artifact);
  if (!semantic.valid)
    throw new ArtifactLoadError(
      'ARTIFACT_SEMANTIC_INVALID',
      'Capability artifact failed semantic validation',
      semantic.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message),
    );
  return { artifact, contentHash: contentHash(artifact), path: filePath };
}
