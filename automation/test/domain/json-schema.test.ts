import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CapabilityArtifact } from '../../src/domain/artifact.js';
import { DiscoveryDecision } from '../../src/domain/discovery.js';
import { DiscoveryEvent } from '../../src/domain/events.js';
import { InterventionRequest } from '../../src/domain/intervention.js';
import { RunResult } from '../../src/domain/run-result.js';
import { parsedFixture } from './helpers.js';

const schemaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../schemas');

describe('generated JSON Schemas', () => {
  it('has all checked-in schema documents and the fixture remains runtime-valid', () => {
    for (const name of [
      'capability-artifact',
      'discovery-decision',
      'discovery-goal',
      'discovery-event',
      'intervention-request',
      'run-result',
    ]) {
      const document = JSON.parse(
        readFileSync(path.join(schemaRoot, `${name}.schema.json`), 'utf8'),
      ) as Record<string, unknown>;
      expect(document.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    }
    expect(CapabilityArtifact.parse(parsedFixture()).lifecycle).toBe('draft');
    expect(DiscoveryDecision).toBeDefined();
    expect(DiscoveryEvent).toBeDefined();
    expect(InterventionRequest).toBeDefined();
    expect(RunResult).toBeDefined();
  });
});
