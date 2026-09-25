import { describe, expect, it } from 'vitest';
import {
  resolveStringValue,
  resolveValue,
  ValueResolutionError,
} from '../../src/execution/resolve-value.js';

const context = {
  inputs: { customerUsername: 'customer' },
  secrets: { STAFF: 'secret' },
  outputs: {},
  baseUrl: 'http://127.0.0.1:8080',
  runId: 'run-1',
};

describe('runtime value resolution', () => {
  it('keeps input, secret, and literal sources separate', () => {
    expect(resolveStringValue({ kind: 'input', name: 'customerUsername' }, context)).toBe(
      'customer',
    );
    expect(resolveStringValue({ kind: 'secret', name: 'STAFF' }, context)).toBe('secret');
    expect(resolveValue({ kind: 'literal', value: 'literal' }, context)).toBe('literal');
  });
  it('reports missing references without values', () => {
    expect(() => resolveValue({ kind: 'input', name: 'missing' }, context)).toThrowError(
      new ValueResolutionError('INPUT_VALUE_MISSING', 'missing'),
    );
    expect(() => resolveValue({ kind: 'secret', name: 'missing' }, context)).toThrowError(
      new ValueResolutionError('SECRET_VALUE_MISSING', 'missing'),
    );
  });
});
