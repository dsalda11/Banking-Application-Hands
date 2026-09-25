import { describe, expect, it } from 'vitest';
import { applyTransform, TransformError } from '../../src/execution/apply-transform.js';

describe('closed extraction transforms', () => {
  it('handles text and normalized decimal values without floating point', () => {
    expect(applyTransform({ kind: 'trim' }, '  value  ')).toBe('value');
    expect(applyTransform({ kind: 'normalizeWhitespace' }, ' a  b\n c ')).toBe('a b c');
    expect(applyTransform({ kind: 'parseIntegerString' }, '31444')).toBe(31444);
    expect(applyTransform({ kind: 'parseDecimalString' }, '31,444.00')).toBe('31444.00');
    expect(applyTransform({ kind: 'amountWithCurrency', currency: 'USD' }, '$31,444')).toEqual({
      amount: '31444',
      currency: 'USD',
    });
  });
  it('rejects malformed numeric values', () => {
    expect(() => applyTransform({ kind: 'parseIntegerString' }, '1.2')).toThrow(TransformError);
    expect(() =>
      applyTransform({ kind: 'amountWithCurrency', currency: 'USD' }, 'unknown'),
    ).toThrow(TransformError);
  });
});
