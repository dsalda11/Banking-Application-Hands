import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { ReplayPolicy, type ReplayPolicyType } from '../domain/policy.js';

export class PolicyLoadError extends Error {
  constructor(
    readonly code:
      | 'POLICY_READ_FAILED'
      | 'POLICY_MALFORMED_JSON'
      | 'POLICY_SCHEMA_INVALID'
      | 'UNSUPPORTED_POLICY_VERSION'
      | 'POLICY_PATTERN_INVALID',
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'PolicyLoadError';
  }
}

export interface LoadedPolicy {
  readonly policy: ReplayPolicyType;
  readonly contentHash: string;
  readonly path: string;
}

export async function loadPolicy(filePath: string): Promise<LoadedPolicy> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error: unknown) {
    throw new PolicyLoadError('POLICY_READ_FAILED', 'Could not read replay policy', error);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new PolicyLoadError('POLICY_MALFORMED_JSON', 'Replay policy is not valid JSON', error);
  }
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'schemaVersion' in raw &&
    raw.schemaVersion !== '1.0.0'
  )
    throw new PolicyLoadError('UNSUPPORTED_POLICY_VERSION', 'Unsupported replay policy version');
  const parsed = ReplayPolicy.safeParse(raw);
  if (!parsed.success)
    throw new PolicyLoadError('POLICY_SCHEMA_INVALID', 'Replay policy does not match its schema');
  for (const route of parsed.data.allowedRoutes) {
    try {
      new RegExp(route.pattern);
    } catch (error: unknown) {
      throw new PolicyLoadError(
        'POLICY_PATTERN_INVALID',
        `Invalid policy route pattern ${route.id}`,
        error,
      );
    }
  }
  const contentHash = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex');
  return { policy: parsed.data, contentHash, path: filePath };
}

export class PolicyRegistryError extends Error {
  constructor(
    readonly code: 'DUPLICATE_POLICY' | 'POLICY_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'PolicyRegistryError';
  }
}

export class PolicyRegistry {
  private readonly policies = new Map<string, LoadedPolicy>();
  constructor(readonly rootDirectory: string) {}

  async discover(): Promise<readonly LoadedPolicy[]> {
    const entries = (await readdir(this.rootDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
    for (const entry of entries) {
      const loaded = await loadPolicy(path.join(this.rootDirectory, entry));
      const key = `${loaded.policy.id}@${loaded.policy.version}`;
      if (this.policies.has(key))
        throw new PolicyRegistryError('DUPLICATE_POLICY', `Duplicate policy ${key}`);
      this.policies.set(key, loaded);
    }
    return [...this.policies.values()];
  }

  get(id: string, version: string): LoadedPolicy {
    const loaded = this.policies.get(`${id}@${version}`);
    if (!loaded)
      throw new PolicyRegistryError('POLICY_NOT_FOUND', `Policy ${id}@${version} was not found`);
    return loaded;
  }
}
