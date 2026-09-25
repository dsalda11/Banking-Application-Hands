import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { CapabilityArtifactType } from '../domain/index.js';
import { loadArtifact, type LoadedArtifact } from './artifact-loader.js';

export class ArtifactRegistryError extends Error {
  constructor(
    readonly code: 'DUPLICATE_ARTIFACT' | 'ARTIFACT_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactRegistryError';
  }
}

export class ArtifactRegistry {
  private readonly artifacts = new Map<string, LoadedArtifact>();

  constructor(readonly rootDirectory: string) {}

  async discover(): Promise<readonly LoadedArtifact[]> {
    const entries = (await readdir(this.rootDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
    for (const entry of entries) {
      const loaded = await loadArtifact(path.join(this.rootDirectory, entry));
      const key = `${loaded.artifact.id}@${loaded.artifact.version}`;
      if (this.artifacts.has(key))
        throw new ArtifactRegistryError('DUPLICATE_ARTIFACT', `Duplicate artifact ${key}`);
      this.artifacts.set(key, loaded);
    }
    return [...this.artifacts.values()];
  }

  get(id: string, version: string): LoadedArtifact {
    const loaded = this.artifacts.get(`${id}@${version}`);
    if (!loaded)
      throw new ArtifactRegistryError(
        'ARTIFACT_NOT_FOUND',
        `Artifact ${id}@${version} was not found`,
      );
    return loaded;
  }

  list(): readonly CapabilityArtifactType[] {
    return [...this.artifacts.values()].map((entry) => entry.artifact);
  }
}
