import type { TransformType } from '../domain/actions.js';

export class TransformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransformError';
  }
}

export function applyTransform(transform: TransformType, input: string): unknown {
  switch (transform.kind) {
    case 'identity':
      return input;
    case 'trim':
      return input.trim();
    case 'normalizeWhitespace':
      return input.trim().replace(/\s+/g, ' ');
    case 'parseIntegerString': {
      const value = input.trim();
      if (!/^[+-]?\d+$/.test(value)) throw new TransformError('Expected an integer string');
      return Number.parseInt(value, 10);
    }
    case 'parseDecimalString': {
      const value = input.trim().replace(/,/g, '');
      if (!/^[+-]?\d+(?:\.\d+)?$/.test(value))
        throw new TransformError('Expected a decimal string');
      const [whole, fraction] = value.split('.');
      return fraction ? `${whole}.${fraction}` : `${whole}`;
    }
    case 'amountWithCurrency': {
      const value = input
        .trim()
        .replace(/^\$\s*/, '')
        .replace(/,/g, '');
      if (!/^[+-]?\d+(?:\.\d+)?$/.test(value)) throw new TransformError('Expected a USD amount');
      return { amount: value, currency: transform.currency };
    }
  }
}
