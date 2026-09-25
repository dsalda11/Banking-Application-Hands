import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CapabilityArtifact } from '../../src/domain/artifact.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixturePath = path.join(repositoryRoot, 'artifacts/lookup-customer-account.v1.example.json');

export function readFixture(): unknown {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown;
}

export function parsedFixture(): unknown {
  return CapabilityArtifact.parse(readFixture()) as unknown;
}

export function cloneFixture(): Record<string, unknown> {
  return structuredClone(readFixture()) as Record<string, unknown>;
}
