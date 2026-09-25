import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadEnvironment } from '../src/config/env.js';
import { getRepositoryPaths } from '../src/config/paths.js';

describe('automation scaffold', () => {
  it('identifies stable repository directories', () => {
    const environment = loadEnvironment();
    const paths = getRepositoryPaths();
    expect(path.isAbsolute(paths.repositoryRoot)).toBe(true);
    expect(paths.automationRoot).toContain(`${path.sep}automation`);
    expect(environment.paths.artifactsDirectory).toBe(paths.artifactsDirectory);
    expect(environment.paths.policiesDirectory).toBe(paths.policiesDirectory);
    expect(environment.paths.evidenceDirectory).toBe(paths.evidenceDirectory);
  });
});
