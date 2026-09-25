import type { ValueSourceType } from '../domain/values.js';
import type { ExecutionContext } from './execution-context.js';

export class ValueResolutionError extends Error {
  constructor(
    readonly code: 'INPUT_VALUE_MISSING' | 'SECRET_VALUE_MISSING',
    name: string,
  ) {
    super(`${code}: ${name}`);
    this.name = 'ValueResolutionError';
  }
}

export function resolveValue(source: ValueSourceType, context: ExecutionContext): unknown {
  if (source.kind === 'literal') return source.value;
  if (source.kind === 'input') {
    if (!(source.name in context.inputs))
      throw new ValueResolutionError('INPUT_VALUE_MISSING', source.name);
    return context.inputs[source.name];
  }
  if (!(source.name in context.secrets))
    throw new ValueResolutionError('SECRET_VALUE_MISSING', source.name);
  return context.secrets[source.name];
}

export function resolveStringValue(source: ValueSourceType, context: ExecutionContext): string {
  const value = resolveValue(source, context);
  if (typeof value !== 'string' || value.length === 0)
    throw new Error('Resolved value is not a non-empty string');
  return value;
}
