import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createLogger } from './logger.js';

describe('logger redaction', () => {
  it('redacts common secret-bearing fields', () => {
    const output = new PassThrough();
    let serialized = '';
    output.on('data', (chunk: Buffer) => {
      serialized += chunk.toString();
    });
    const logger = createLogger({ level: 'info', destination: output });
    logger.info(
      {
        password: 'canary-password',
        apiKey: 'canary-api-key',
        authorization: 'Bearer canary-token',
        cookies: 'canary-cookie',
        token: 'canary-token',
      },
      'test event',
    );
    expect(serialized).not.toContain('canary-password');
    expect(serialized).not.toContain('canary-api-key');
    expect(serialized).not.toContain('canary-token');
    expect(serialized).not.toContain('canary-cookie');
    expect(serialized).toContain('[REDACTED]');
  });
});
