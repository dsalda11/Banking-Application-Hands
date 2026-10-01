import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';
import { z } from 'zod';

import { CapabilityArtifact } from './artifact.js';
import { DiscoveryDecision, DiscoveryGoal } from './discovery.js';
import { DiscoveryEvent } from './events.js';
import { InterventionRequest } from './intervention.js';
import { RunResult } from './run-result.js';
import { ReplayPolicy } from './policy.js';

const schemaDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../schemas');
const definitions: readonly (readonly [string, z.ZodTypeAny])[] = [
  ['capability-artifact', CapabilityArtifact],
  ['discovery-decision', DiscoveryDecision],
  ['discovery-goal', DiscoveryGoal],
  ['discovery-event', DiscoveryEvent],
  ['intervention-request', InterventionRequest],
  ['run-result', RunResult],
  ['replay-policy', ReplayPolicy],
];

type JsonSchemaDocument = Record<string, unknown>;
const toJsonSchema = z.toJSONSchema as (
  schema: z.ZodTypeAny,
  params: Record<string, unknown>,
) => JsonSchemaDocument;

const strictObject = (
  required: readonly string[],
  properties: JsonSchemaDocument,
): JsonSchemaDocument => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties,
});

const stringSchema = (pattern?: string): JsonSchemaDocument => ({
  type: 'string',
  ...(pattern ? { pattern } : {}),
});

function reviewSchema(name: string, schema: z.ZodTypeAny): JsonSchemaDocument {
  const envelope = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://interface.ai/schemas/${name}.schema.json`,
    title: name,
  };
  if (name === 'capability-artifact') {
    return {
      ...envelope,
      ...strictObject(
        [
          'schemaVersion',
          'id',
          'version',
          'lifecycle',
          'name',
          'description',
          'target',
          'contract',
          'policyRef',
          'preconditions',
          'steps',
          'success',
          'metadata',
        ],
        {
          schemaVersion: { const: '1.0.0' },
          id: stringSchema(),
          version: stringSchema(
            '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$',
          ),
          lifecycle: { enum: ['draft', 'validated', 'approved', 'deprecated'] },
          name: stringSchema(),
          description: stringSchema(),
          target: {
            type: 'object',
            additionalProperties: false,
            required: ['surface', 'product', 'entryPoint', 'fingerprints'],
            properties: {
              surface: { enum: ['web', 'desktop'] },
              product: stringSchema(),
              entryPoint: { type: 'object' },
              fingerprints: { type: 'array', minItems: 1 },
            },
          },
          contract: {
            type: 'object',
            additionalProperties: false,
            required: ['inputs', 'requiredSecrets', 'outputs', 'businessOutcomes'],
            properties: {
              inputs: { type: 'object' },
              requiredSecrets: { type: 'array' },
              outputs: { type: 'object' },
              businessOutcomes: { type: 'array' },
            },
          },
          policyRef: stringSchema(),
          preconditions: { type: 'array' },
          steps: { type: 'array', minItems: 1, maxItems: 100 },
          success: { type: 'object' },
          metadata: {
            type: 'object',
            additionalProperties: false,
            required: ['createdAt', 'provenance'],
            properties: {
              createdAt: { type: 'string', format: 'date-time' },
              provenance: { type: 'object' },
              compilerVersion: { type: 'string' },
              checksum: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            },
          },
        },
      ),
    };
  }
  if (name === 'discovery-decision') {
    return toJsonSchema(schema, {
      target: 'draft-2020-12',
      io: 'input',
      cycles: 'ref',
      reused: 'ref',
    });
  }
  return {
    ...envelope,
    ...strictObject(
      ['schemaVersion', 'eventId', 'runId', 'sequence', 'timestamp', 'eventType', 'payload'],
      {
        schemaVersion: { const: '1.0.0' },
        eventId: stringSchema(),
        runId: stringSchema(),
        sequence: { type: 'integer', minimum: 0 },
        timestamp: { type: 'string', format: 'date-time' },
        eventType: stringSchema(),
        payload: { type: 'object' },
      },
    ),
  };
}

async function schemaFor(name: string, schema: z.ZodTypeAny): Promise<string> {
  // Zod's emitter expands recursive discriminated unions aggressively. The runtime Zod schemas remain authoritative;
  // these stable review projections keep the checked-in documents finite and machine-readable.
  const document =
    name === 'intervention-request' ||
    name === 'run-result' ||
    name === 'replay-policy' ||
    name === 'discovery-goal'
      ? toJsonSchema(schema, { target: 'draft-2020-12', io: 'input', cycles: 'ref', reused: 'ref' })
      : reviewSchema(name, schema);
  return prettier.format(JSON.stringify(document), { parser: 'json', printWidth: 100 });
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  let drift = false;
  for (const [name, schema] of definitions) {
    const file = path.join(schemaDirectory, `${name}.schema.json`);
    const generated = await schemaFor(name, schema);
    if (check) {
      let existing: string;
      try {
        existing = await readFile(file, 'utf8');
      } catch {
        drift = true;
        continue;
      }
      if (existing !== generated) {
        console.error(`Schema drift: ${path.relative(process.cwd(), file)}`);
        drift = true;
      }
    } else {
      await writeFile(file, generated, 'utf8');
    }
  }
  if (drift) process.exitCode = 1;
}

await main();
