import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EvidenceReferenceType } from '../../domain/evidence.js';

export async function prepareEvidenceDirectory(root: string, runId: string): Promise<string> {
  const directory = path.join(root, 'runs', runId);
  await mkdir(directory, { recursive: true });
  return directory;
}

export function evidenceReference(
  root: string,
  filePath: string,
  kind: EvidenceReferenceType['kind'],
  mediaType: string,
): EvidenceReferenceType {
  const relative = path.relative(root, filePath).split(path.sep).join('/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative))
    throw new Error('Invalid evidence path');
  return {
    evidenceId: `surface-${path.basename(filePath).replace(/[^A-Za-z0-9_.-]/g, '-')}`,
    kind,
    path: relative,
    sanitization: 'sanitized',
    mediaType,
  };
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
