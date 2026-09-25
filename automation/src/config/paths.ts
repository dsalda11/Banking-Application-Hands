import { fileURLToPath } from 'node:url';
import path from 'node:path';

const configDirectory = path.dirname(fileURLToPath(import.meta.url));
const automationRoot = path.resolve(configDirectory, '../..');
const repositoryRoot = path.resolve(automationRoot, '..');

export interface RepositoryPaths {
  readonly repositoryRoot: string;
  readonly automationRoot: string;
  readonly artifactsDirectory: string;
  readonly policiesDirectory: string;
  readonly evidenceDirectory: string;
}

export interface PathOverrides {
  readonly artifactsDirectory?: string;
  readonly policiesDirectory?: string;
  readonly evidenceDirectory?: string;
}

function resolveRepositoryPath(value: string | undefined, fallback: string): string {
  return path.resolve(automationRoot, value ?? fallback);
}

export function getRepositoryPaths(overrides: PathOverrides = {}): RepositoryPaths {
  return Object.freeze({
    repositoryRoot,
    automationRoot,
    artifactsDirectory: resolveRepositoryPath(overrides.artifactsDirectory, '../artifacts'),
    policiesDirectory: resolveRepositoryPath(overrides.policiesDirectory, '../policies'),
    evidenceDirectory: resolveRepositoryPath(overrides.evidenceDirectory, '../evidence'),
  });
}
