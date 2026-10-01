import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DiscoveryGoal, type DiscoveryGoalType } from '../domain/discovery.js';

export interface LoadedDiscoveryGoal {
  readonly goal: DiscoveryGoalType;
  readonly contentHash: string;
  readonly path: string;
}

export class DiscoveryGoalLoadError extends Error {
  constructor(
    readonly code: 'GOAL_READ_FAILED' | 'GOAL_MALFORMED_JSON' | 'GOAL_SCHEMA_INVALID',
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'DiscoveryGoalLoadError';
  }
}

export async function loadDiscoveryGoal(filePath: string): Promise<LoadedDiscoveryGoal> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error: unknown) {
    throw new DiscoveryGoalLoadError('GOAL_READ_FAILED', 'Could not read discovery goal', error);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new DiscoveryGoalLoadError('GOAL_MALFORMED_JSON', 'Discovery goal is not JSON', error);
  }
  const parsed = DiscoveryGoal.safeParse(raw);
  if (!parsed.success)
    throw new DiscoveryGoalLoadError('GOAL_SCHEMA_INVALID', 'Discovery goal failed validation');
  const start = new URL(parsed.data.startUrl);
  if (!parsed.data.applicationScope.allowedOrigins.includes(start.origin))
    throw new DiscoveryGoalLoadError('GOAL_SCHEMA_INVALID', 'Goal start URL is outside scope');
  return {
    goal: parsed.data,
    contentHash: createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex'),
    path: filePath,
  };
}
